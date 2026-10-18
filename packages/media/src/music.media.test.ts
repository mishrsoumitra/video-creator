import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIBRARY_TRACKS,
  generateLibraryTrack,
  measureClipping,
  measureLoudness,
  probeMedia,
} from './index';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vc-media-music-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('generateLibraryTrack (original procedural music)', () => {
  it.each(LIBRARY_TRACKS.map((t) => t.id))(
    'renders %s at the requested length, quiet and unclipped',
    async (id) => {
      const out = join(dir, `${id}.wav`);
      const result = await generateLibraryTrack(id, 8000, out);
      const info = await probeMedia(out);
      expect(info.streams[0]).toMatchObject({
        type: 'audio',
        codec: 'pcm_s16le',
        sampleRate: 48_000,
        channels: 2,
      });
      expect(Math.abs(info.durationMs - 8000)).toBeLessThan(50);
      expect(Math.abs(result.durationMs - 8000)).toBeLessThan(50);
      const loudness = await measureLoudness(out);
      expect(loudness.integratedLufs).toBeGreaterThanOrEqual(-24);
      expect(loudness.integratedLufs).toBeLessThanOrEqual(-16);
      expect((await measureClipping(out)).clipped).toBe(false);
    },
  );

  it('rejects an unknown track and a non-positive duration', async () => {
    await expect(
      generateLibraryTrack('polka' as never, 8000, join(dir, 'x.wav')),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(generateLibraryTrack('drone', 0, join(dir, 'y.wav'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});
