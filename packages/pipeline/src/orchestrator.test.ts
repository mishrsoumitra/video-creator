import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ScenePlanSchema, SCHEMA_DEFAULTS, mergeConfig, type VideoConfig } from '@vc/config';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImageOps } from './images';
import { finalizeJob, prepareJob, type FinalizeDeps, type PrepareDeps } from './orchestrator';
import type { ProviderSet } from './roles';
import {
  FakeAlignProvider,
  FakeImageSource,
  FakePageFetcher,
  FakeSearchProvider,
  FakeTextProvider,
  FakeVisionProvider,
  FakeVoiceProvider,
  candidate,
  encodeTestWav,
  testContext,
  wavMediaOps,
} from './testing';

const facts = JSON.stringify({
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
const pages = {
  'https://a.example/apollo': {
    title: 'Apollo',
    text: 'Apollo 11 landed on July 20, 1969. Twelve astronauts walked on the Moon. The Saturn V launched them.',
  },
};

const scriptReply = (n: number) =>
  JSON.stringify({
    title: 'One giant leap',
    scenes: Array.from({ length: n }, (_, i) => ({
      narration: `Scene ${i + 1} tells part of the Apollo story clearly.`,
      imageQuery: `Saturn V rocket launch ${i + 1}`,
      keywords: ['apollo'],
    })),
  });

const imageOps = (): ImageOps => ({
  async download(c, name) {
    return { path: `/job/${name}`, width: c.width ?? 1920, height: c.height ?? 1080 };
  },
  async thumbnail() {
    return { data: new Uint8Array([1]), mimeType: 'image/jpeg' };
  },
  async analyze() {
    return {
      subject: { x: 0.25, y: 0.1, w: 0.5, h: 0.4 },
      busyness: { top: 0.3, middle: 0.2, bottom: 0.05 },
    };
  },
  async palette() {
    return ['#101010', '#202020', '#E0A000', '#F0F0F0', '#3060F0'];
  },
});

const imageSource = () =>
  new FakeImageSource((q) => [
    candidate({
      id: `${q.query}-a`,
      title: `Apollo ${q.query}`,
      tags: ['nasa', 'rocket', 'launch'],
    }),
    candidate({ id: `${q.query}-b`, title: `Rocket ${q.query} photo`, tags: ['rocket'] }),
  ]);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const setup = async (capUsd = 5) => {
  const t = await testContext({ capUsd });
  cleanups.push(t.files.cleanup);
  return t;
};

const deps = (
  providers: Partial<ProviderSet> & Pick<ProviderSet, 'text'>,
  patch: Partial<PrepareDeps> = {},
): PrepareDeps => ({
  providers: { search: null, voice: null, align: null, vision: null, ...providers },
  fetcher: new FakePageFetcher(pages),
  imageSource: imageSource(),
  imageOps: imageOps(),
  media: wavMediaOps(),
  visionAlways: false,
  assetUrl: (path) => `http://127.0.0.1:4317/assets${path.startsWith('/') ? '' : '/'}${path}`,
  fontInfo: async (family) => ({ fontFamily: family, importName: family.replace(/\s/g, '') }),
  musicPath: async () => null,
  ...patch,
});

const config = (patch: Parameters<typeof mergeConfig>[1] = {}): VideoConfig =>
  mergeConfig(SCHEMA_DEFAULTS, patch);

describe('prepareJob: research → script → voice → timing → images → captions → plan', () => {
  it('produces a valid plan and logs every AI call with its stage and reason', async () => {
    const { ctx, ledger, files } = await setup();
    const text = new FakeTextProvider([facts, scriptReply(5)]);
    const r = await prepareJob(
      ctx,
      { topic: 'The Apollo program', lengthSeconds: 30, config: config() },
      deps({
        text,
        search: new FakeSearchProvider([{ url: 'https://a.example/apollo', title: 'Apollo' }]),
        voice: new FakeVoiceProvider({ returnsTimings: true, msPerChar: 55 }),
      }),
    );

    expect(ScenePlanSchema.safeParse(r.plan).success).toBe(true);
    expect(r.plan.scenes).toHaveLength(r.timing.spans.length);
    expect(r.plan.scenes[0]!.startMs).toBe(0);
    expect(r.plan.scenes.at(-1)!.endMs).toBe(r.plan.durationMs);
    expect(r.plan.audio.narrationSrc).toBe(`http://127.0.0.1:4317/assets${r.voice.audioPath}`);
    expect(r.plan.fonts.caption).toMatchObject({ fontFamily: 'Inter' });
    expect(r.plan.words.length).toBeGreaterThan(20);
    expect(r.srt).toMatch(/^1\n00:00:00,000 --> /);

    expect(ledger.records.map((x) => `${x.stage}/${x.role}/${x.ai}`)).toEqual([
      'research/search/false',
      'research/text/true',
      'script/text/true',
      'voice/voice/true',
    ]);
    for (const record of ledger.aiRecords()) expect(record.reason.length).toBeGreaterThan(10);

    for (const name of ['plan.json', 'captions.srt', 'factsheet.json', 'script.json']) {
      expect(await files.exists(join(files.dir, name))).toBe(true);
    }
    expect(JSON.parse(await readFile(join(files.dir, 'plan.json'), 'utf8'))).toEqual(r.plan);
  });

  it('runs with pasted text and an uploaded recording: no search, no TTS, only alignment', async () => {
    const { ctx, ledger, files } = await setup();
    const recording = join(files.dir, 'take.wav');
    await writeFile(recording, encodeTestWav(9000));
    const align = new FakeAlignProvider(() => [{ text: 'scene', startMs: 0, endMs: 400 }]);
    const r = await prepareJob(
      ctx,
      {
        topic: 'Apollo',
        lengthSeconds: 30,
        config: config(),
        sourceText: 'Apollo 11 landed in 1969. Twelve people walked on the Moon.',
        recordingPath: recording,
      },
      deps({ text: new FakeTextProvider([scriptReply(5)]), align }),
    );
    expect(r.factSheet.method).toBe('user-text');
    expect(r.voice.source).toBe('recording');
    expect(ledger.records.map((x) => `${x.stage}/${x.role}`)).toEqual([
      'script/text',
      'timing/align',
    ]);
    expect(r.plan.durationMs).toBe(9000);
  });

  it('asks for more scenes for Dynamic than for Cinematic', async () => {
    const scenesAsked = async (animationKind: 'dynamic' | 'cinematic') => {
      const { ctx } = await setup();
      // 17 nine-word scenes are 153 words, over the 150-word budget: the one allowed rewrite follows.
      const text = new FakeTextProvider([scriptReply(17), scriptReply(10)]);
      await prepareJob(
        ctx,
        {
          topic: 'Apollo',
          lengthSeconds: 60,
          config: config({ simple: { animationKind } }),
          sourceText: 'Apollo flew in 1969.',
        },
        deps({ text, voice: new FakeVoiceProvider() }),
      );
      return Number(/exactly (\d+) scenes/.exec(text.requests[0]!.system!)![1]);
    };
    expect(await scenesAsked('dynamic')).toBeGreaterThan(await scenesAsked('cinematic'));
  });

  it('pulls the palette from the first image when asked to', async () => {
    const { ctx } = await setup();
    const r = await prepareJob(
      ctx,
      {
        topic: 'Apollo',
        lengthSeconds: 30,
        config: config({ backdrop: { palette: { source: 'image' } } }),
        sourceText: 'Apollo flew in 1969.',
      },
      deps({ text: new FakeTextProvider([scriptReply(5)]), voice: new FakeVoiceProvider() }),
    );
    expect(r.plan.palette).toEqual(['#101010', '#202020', '#E0A000', '#F0F0F0', '#3060F0']);
  });

  it('passes music through as an asset', async () => {
    const { ctx } = await setup();
    const r = await prepareJob(
      ctx,
      { topic: 'Apollo', lengthSeconds: 30, config: config(), sourceText: 'Apollo flew in 1969.' },
      deps(
        { text: new FakeTextProvider([scriptReply(5)]), voice: new FakeVoiceProvider() },
        { musicPath: async () => '/shared/music/soft-pad.wav' },
      ),
    );
    expect(r.plan.audio.musicSrc).toBe('http://127.0.0.1:4317/assets/shared/music/soft-pad.wav');
  });

  it('fails at the cost cap with a clear message', async () => {
    const { ctx } = await setup(0.000001);
    await expect(
      prepareJob(
        ctx,
        { topic: 'Apollo', lengthSeconds: 30, config: config(), sourceText: 'Apollo.' },
        deps({ text: new FakeTextProvider([scriptReply(5)]), voice: new FakeVoiceProvider() }),
      ),
    ).rejects.toThrow(/cost cap/i);
  });

  it('collects warnings for the job page', async () => {
    const { ctx } = await setup();
    const reply = JSON.stringify({
      title: 't',
      scenes: Array.from({ length: 5 }, (_, i) => ({
        narration: `It cost ${i + 100} billion dollars.`,
        imageQuery: 'cat sofa',
      })),
    });
    const r = await prepareJob(
      ctx,
      { topic: 'Apollo', lengthSeconds: 30, config: config(), sourceText: 'Apollo flew in 1969.' },
      deps(
        { text: new FakeTextProvider([reply]), voice: new FakeVoiceProvider() },
        { imageSource: new FakeImageSource(() => []) },
      ),
    );
    expect(r.warnings.some((w) => /not in the fact sheet/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /typographic/.test(w))).toBe(true);
  });
});

describe('finalizeJob: render → stitch → credits → checks', () => {
  const prepared = async () => {
    const t = await setup();
    const r = await prepareJob(
      t.ctx,
      { topic: 'Apollo', lengthSeconds: 30, config: config(), sourceText: 'Apollo flew in 1969.' },
      deps({
        text: new FakeTextProvider([scriptReply(5)]),
        voice: new FakeVoiceProvider({ returnsTimings: true }),
      }),
    );
    return { ...t, prepared: r };
  };

  const finalizeDeps = (patch: Partial<FinalizeDeps> = {}): FinalizeDeps & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      async render({ outputPath, plan }) {
        calls.push(`render:${outputPath.split('/').pop()}`);
        await writeFile(outputPath, encodeTestWav(plan.durationMs));
        return { elapsedMs: 1234, captionOverflows: [] };
      },
      async mixAudio({ outputPath }) {
        calls.push('mix');
        await writeFile(outputPath, encodeTestWav(10));
        return { integratedLufs: -14, truePeakDb: -1.6 };
      },
      async mux({ outputPath, container }) {
        calls.push(`mux:${container}`);
        await writeFile(outputPath, 'video');
      },
      async probeDurationMs() {
        return 0;
      },
      async measureClipping() {
        return { peakDbfs: -1.6, clippedSamples: 0, clipped: false };
      },
      async contactSheet() {
        return { data: new Uint8Array([1]), mimeType: 'image/png' };
      },
      vision: null,
      visionFinalCheck: false,
      ...patch,
    };
  };

  it('renders muted video, mixes and muxes audio, writes credits and the .srt, and checks the result', async () => {
    const { ctx, files, prepared: p } = await prepared();
    const d = finalizeDeps({ probeDurationMs: async () => p.plan.durationMs });
    const out = await finalizeJob(
      ctx,
      {
        plan: p.plan,
        config: config(),
        requestedLengthSeconds: 30,
        factSheet: p.factSheet,
        isStyleRerun: false,
        narrationPath: p.voice.audioPath,
        musicPath: null,
        music: { kind: 'none' },
      },
      d,
    );
    expect(d.calls).toEqual(['render:render.mp4', 'mix', 'mux:mp4']);
    expect(out.videoPath).toBe(join(files.dir, 'video.mp4'));
    expect(await readFile(out.srtPath, 'utf8')).toMatch(/^1\n/);
    expect(await readFile(out.creditsPath, 'utf8')).toContain('Your own source text');
    expect(out.checks.find((c) => c.id === 'duration')!.status).toBe('pass');
    expect(out.renderElapsedMs).toBe(1234);
  });

  it.each([
    ['vp9', 'webm'],
    ['prores', 'mov'],
    ['av1', 'mp4'],
  ] as const)('muxes %s into a .%s container', async (codec, container) => {
    const { ctx, prepared: p } = await prepared();
    const d = finalizeDeps();
    const out = await finalizeJob(
      ctx,
      {
        plan: p.plan,
        config: config({ output: { codec } }),
        requestedLengthSeconds: 30,
        factSheet: null,
        isStyleRerun: false,
        narrationPath: p.voice.audioPath,
        musicPath: null,
        music: { kind: 'none' },
      },
      d,
    );
    expect(d.calls.at(-1)).toBe(`mux:${container}`);
    expect(out.videoPath.endsWith(`.${container}`)).toBe(true);
  });

  it('still writes the .srt when captions are off', async () => {
    const { ctx, prepared: p } = await prepared();
    const out = await finalizeJob(
      ctx,
      {
        plan: p.plan,
        config: config({ simple: { captionStyle: 'off' } }),
        requestedLengthSeconds: 30,
        factSheet: null,
        isStyleRerun: false,
        narrationPath: p.voice.audioPath,
        musicPath: null,
        music: { kind: 'none' },
      },
      finalizeDeps(),
    );
    expect((await readFile(out.srtPath, 'utf8')).length).toBeGreaterThan(0);
  });

  it('a style-only rerun touches no AI at all, even with the vision check enabled', async () => {
    const { ctx, ledger, prepared: p } = await prepared();
    const before = ledger.records.length;
    const vision = new FakeVisionProvider([]);
    await finalizeJob(
      ctx,
      {
        plan: p.plan,
        config: config({ simple: { backdropKind: 'light' } }),
        requestedLengthSeconds: 30,
        factSheet: null,
        isStyleRerun: true,
        narrationPath: p.voice.audioPath,
        musicPath: null,
        music: { kind: 'none' },
      },
      finalizeDeps({ vision, visionFinalCheck: true }),
    );
    expect(ledger.records.length).toBe(before);
    expect(vision.prompts).toEqual([]);
  });

  it('reports a render failure against the render stage', async () => {
    const { ctx, prepared: p } = await prepared();
    await expect(
      finalizeJob(
        ctx,
        {
          plan: p.plan,
          config: config(),
          requestedLengthSeconds: 30,
          factSheet: null,
          isStyleRerun: false,
          narrationPath: p.voice.audioPath,
          musicPath: null,
          music: { kind: 'none' },
        },
        finalizeDeps({
          render: async () => {
            throw new Error('Chrome crashed');
          },
        }),
      ),
    ).rejects.toMatchObject({
      stage: 'render',
      message: expect.stringContaining('Chrome crashed'),
    });
  });
});
