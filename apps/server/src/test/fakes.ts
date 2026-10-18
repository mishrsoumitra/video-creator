import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScenePlan, VideoConfig } from '@vc/config';
import {
  ProviderError,
  type AlignProvider,
  type ProviderCallResult,
  type SearchProvider,
  type TextProvider,
  type TextRequest,
  type VisionProvider,
} from '@vc/pipeline';
import {
  FakeImageSource,
  FakePageFetcher,
  FakeVoiceProvider,
  candidate,
  encodeTestWav,
  wavDurationMs,
  wavMediaOps,
} from '@vc/pipeline/testing';
import type { AdapterContext, ProviderDefinition } from '@vc/providers';
import { MemoryVault, VaultLockedError } from '@vc/secrets';
import { z } from 'zod';
import type {
  FontCatalog,
  MusicLibrary,
  ProviderRegistry,
  Renderer,
  ServerMedia,
} from '../services';

export const ACME_KEY = 'sk-acme-test-key-0000000000001234';
export const LABS_KEY = 'labs-test-key-0000000000005678';

const checkKey = (providerId: string, apiKey: string | null, expected: string) => {
  if (apiKey !== expected)
    throw new ProviderError({
      providerId,
      code: 'auth',
      status: 401,
      message: 'Incorrect API key provided.',
    });
};

/** A text model that answers whatever the pipeline asks: fact sheets, scripts, and test pings. */
export class ScriptedText implements TextProvider {
  readonly requests: TextRequest[] = [];
  gate: Promise<void> | null = null;
  constructor(
    readonly providerId: string,
    readonly model: string,
    private readonly apiKey: string | null,
    private readonly expectedKey: string | null,
  ) {}
  async complete(request: TextRequest): Promise<ProviderCallResult<string>> {
    if (this.expectedKey) checkKey(this.providerId, this.apiKey, this.expectedKey);
    if (this.gate) await this.gate;
    this.requests.push(request);
    const system = request.system ?? '';
    let value = 'OK';
    const scenes = /exactly (\d+) scenes/.exec(system);
    if (scenes) {
      value = JSON.stringify({
        title: 'One giant leap',
        scenes: Array.from({ length: Number(scenes[1]) }, (_, i) => ({
          narration: `Scene ${i + 1} tells the Apollo story.`,
          imageQuery: `saturn v rocket launch ${i + 1}`,
          keywords: ['apollo'],
        })),
      });
    } else if (/build a fact sheet/i.test(system)) {
      value = JSON.stringify({
        facts: [
          {
            text: 'Apollo 11 landed on July 20, 1969.',
            sourceId: 'S1',
            quote: 'Apollo 11 landed on July 20, 1969.',
          },
          {
            text: 'Twelve astronauts walked on the Moon.',
            sourceId: 'S1',
            quote: 'Twelve astronauts walked on the Moon.',
          },
        ],
      });
    }
    return {
      value,
      usage: { inputTokens: 200, outputTokens: 80 },
      model: `${this.model}-2026-10-01`,
    };
  }
}

class ScriptedSearch implements SearchProvider {
  readonly usesModel = true;
  constructor(
    readonly providerId: string,
    readonly model: string,
    private readonly apiKey: string | null,
  ) {}
  async search(): Promise<ProviderCallResult<Array<{ url: string; title: string }>>> {
    checkKey(this.providerId, this.apiKey, ACME_KEY);
    return {
      value: [{ url: 'https://example.org/apollo', title: 'Apollo' }],
      usage: { searches: 1, inputTokens: 100, outputTokens: 20 },
      model: this.model,
    };
  }
}

class ScriptedAlign implements AlignProvider {
  constructor(
    readonly providerId: string,
    readonly model: string,
    private readonly apiKey: string | null,
    private readonly expectedKey: string | null,
  ) {}
  async align(): Promise<
    ProviderCallResult<Array<{ text: string; startMs: number; endMs: number }>>
  > {
    if (this.expectedKey) checkKey(this.providerId, this.apiKey, this.expectedKey);
    return {
      value: [{ text: 'scene', startMs: 0, endMs: 300 }],
      usage: { audioSeconds: 1 },
      model: this.model,
    };
  }
}

