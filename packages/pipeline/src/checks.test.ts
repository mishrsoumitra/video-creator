import { afterEach, describe, expect, it } from 'vitest';
import { runFinalChecks, type FinalCheckInput } from './checks';
import { FakeVisionProvider, testContext } from './testing';

const plan = {
  durationMs: 10_000,
  scenes: [
    { visual: { type: 'image' as const, src: '/a.jpg' } },
    { visual: { type: 'typographic' as const, text: 'Hello' } },
  ],
};

const input = (patch: Partial<FinalCheckInput> = {}): FinalCheckInput => ({
  plan,
  fps: 30,
  renderedDurationMs: 10_000,
  requestedLengthSeconds: 10,
  captionOverflows: [],
  clipping: { peakDbfs: -1.6, clippedSamples: 0, clipped: false },
  vision: null,
  visionFinalCheck: false,
  isStyleRerun: false,
  contactSheet: async () => ({ data: new Uint8Array([1]), mimeType: 'image/png' }),
  ...patch,
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
const setup = async (capUsd = 5) => {
  const t = await testContext({ capUsd });
  cleanup = t.files.cleanup;
  return t;
};

const byId = (checks: Awaited<ReturnType<typeof runFinalChecks>>['checks']) =>
  Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe('final checks', () => {
  it('passes a correct render without any AI call', async () => {
    const { ctx, ledger } = await setup();
    const r = await runFinalChecks(ctx, input());
    expect(r.passed).toBe(true);
    expect(byId(r.checks)).toEqual({
      duration: 'pass',
      'length-target': 'pass',
      visuals: 'pass',
      'caption-overflow': 'pass',
      'audio-clipping': 'pass',
      'vision-frames': 'skipped',
    });
    expect(ledger.records).toEqual([]);
  });

  it('allows one frame of difference in duration, and fails beyond tolerance', async () => {
    const { ctx } = await setup();
    expect(
      byId((await runFinalChecks(ctx, input({ renderedDurationMs: 10_040 }))).checks).duration,
    ).toBe('pass');
    const off = await runFinalChecks(ctx, input({ renderedDurationMs: 10_300 }));
    expect(byId(off.checks).duration).toBe('fail');
    expect(off.passed).toBe(false);
  });

  it('warns when the narration is far from the requested length', async () => {
    const { ctx } = await setup();
    expect(
      byId((await runFinalChecks(ctx, input({ requestedLengthSeconds: 20 }))).checks)[
        'length-target'
      ],
    ).toBe('warn');
  });

  it('fails when a scene has neither an image nor a typographic fallback', async () => {
    const { ctx } = await setup();
    const broken = {
      durationMs: 10_000,
      scenes: [{ visual: { type: 'image' as const, src: '' } }],
    };
    expect(byId((await runFinalChecks(ctx, input({ plan: broken }))).checks).visuals).toBe('fail');
  });

  it('reports caption overflow measured during the render', async () => {
    const { ctx } = await setup();
    const r = await runFinalChecks(
      ctx,
      input({
        captionOverflows: [{ pageText: 'a very long caption', fontSize: 36, overflowPx: 40 }],
      }),
    );
    const check = r.checks.find((c) => c.id === 'caption-overflow')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/1 caption/);
  });

  it('reports audio clipping', async () => {
    const { ctx } = await setup();
    const r = await runFinalChecks(
      ctx,
      input({ clipping: { peakDbfs: 0, clippedSamples: 120, clipped: true } }),
    );
    expect(byId(r.checks)['audio-clipping']).toBe('warn');
  });

  it('runs the vision contact-sheet check only when enabled in Settings', async () => {
    const { ctx, ledger } = await setup();
    const vision = new FakeVisionProvider([
      JSON.stringify({ issues: [{ frame: 4, problem: 'caption covers a face' }] }),
    ]);
    const r = await runFinalChecks(ctx, input({ vision, visionFinalCheck: true }));
    const check = r.checks.find((c) => c.id === 'vision-frames')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('frame 4: caption covers a face');
    expect(vision.imageCounts).toEqual([1]);
    expect(ledger.records[0]).toMatchObject({ stage: 'checks', role: 'vision', required: false });
    expect(ledger.records[0]!.reason).toMatch(/Settings/);
  });

  it('never runs the vision check on a style-only rerun (no AI at all)', async () => {
    const { ctx, ledger } = await setup();
    const vision = new FakeVisionProvider([]);
    const r = await runFinalChecks(
      ctx,
      input({ vision, visionFinalCheck: true, isStyleRerun: true }),
    );
    expect(r.checks.find((c) => c.id === 'vision-frames')).toMatchObject({ status: 'skipped' });
    expect(ledger.records).toEqual([]);
  });

  it('skips the vision check at the cost cap', async () => {
    const { ctx } = await setup(0);
    const r = await runFinalChecks(
      ctx,
      input({ vision: new FakeVisionProvider([]), visionFinalCheck: true }),
    );
    expect(r.checks.find((c) => c.id === 'vision-frames')).toMatchObject({ status: 'skipped' });
  });
});
