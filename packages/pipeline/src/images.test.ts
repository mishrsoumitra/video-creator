import { afterEach, describe, expect, it } from 'vitest';
import type { ImageAnalysis } from './image-analysis';
import {
  IMAGE_SCORE_THRESHOLD,
  MIN_RELEVANCE,
  filterCandidates,
  rankCandidates,
  runImages,
  scoreCandidate,
  type ImageOps,
} from './images';
import type { ImageCandidate } from './services';
import { FakeImageSource, FakeVisionProvider, candidate, testContext } from './testing';

const apolloScene = {
  narration: 'In July 1969 a Saturn V rocket carried three astronauts toward the Moon.',
  imageQuery: 'Saturn V rocket launch',
  keywords: ['apollo'],
};
const abstractScene = {
  narration: 'Trust in public institutions takes years to build and moments to lose.',
  imageQuery: 'trust institutions',
  keywords: [],
};

const apolloCandidates: ImageCandidate[] = [
  candidate({
    id: 'good',
    title: 'Apollo 11 Saturn V rocket launch',
    tags: ['nasa', 'rocket', 'launch'],
  }),
  candidate({ id: 'planet', title: 'Saturn planet rings', tags: ['saturn', 'planet'] }),
  candidate({ id: 'salad', title: 'Rocket salad', tags: ['food'] }),
];
const trustCandidates: ImageCandidate[] = [
  candidate({
    id: 'handshake',
    title: 'Handshake between two people',
    tags: ['handshake', 'agreement'],
  }),
  candidate({ id: 'court', title: 'Courthouse columns', tags: ['courthouse', 'justice'] }),
  candidate({
    id: 'trustfall',
    title: 'Trust fall team exercise',
    tags: ['team building', 'trust'],
  }),
];

const analysis: ImageAnalysis = {
  subject: { x: 0.3, y: 0.1, w: 0.4, h: 0.4 },
  busyness: { top: 0.3, middle: 0.2, bottom: 0.05 },
};

const fakeOps = (
  opts: { failIds?: string[] } = {},
): ImageOps & { downloads: string[]; thumbs: string[] } => {
  const downloads: string[] = [];
  const thumbs: string[] = [];
  return {
    downloads,
    thumbs,
    async download(c, name) {
      downloads.push(c.id);
      if (opts.failIds?.includes(c.id)) throw new Error('HTTP 404');
      return { path: `/tmp/job/${name}`, width: c.width ?? 1600, height: c.height ?? 900 };
    },
    async thumbnail(c) {
      thumbs.push(c.id);
      return { data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' };
    },
    async analyze() {
      return analysis;
    },
    async palette() {
      return ['#000000', '#111111', '#FF0000', '#FFFFFF', '#00FF00'];
    },
  };
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});
const setup = async (capUsd = 5) => {
  const t = await testContext({ capUsd });
  cleanups.push(t.files.cleanup);
  return t;
};

const base = (patch: Partial<Parameters<typeof runImages>[1]>) => ({
  scenes: [apolloScene],
  aspect: '16:9' as const,
  captionPosition: 'lower-third' as const,
  source: new FakeImageSource(() => apolloCandidates),
  ops: fakeOps(),
  vision: null,
  visionAlways: false,
  ...patch,
});

describe('filterCandidates: licence, width, aspect', () => {
  it('keeps commercial-safe, large enough, roughly right-shaped images', () => {
    const result = filterCandidates(
      [
        candidate({ id: 'ok', title: 'x' }),
        candidate({ id: 'nc', title: 'x', license: 'by-nc' }),
        candidate({ id: 'tiny', title: 'x', width: 400, height: 300 }),
        candidate({ id: 'strip', title: 'x', width: 6000, height: 1000 }),
        candidate({ id: 'mature', title: 'x', mature: true }),
        candidate({ id: 'used', title: 'x' }),
        candidate({ id: 'portrait', title: 'x', width: 1200, height: 1800 }),
      ],
      { aspect: '16:9', licenses: ['cc0', 'pdm', 'by', 'by-sa'], exclude: new Set(['used']) },
    );
    expect(result.kept.map((c) => c.id)).toEqual(['ok', 'portrait']);
    expect(Object.fromEntries(result.rejected.map((r) => [r.id, r.reason]))).toEqual({
      nc: 'licence by-nc not allowed',
      tiny: 'too small',
      strip: 'wrong shape',
      mature: 'mature',
      used: 'used in another scene',
    });
  });
});