class ScriptedVision implements VisionProvider {
  constructor(
    readonly providerId: string,
    readonly model: string,
    private readonly apiKey: string | null,
  ) {}
  async describe(): Promise<ProviderCallResult<string>> {
    checkKey(this.providerId, this.apiKey, ACME_KEY);
    return {
      value: JSON.stringify({ ratings: [{ index: 1, score: 8 }], issues: [] }),
      usage: { images: 1, inputTokens: 300, outputTokens: 20 },
      model: this.model,
    };
  }
}

const anyOptions = z.record(z.string(), z.unknown());
const free = () => ({});

export const texts: ScriptedText[] = [];

const acme: ProviderDefinition = {
  id: 'acme',
  label: 'Acme AI',
  kind: 'cloud',
  description: 'A test provider that can fill every role.',
  credential: {
    id: 'acme',
    label: 'Acme API key',
    helpUrl: 'https://acme.example/keys',
    hint: /^sk-/,
  },
  allowedHosts: () => ['api.acme.example'],
  roles: {
    text: {
      role: 'text',
      label: 'Acme chat',
      defaultModel: 'acme-text-1',
      suggestedModels: ['acme-text-1', 'acme-text-mini'],
      optionsSchema: anyOptions,
      pricing: () => ({ inputPerMTok: 1, outputPerMTok: 2 }),
      create: (ctx: AdapterContext) => {
        const t = new ScriptedText('acme', ctx.model, ctx.apiKey, ACME_KEY);
        texts.push(t);
        return t;
      },
    },
    search: {
      role: 'search',
      label: 'Acme web search',
      defaultModel: 'acme-text-1',
      suggestedModels: [],
      optionsSchema: anyOptions,
      pricing: () => ({ perSearch: 0.01, inputPerMTok: 1, outputPerMTok: 2 }),
      create: (ctx) => new ScriptedSearch('acme', ctx.model, ctx.apiKey),
    },
    voice: {
      role: 'voice',
      label: 'Acme speech',
      defaultModel: 'acme-tts',
      suggestedModels: [],
      optionsSchema: anyOptions,
      pricing: () => ({ perMChars: 15 }),
      create: (ctx) => {
        const v = new FakeVoiceProvider({
          returnsTimings: false,
          providerId: 'acme',
          msPerChar: 50,
        });
        const synthesize = v.synthesize.bind(v);
        v.synthesize = async (req) => {
          checkKey('acme', ctx.apiKey, ACME_KEY);
          return synthesize(req);
        };
        return v;
      },
    },
    align: {
      role: 'align',
      label: 'Acme transcription',
      defaultModel: 'acme-whisper',
      suggestedModels: [],
      optionsSchema: anyOptions,
      validateModel: (m) => (m.includes('transcribe') ? `${m} has no word timestamps.` : null),
      pricing: () => ({ perAudioMinute: 0.006 }),
      create: (ctx) => new ScriptedAlign('acme', ctx.model, ctx.apiKey, ACME_KEY),
    },
    vision: {
      role: 'vision',
      label: 'Acme vision',
      defaultModel: 'acme-text-1',
      suggestedModels: [],
      optionsSchema: anyOptions,
      pricing: () => ({ inputPerMTok: 1, outputPerMTok: 2, perImage: 0.001 }),
      create: (ctx) => new ScriptedVision('acme', ctx.model, ctx.apiKey),
    },
  },
};

