import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureClipping, measureLevels, measureLoudness } from './index';
import { writeClippedSquare, writeTone } from './testing';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vc-media-analysis-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('measureClipping', () => {
  it('flags a full-scale clipped square wave', async () => {
    const path = await writeClippedSquare({ path: join(dir, 'square.wav'), durationMs: 500 });
    const result = await measureClipping(path);
    expect(result.clipped).toBe(true);
    expect(result.clippedSamples).toBeGreaterThan(1000);
    expect(result.peakDbfs).toBeGreaterThan(-0.1);
  });

  it('passes a quiet sine and reports its peak', async () => {
    const path = await writeTone({
      path: join(dir, 'quiet.wav'),
      frequency: 440,
      durationMs: 500,
      amplitude: 0.1,
    });
    const result = await measureClipping(path);
    expect(result.clipped).toBe(false);
    expect(result.clippedSamples).toBe(0);
    expect(result.peakDbfs).toBeCloseTo(-20, 0);
  });

  it('reports -Infinity for digital silence', async () => {
    const path = await writeTone({
      path: join(dir, 'silence.wav'),
      frequency: 440,
      durationMs: 300,
      amplitude: 0,
    });
    expect((await measureClipping(path)).peakDbfs).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('measureLoudness', () => {
  it('measures integrated loudness, true peak and LRA', async () => {
    const path = await writeTone({
      path: join(dir, 'loud.wav'),
      frequency: 1000,
      durationMs: 4000,
      amplitude: 0.1,
      channels: 2,
    });
    const result = await measureLoudness(path);
    // A -20 dBFS RMS 1 kHz stereo sine reads about -20 LUFS (K-weighting is ~+0.7 dB at 1 kHz, stereo sums).
    expect(result.integratedLufs).toBeGreaterThan(-23);
    expect(result.integratedLufs).toBeLessThan(-14);
    expect(result.truePeakDb).toBeCloseTo(-20, 0);
    expect(result.lra).toBeGreaterThanOrEqual(0);
  });
});

describe('measureLevels', () => {
  it('reports RMS per window and follows a level step', async () => {
    const path = await writeTone({
      path: join(dir, 'step.wav'),
      frequency: 220,
      durationMs: 2000,
      segments: [
        { fromMs: 0, toMs: 1000, amplitude: 0.5 },
        { fromMs: 1000, toMs: 2000, amplitude: 0.05 },
      ],
    });
    const levels = await measureLevels(path, 100);
    expect(levels).toHaveLength(20);
    const loud = levels[5]!;
    const quiet = levels[15]!;
    expect(loud).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 0);
    expect(loud - quiet).toBeCloseTo(20, 0);
  });

  it('can low-pass first to isolate a band', async () => {
    const path = await writeTone({
      path: join(dir, 'high.wav'),
      frequency: 4000,
      durationMs: 1000,
      amplitude: 0.5,
    });
    const plain = await measureLevels(path, 200);
    const filtered = await measureLevels(path, 200, { lowpassHz: 400 });
    expect(plain[2]! - filtered[2]!).toBeGreaterThan(30);
  });
});