describe('scoreCandidate: title and tag overlap with the scene, plus shape and size', () => {
  it('scores a full query match above a partial one', () => {
    const [good, planet, salad] = apolloCandidates.map(
      (c) => scoreCandidate(apolloScene, c, '16:9').score,
    );
    const unrelated = scoreCandidate(
      apolloScene,
      candidate({ id: 'cat', title: 'Cat on a sofa' }),
      '16:9',
    ).score;
    expect(good).toBeGreaterThan(planet!);
    expect(good).toBeGreaterThan(salad!);
    expect(planet).toBeGreaterThan(unrelated);
    expect(salad).toBeGreaterThan(unrelated);
  });

  it('prefers the right shape for the frame', () => {
    const wide = scoreCandidate(
      apolloScene,
      candidate({ id: 'w', title: 'Saturn V rocket launch', width: 1920, height: 1080 }),
      '16:9',
    );
    const tall = scoreCandidate(
      apolloScene,
      candidate({ id: 't', title: 'Saturn V rocket launch', width: 1080, height: 1920 }),
      '16:9',
    );
    expect(wide.score).toBeGreaterThan(tall.score);
    expect(
      scoreCandidate(
        apolloScene,
        candidate({ id: 't', title: 'Saturn V rocket launch', width: 1080, height: 1920 }),
        '9:16',
      ).score,
    ).toBeGreaterThan(wide.score - 1e-9);
  });

  it('stays within 0..1 and handles unknown dimensions', () => {
    const s = scoreCandidate(
      apolloScene,
      candidate({ id: 'u', title: 'Saturn V', width: null, height: null }),
      '16:9',
    );
    expect(s.score).toBeGreaterThan(0);
    expect(s.score).toBeLessThanOrEqual(1);
  });

  it('ranks deterministically, breaking ties by id', () => {
    const twins = [
      candidate({ id: 'b', title: 'Saturn V rocket launch' }),
      candidate({ id: 'a', title: 'Saturn V rocket launch' }),
    ];
    expect(rankCandidates(apolloScene, twins, '16:9').map((c) => c.candidate.id)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('runImages: deterministic first, vision only below the threshold or when switched on', () => {
  it('takes a confident deterministic pick without calling vision', async () => {
    const { ctx, ledger } = await setup();
    const vision = new FakeVisionProvider([]);
    const r = await runImages(ctx, base({ vision }));
    expect(r.decisions[0]).toMatchObject({ method: 'deterministic', chosenId: 'good' });
    expect(r.decisions[0]!.bestScore).toBeGreaterThanOrEqual(IMAGE_SCORE_THRESHOLD);
    expect(vision.prompts).toEqual([]);
    expect(ledger.records).toEqual([]);
    expect(r.scenes[0]!.visual).toMatchObject({
      type: 'image',
      src: '/tmp/job/scene-01.jpg',
      width: 1920,
      height: 1080,
    });
  });

  it('asks the vision model to rank the top 6 when the best score is below the threshold', async () => {
    const { ctx, ledger } = await setup();
    const many = [
      ...trustCandidates,
      ...Array.from({ length: 5 }, (_, i) =>
        candidate({ id: `extra${i}`, title: `Generic photo ${i}` }),
      ),
    ];
    const vision = new FakeVisionProvider([
      JSON.stringify({
        ratings: [
          { index: 1, score: 3 },
          { index: 2, score: 8 },
          { index: 3, score: 2 },
        ],
      }),
    ]);
    const ops = fakeOps();
    const r = await runImages(
      ctx,
      base({ scenes: [abstractScene], source: new FakeImageSource(() => many), vision, ops }),
    );
    expect(vision.imageCounts).toEqual([6]);
    expect(ops.thumbs).toHaveLength(6);
    expect(r.decisions[0]!.method).toBe('vision');
    const ranked = rankCandidates(abstractScene, many, '16:9');
    expect(r.decisions[0]!.chosenId).toBe(ranked[1]!.candidate.id);
    expect(ledger.records[0]).toMatchObject({ stage: 'images', role: 'vision', required: false });
    expect(ledger.records[0]!.reason).toMatch(/below the threshold/);
  });

  it('calls vision on every scene when the user turned Vision on in Settings', async () => {
    const { ctx, ledger } = await setup();
    const vision = new FakeVisionProvider([JSON.stringify({ ratings: [{ index: 1, score: 9 }] })]);
    const r = await runImages(ctx, base({ vision, visionAlways: true }));
    expect(r.decisions[0]!.method).toBe('vision');
    expect(ledger.records[0]!.reason).toMatch(/Settings/);
  });

  it('without a vision provider, keeps a weak but relevant pick, else falls back to a typographic scene', async () => {
    const { ctx } = await setup();
    const weak = await runImages(
      ctx,
      base({ scenes: [abstractScene], source: new FakeImageSource(() => trustCandidates) }),
    );
    const best = rankCandidates(abstractScene, trustCandidates, '16:9')[0]!;
    expect(best.scores.text).toBeGreaterThanOrEqual(MIN_RELEVANCE);
    expect(weak.decisions[0]!.method).toBe('deterministic');
    const fresh = await setup();
    const none = await runImages(
      fresh.ctx,
      base({
        scenes: [abstractScene],
        source: new FakeImageSource(() => [candidate({ id: 'cat', title: 'Cat on a sofa' })]),
      }),
    );
    expect(none.decisions[0]!.method).toBe('fallback');
    expect(none.scenes[0]!.visual).toEqual({ type: 'typographic', text: 'Trust Institutions' });
  });

  it('falls back to typography when vision rates every image as unsuitable', async () => {
    const { ctx } = await setup();
    const vision = new FakeVisionProvider([
      JSON.stringify({
        ratings: [
          { index: 1, score: 2 },
          { index: 2, score: 1 },
          { index: 3, score: 4 },
        ],
      }),
    ]);
    const r = await runImages(
      ctx,
      base({ scenes: [abstractScene], source: new FakeImageSource(() => trustCandidates), vision }),
    );
    expect(r.decisions[0]!.method).toBe('fallback');
    expect(r.scenes[0]!.visual.type).toBe('typographic');
  });

  it('skips vision at the cost cap and uses the deterministic rule instead', async () => {
    const { ctx, ledger } = await setup(0);
    const vision = new FakeVisionProvider([JSON.stringify({ ratings: [] })]);
    const r = await runImages(
      ctx,
      base({ scenes: [abstractScene], source: new FakeImageSource(() => trustCandidates), vision }),
    );
    expect(vision.prompts).toEqual([]);
    expect(ledger.records[0]).toMatchObject({ status: 'skipped-cap', role: 'vision' });
    expect(['deterministic', 'fallback']).toContain(r.decisions[0]!.method);
  });

  it('survives a malformed vision reply', async () => {
    const { ctx } = await setup();
    const vision = new FakeVisionProvider(['I think number two is nice']);
    const r = await runImages(
      ctx,
      base({ scenes: [abstractScene], source: new FakeImageSource(() => trustCandidates), vision }),
    );
    expect(['deterministic', 'fallback']).toContain(r.decisions[0]!.method);
  });

  it('uses a typographic scene when the search finds nothing', async () => {
    const { ctx } = await setup();
    const r = await runImages(ctx, base({ source: new FakeImageSource(() => []) }));
    expect(r.scenes[0]!.visual).toEqual({ type: 'typographic', text: 'Saturn V Rocket Launch' });
    expect(r.decisions[0]).toMatchObject({ method: 'fallback', chosenId: null });
  });

  it('tries the next candidate when a download fails, then gives up gracefully', async () => {
    const { ctx } = await setup();
    const ops = fakeOps({ failIds: ['good'] });
    const r = await runImages(ctx, base({ ops }));
    expect(ops.downloads[0]).toBe('good');
    expect(r.decisions[0]!.chosenId).not.toBe('good');
    const allFail = fakeOps({ failIds: ['good', 'planet', 'salad'] });
    const r2 = await runImages(ctx, base({ ops: allFail }));
    expect(r2.scenes[0]!.visual.type).toBe('typographic');
  });

  it('never uses the same image in two scenes', async () => {
    const { ctx } = await setup();
    const r = await runImages(ctx, base({ scenes: [apolloScene, apolloScene] }));
    expect(r.decisions[0]!.chosenId).toBe('good');
    expect(r.decisions[1]!.chosenId).not.toBe('good');
  });

  it('reuses ranked candidates (and vision ratings) for the same query', async () => {
    const { ctx, ledger } = await setup();
    const source = new FakeImageSource(() => trustCandidates);
    const vision = new FakeVisionProvider([JSON.stringify({ ratings: [{ index: 1, score: 9 }] })]);
    await runImages(ctx, base({ scenes: [abstractScene], source, vision }));
    const second = await runImages(ctx, base({ scenes: [abstractScene], source, vision }));
    expect(source.queries).toHaveLength(1);
    expect(ledger.records.filter((x) => x.role === 'vision')).toHaveLength(1);
    expect(second.decisions[0]!.method).toBe('vision');
  });

  it('records licence metadata as the credit and asks the analyser where captions go', async () => {
    const { ctx } = await setup();
    const r = await runImages(ctx, base({ captionPosition: 'auto' }));
    const visual = r.scenes[0]!.visual;
    expect(visual.type === 'image' && visual.credit).toMatchObject({
      title: 'Apollo 11 Saturn V rocket launch',
      creator: 'Someone',
      license: 'by',
      licenseVersion: '4.0',
    });
    expect(r.scenes[0]!.captionPlacement).toBe('bottom');
    expect(r.scenes[0]!.analysis).toEqual(analysis);
  });

  it('searches with the commercial-safe licences and the frame aspect', async () => {
    const { ctx } = await setup();
    const source = new FakeImageSource(() => apolloCandidates);
    await runImages(ctx, base({ source, aspect: '9:16' }));
    expect(source.queries[0]).toMatchObject({
      query: 'Saturn V rocket launch',
      aspect: '9:16',
      licenses: ['cc0', 'pdm', 'by', 'by-sa'],
    });
  });
});