const labs: ProviderDefinition = {
  id: 'labs',
  label: 'Labs Voice',
  kind: 'cloud',
  description: 'A test voice that returns word timings in the same call.',
  credential: { id: 'labs', label: 'Labs API key', helpUrl: 'https://labs.example/keys' },
  allowedHosts: () => ['api.labs.example'],
  roles: {
    voice: {
      role: 'voice',
      label: 'Labs TTS with timestamps',
      defaultModel: 'labs-v2',
      suggestedModels: [],
      optionsSchema: anyOptions,
      pricing: () => ({ perMChars: 80 }),
      create: (ctx) => {
        const v = new FakeVoiceProvider({
          returnsTimings: true,
          providerId: 'labs',
          msPerChar: 50,
        });
        const synthesize = v.synthesize.bind(v);
        v.synthesize = async (req) => {
          checkKey('labs', ctx.apiKey, LABS_KEY);
          return synthesize(req);
        };
        return v;
      },
    },
  },
};

const local: ProviderDefinition = {
  id: 'localai',
  label: 'Local AI',
  kind: 'local',
  description: 'A test local server that needs no key.',
  credential: null,
  allowedHosts: () => ['localhost'],
  roles: {
    text: {
      role: 'text',
      label: 'Local chat',
      defaultModel: 'llama-test',
      suggestedModels: [],
      optionsSchema: anyOptions,
      pricing: free,
      create: (ctx) => new ScriptedText('localai', ctx.model, null, null),
    },
    align: {
      role: 'align',
      label: 'Local whisper',
      defaultModel: 'base.en',
      suggestedModels: [],
      optionsSchema: anyOptions,
      pricing: free,
      create: (ctx) => new ScriptedAlign('localai', ctx.model, null, null),
    },
  },
};

export const FAKE_PROVIDERS: ProviderDefinition[] = [acme, labs, local];

