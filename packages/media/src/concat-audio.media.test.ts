import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaError, concatAudio, probeMedia } from './index';
import { writeTone } from './testing';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vc-media-concat-audio-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('concatAudio (joins TTS parts end to end)', () => {
  it('joins parts with different sample rates and channel counts into one 48 kHz mono wav', async () => {
    const a = await writeTone({
      path: join(dir, 'a.wav'),
      frequency: 220,
      durationMs: 1000,
      sampleRate: 24_000,
      channels: 1,
    });
    const b = await writeTone({
      path: join(dir, 'b.wav'),
      frequency: 440,
      durationMs: 1500,
      channels: 2,
    });
    const out = join(dir, 'joined.wav');
    await concatAudio([a, b], out);
    const info = await probeMedia(out);
    expect(info.durationMs).toBeGreaterThan(2450);
    expect(info.durationMs).toBeLessThan(2550);
    expect(info.streams).toEqual([
      expect.objectContaining({ type: 'audio', sampleRate: 48_000, channels: 1 }),
    ]);
  });

  it('accepts a single part', async () => {
    const a = await writeTone({ path: join(dir, 'single.wav'), frequency: 330, durationMs: 800 });
    const out = join(dir, 'single-out.wav');
    await concatAudio([a], out);
    expect((await probeMedia(out)).durationMs).toBeCloseTo(800, -2);
  });

  it('rejects an empty list and missing files', async () => {
    await expect(concatAudio([], join(dir, 'x.wav'))).rejects.toBeInstanceOf(MediaError);
    await expect(
      concatAudio([join(dir, 'missing.wav')], join(dir, 'y.wav')),
    ).rejects.toBeInstanceOf(MediaError);
  });
});
