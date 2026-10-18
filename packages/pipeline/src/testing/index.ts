import { mkdtemp, readFile, rm, writeFile, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { MemoryCacheStore } from '../cache';
import type { JobFiles, MediaOps, StageContext, StageEvent } from '../context';
import { AiLedger, type PriceLookup } from '../ledger';
import type {
  AlignProvider,
  CharacterAlignment,
  ProviderCallResult,
  SearchProvider,
  SearchResult,
  SynthesizedSpeech,
  TextProvider,
  TextRequest,
  TimedWord,
  VisionProvider,
  VoiceProvider,
} from '../roles';
import type {
  FetchedPage,
  ImageCandidate,
  ImageQuery,
  ImageSource,
  PageFetcher,
} from '../services';

const approxTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

type Reply<Req> = string | Error | ((request: Req) => string);

const take = <Req>(queue: Array<Reply<Req>>, request: Req, who: string): string => {
  const next = queue.shift();
  if (next === undefined) throw new Error(`${who}: no scripted reply left`);
  if (next instanceof Error) throw next;
  return typeof next === 'function' ? next(request) : next;
};

/** Text model that replays scripted replies and records every request. */
export class FakeTextProvider implements TextProvider {
  readonly providerId: string;
  readonly model: string;
  readonly requests: TextRequest[] = [];
  constructor(
    private readonly replies: Array<Reply<TextRequest>>,
    opts: { providerId?: string; model?: string } = {},
  ) {
    this.providerId = opts.providerId ?? 'fake-text';
    this.model = opts.model ?? 'fake-text-1';
  }
  async complete(request: TextRequest): Promise<ProviderCallResult<string>> {
    this.requests.push(structuredClone(request));
    const value = take(this.replies, request, 'FakeTextProvider');
    const prompt = [request.system ?? '', ...request.messages.map((m) => m.content)].join('\n');
    return {
      value,
      usage: { inputTokens: approxTokens(prompt), outputTokens: approxTokens(value) },
      model: this.model,
    };
  }
}

export class FakeSearchProvider implements SearchProvider {
  readonly providerId: string;
  readonly model: string | null;
  readonly usesModel: boolean;
  readonly queries: string[] = [];
  constructor(
    private readonly results: SearchResult[] | ((query: string) => SearchResult[]),
    opts: { usesModel?: boolean; providerId?: string } = {},
  ) {
    this.usesModel = opts.usesModel ?? false;
    this.providerId = opts.providerId ?? (this.usesModel ? 'fake-model-search' : 'fake-search');
    this.model = this.usesModel ? 'fake-search-model' : null;
  }
  async search(request: {
    query: string;
    maxResults: number;
  }): Promise<ProviderCallResult<SearchResult[]>> {
    this.queries.push(request.query);
    const list = typeof this.results === 'function' ? this.results(request.query) : this.results;
    return {
      value: list.slice(0, request.maxResults),
      usage: { searches: 1 },
      model: this.model ?? 'none',
    };
  }
}

/* ------------------------------------------------------------------ audio */

/** 16-bit mono PCM WAV of the given samples. */
export const encodeTestWav = (durationMs: number, sampleRate = 8000): Uint8Array => {
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(buffer);
};

export const wavDurationMs = (data: Uint8Array): number => {
  const b = Buffer.from(data);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a wav file');
  const byteRate = b.readUInt32LE(28);
  const dataBytes = b.readUInt32LE(40);
  return Math.round((dataBytes / byteRate) * 1000);
};

/** Character timings at a fixed rate, the way ElevenLabs reports them. */
export const fakeAlignment = (text: string, msPerChar: number): CharacterAlignment => {
  const characters = [...text];
  return {
    characters,
    startTimesSeconds: characters.map((_, i) => (i * msPerChar) / 1000),
    endTimesSeconds: characters.map((_, i) => ((i + 1) * msPerChar) / 1000),
  };
};

export class FakeVoiceProvider implements VoiceProvider {
  readonly providerId: string;
  readonly model = 'fake-voice-1';
  readonly voiceId = 'narrator';
  readonly returnsTimings: boolean;
  readonly texts: string[] = [];
  constructor(
    opts: { returnsTimings?: boolean; msPerChar?: number; providerId?: string; fail?: Error } = {},
  ) {
    this.returnsTimings = opts.returnsTimings ?? true;
    this.providerId = opts.providerId ?? 'fake-voice';
    this.msPerChar = opts.msPerChar ?? 60;
    this.fail = opts.fail;
  }
  private readonly msPerChar: number;
  private readonly fail: Error | undefined;
  async synthesize(request: { text: string }): Promise<ProviderCallResult<SynthesizedSpeech>> {
    if (this.fail) throw this.fail;
    this.texts.push(request.text);
    const durationMs = [...request.text].length * this.msPerChar;
    return {
      value: {
        audio: encodeTestWav(durationMs),
        format: 'wav',
        alignment: this.returnsTimings ? fakeAlignment(request.text, this.msPerChar) : null,
      },
      usage: { characters: request.text.length },
      model: this.model,
    };
  }
}

export class FakeAlignProvider implements AlignProvider {
  readonly providerId = 'fake-align';
  readonly model = 'fake-whisper';
  readonly calls: string[] = [];
  constructor(
    private readonly transcribe: (audioPath: string) => TimedWord[] | Promise<TimedWord[]>,
  ) {}
  async align(request: { audioPath: string }): Promise<ProviderCallResult<TimedWord[]>> {
    this.calls.push(request.audioPath);
    const words = await this.transcribe(request.audioPath);
    return {
      value: words,
      usage: { audioSeconds: (words.at(-1)?.endMs ?? 0) / 1000 },
      model: this.model,
    };
  }
}

export class FakeVisionProvider implements VisionProvider {
  readonly providerId = 'fake-vision';
  readonly model = 'fake-vision-1';
  readonly prompts: string[] = [];
  readonly imageCounts: number[] = [];
  constructor(private readonly replies: Array<Reply<{ prompt: string }>>) {}
  async describe(request: {
    prompt: string;
    images: { data: Uint8Array }[];
    maxOutputTokens: number;
  }): Promise<ProviderCallResult<string>> {
    this.prompts.push(request.prompt);
    this.imageCounts.push(request.images.length);
    const value = take(this.replies, { prompt: request.prompt }, 'FakeVisionProvider');
    return {
      value,
      usage: {
        inputTokens: approxTokens(request.prompt) + 500 * request.images.length,
        outputTokens: approxTokens(value),
        images: request.images.length,
      },
      model: this.model,
    };
  }
}

/* --------------------------------------------------------------- services */

export class FakePageFetcher implements PageFetcher {
  readonly fetched: string[] = [];
  constructor(private readonly pages: Record<string, Omit<FetchedPage, 'url'> | Error>) {}
  async fetchPage(url: string): Promise<FetchedPage> {
    this.fetched.push(url);
    const page = this.pages[url];
    if (!page) throw new Error(`404 ${url}`);
    if (page instanceof Error) throw page;
    return { url, ...page };
  }
}

export class FakeImageSource implements ImageSource {
  readonly id = 'fake-images';
  readonly queries: ImageQuery[] = [];
  constructor(private readonly byQuery: (query: ImageQuery) => ImageCandidate[]) {}
  async search(query: ImageQuery): Promise<ImageCandidate[]> {
    this.queries.push(query);
    return this.byQuery(query);
  }
}

export const candidate = (
  patch: Partial<ImageCandidate> & Pick<ImageCandidate, 'id' | 'title'>,
): ImageCandidate => ({
  provider: 'openverse',
  url: `https://images.example.org/${patch.id}.jpg`,
  thumbnailUrl: `https://images.example.org/${patch.id}-thumb.jpg`,
  tags: [],
  width: 1920,
  height: 1080,
  license: 'by',
  licenseVersion: '4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  creator: 'Someone',
  sourceUrl: `https://example.org/photo/${patch.id}`,
  ...patch,
});

/* ------------------------------------------------------------ files/media */

/** A real temp folder per test, so stages can be exercised end to end. */
export const tempJobFiles = async (): Promise<
  JobFiles & { dir: string; cacheDir: string; cleanup(): Promise<void> }
> => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-job-'));
  const cacheDir = await mkdtemp(join(tmpdir(), 'vc-cache-'));
  return {
    dir,
    cacheDir,
    pathFor(name) {
      return join(dir, name);
    },
    async write(name, data) {
      const path = join(dir, name);
      await writeFile(path, data);
      return path;
    },
    async read(path) {
      return new Uint8Array(await readFile(path));
    },
    async copyIn(sourcePath, name) {
      const path = join(dir, name || basename(sourcePath));
      await copyFile(sourcePath, path);
      return path;
    },
    async writeCache(name, data) {
      const path = join(cacheDir, name);
      await writeFile(path, data);
      return path;
    },
    async exists(path) {
      return access(path).then(
        () => true,
        () => false,
      );
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
};

/** MediaOps for WAV-only test audio, without ffmpeg. */
export const wavMediaOps = (): MediaOps & { concatCalls: string[][] } => {
  const concatCalls: string[][] = [];
  return {
    concatCalls,
    async durationMs(path) {
      return wavDurationMs(new Uint8Array(await readFile(path)));
    },
    async toWav(input, output) {
      await copyFile(input, output);
    },
    async toSpeechWav(input, output) {
      await copyFile(input, output);
    },
    async concatAudio(inputs, output) {
      concatCalls.push([...inputs]);
      const total = (
        await Promise.all(inputs.map(async (p) => wavDurationMs(new Uint8Array(await readFile(p)))))
      ).reduce((a, b) => a + b, 0);
      await writeFile(output, encodeTestWav(total));
    },
  };
};

export const freePrices: PriceLookup = () => ({});
export const testPrices: PriceLookup = (providerId) =>
  providerId.startsWith('fake')
    ? {
        inputPerMTok: 1,
        outputPerMTok: 4,
        perSearch: 0.005,
        perMChars: 30,
        perAudioMinute: 0.006,
        perImage: 0.002,
      }
    : null;

export const testContext = async (
  opts: { capUsd?: number; maxCalls?: number; prices?: PriceLookup; now?: () => Date } = {},
) => {
  const files = await tempJobFiles();
  const events: StageEvent[] = [];
  const ledger = new AiLedger({
    jobId: 'job-test',
    capUsd: opts.capUsd ?? 5,
    maxCalls: opts.maxCalls ?? 200,
    prices: opts.prices ?? testPrices,
    now: opts.now,
  });
  const cache = new MemoryCacheStore();
  const ctx: StageContext = {
    jobId: 'job-test',
    ledger,
    cache,
    files,
    log: (e) => events.push(e),
    now: opts.now ?? (() => new Date('2026-10-18T12:00:00Z')),
  };
  return { ctx, files, ledger, cache, events };
};