export const fakeRegistry = (): ProviderRegistry => ({
  list: () => FAKE_PROVIDERS,
  get: (id) => FAKE_PROVIDERS.find((p) => p.id === id),
  create: (input) => {
    const def = FAKE_PROVIDERS.find((p) => p.id === input.providerId);
    const adapter = def?.roles[input.role];
    if (!def || !adapter)
      throw new ProviderError({
        providerId: input.providerId,
        code: 'unsupported',
        message: `${input.providerId} cannot fill ${input.role}.`,
      });
    const model = input.model?.trim() || adapter.defaultModel;
    const modelError = adapter.validateModel?.(model) ?? null;
    if (modelError)
      throw new ProviderError({ providerId: def.id, code: 'bad_request', message: modelError });
    if (def.credential && !def.credential.optional && !input.apiKey) {
      throw new ProviderError({
        providerId: def.id,
        code: 'auth',
        message: `No ${def.credential.label} is stored.`,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (adapter as any).create({
      apiKey: input.apiKey,
      model,
      options: input.options ?? {},
      fetch,
      dataDir: input.dataDir,
      media: input.media,
    });
  },
});

/** "FAKEVIDEO:<ms>" files stand in for rendered videos. */
const fakeVideoMs = async (path: string): Promise<number | null> => {
  const text = (await readFile(path)).subarray(0, 32).toString('latin1');
  return text.startsWith('FAKEVIDEO:') ? Number(text.slice(10)) : null;
};

export class FakeRenderer implements Renderer {
  readonly calls: Array<{ plan: ScenePlan; config: VideoConfig }> = [];
  failWith: Error | null = null;
  gate: Promise<void> | null = null;
  /** Renders that reached the renderer (including ones still held by the gate). */
  started = 0;
  async render({
    plan,
    config,
    outputPath,
    onProgress,
    signal,
  }: Parameters<Renderer['render']>[0]) {
    this.started++;
    if (this.gate) await this.gate;
    if (signal?.aborted) throw new Error('Render cancelled');
    if (this.failWith) throw this.failWith;
    this.calls.push({ plan, config });
    onProgress?.(0.5);
    await writeFile(
      outputPath,
      `FAKEVIDEO:${Math.ceil((plan.durationMs * config.output.fps) / 1000) * (1000 / config.output.fps)}`,
    );
    onProgress?.(1);
    return { elapsedMs: 1500, captionOverflows: [] };
  }
}

export const fakeMedia = (): ServerMedia => {
  const pipeline = wavMediaOps();
  return {
    async probeDurationMs(path) {
      const video = await fakeVideoMs(path);
      if (video !== null) return video;
      return wavDurationMs(new Uint8Array(await readFile(path)));
    },
    async assertAudio(path) {
      try {
        return { durationMs: wavDurationMs(new Uint8Array(await readFile(path))) };
      } catch {
        throw new Error('That file is not audio ffmpeg can read.');
      }
    },
    async mixAudio({ narrationPath, outputPath }) {
      await copyFile(narrationPath, outputPath);
      return { integratedLufs: -14, truePeakDb: -1.5 };
    },
    async mux({ videoPath, outputPath }) {
      await copyFile(videoPath, outputPath);
    },
    async measureClipping() {
      return { peakDbfs: -1.5, clippedSamples: 0, clipped: false };
    },
    async contactSheet() {
      return { data: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' };
    },
    pipeline,
    imageOps: (jobDir) => ({
      async download(c, name) {
        const path = join(jobDir, name);
        await writeFile(path, `IMAGE ${c.id}`);
        return { path, width: c.width ?? 1920, height: c.height ?? 1080 };
      },
      async thumbnail() {
        return { data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' };
      },
      async analyze() {
        return {
          subject: { x: 0.3, y: 0.2, w: 0.4, h: 0.4 },
          busyness: { top: 0.2, middle: 0.3, bottom: 0.1 },
        };
      },
      async palette() {
        return ['#101010', '#202020', '#E0A000', '#F0F0F0', '#3060F0'];
      },
    }),
    helpers: {
      toWav16kMono: async (input, output) => {
        await copyFile(input, output);
      },
      durationMs: async (path) => wavDurationMs(new Uint8Array(await readFile(path))),
    },
    async silentWav(path, durationMs) {
      await writeFile(path, encodeTestWav(durationMs));
    },
  };
};

export const fakeFonts = (): FontCatalog => ({
  families: async () => ['Inter', 'Playfair Display', 'Roboto'],
  info: async (family) =>
    ['Inter', 'Playfair Display', 'Roboto'].includes(family)
      ? { fontFamily: family, importName: family.replace(/\s/g, '') }
      : null,
});

export const fakeMusic = (dataDir: string): MusicLibrary => ({
  tracks: [
    { id: 'soft-pad', label: 'Soft pad', mood: 'calm' },
    { id: 'pulse', label: 'Pulse', mood: 'upbeat' },
    { id: 'drone', label: 'Drone', mood: 'dark' },
  ],
  async pathFor(trackId, durationMs) {
    const dir = join(dataDir, 'cache', 'music');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${trackId}-${durationMs}.wav`);
    await writeFile(path, encodeTestWav(durationMs));
    return path;
  },
});

export const fakeImageSource = () =>
  new FakeImageSource((q) => [
    candidate({
      id: `${q.query}-a`,
      title: `Apollo ${q.query}`,
      tags: ['nasa', 'rocket', 'launch'],
    }),
    candidate({ id: `${q.query}-b`, title: `Rocket ${q.query} photo`, tags: ['rocket'] }),
  ]);

export const fakePageFetcher = () =>
  new FakePageFetcher({
    'https://example.org/apollo': {
      title: 'Apollo',
      text: 'Apollo 11 landed on July 20, 1969. Twelve astronauts walked on the Moon. The Saturn V launched them.',
    },
  });

/** In-memory vault that can be locked, to exercise the locked-vault paths without scrypt. */
export class LockableVault extends MemoryVault {
  private locked = false;
  override isLocked(): boolean {
    return this.locked;
  }
  override lock(): void {
    this.locked = true;
  }
  override async unlock(): Promise<void> {
    this.locked = false;
  }
  override async get(id: string): Promise<string | null> {
    if (this.locked) throw new VaultLockedError();
    return super.get(id);
  }
  override async set(id: string, value: string): Promise<void> {
    if (this.locked) throw new VaultLockedError();
    return super.set(id, value);
  }
}
