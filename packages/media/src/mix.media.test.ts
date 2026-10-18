import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MediaError,
  measureClipping,
  measureLevels,
  measureLoudness,
  mixAudio,
  probeMedia,
  type MixAudioOptions,
} from './index';
import { writeTone } from './testing';

let dir: string;
let narration: string;
let music: string;
let shortMusic: string;

// Narration: 1 kHz "speech" in [2,4) s and [6,8) s of a 10 s file. Music: steady 220 Hz.
const SPEECH = [
  { fromMs: 2000, toMs: 4000, amplitude: 0.2 },
  { fromMs: 6000, toMs: 8000, amplitude: 0.2 },
];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vc-media-mix-'));
  narration = await writeTone({
    path: join(dir, 'narration.wav'),
    frequency: 1000,
    durationMs: 10_000,
    segments: SPEECH,
  });
  music = await writeTone({
    path: join(dir, 'music.wav'),
    frequency: 220,
    durationMs: 10_000,
    amplitude: 0.1,
  });
  shortMusic = await writeTone({
    path: join(dir, 'short-music.wav'),
    frequency: 220,
    durationMs: 3000,
    amplitude: 0.1,
  });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const options = (patch: Partial<MixAudioOptions> = {}): MixAudioOptions => ({
  narrationPath: narration,
  musicPath: music,
  outputPath: join(dir, `mix-${Math.random().toString(36).slice(2)}.wav`),
  narrationVolume: 1,
  musicVolume: 1,
  ducking: { enabled: true, depthDb: 12, attackMs: 30, releaseMs: 300 },
  loudnessTargetLufs: -16,
  ...patch,
});

/** Mean music-band level (low-passed to drop the 1 kHz narration) over [fromMs, toMs). */
const musicLevel = (levels: number[], windowMs: number, fromMs: number, toMs: number) => {
  const slice = levels.slice(Math.round(fromMs / windowMs), Math.round(toMs / windowMs));
  return slice.reduce((a, b) => a + b, 0) / slice.length;
};

const measuredDucking = async (path: string) => {
  const levels = await measureLevels(path, 100, { lowpassHz: 400 });
  const quiet = (musicLevel(levels, 100, 800, 1800) + musicLevel(levels, 100, 4800, 5600)) / 2;
  const speech = (musicLevel(levels, 100, 2800, 3600) + musicLevel(levels, 100, 6800, 7600)) / 2;
  return quiet - speech;
};

describe('mixAudio ducking (sidechaincompress keyed by the narration)', () => {
  it.each([6, 12, 20])(
    'lowers the music by about %d dB while the narrator speaks',
    async (depthDb) => {
      const result = await mixAudio(
        options({ ducking: { enabled: true, depthDb, attackMs: 30, releaseMs: 300 } }),
      );
      const ducking = await measuredDucking(result.outputPath);
      expect(ducking).toBeGreaterThan(depthDb - 3);
      expect(ducking).toBeLessThan(depthDb + 3);
    },
  );

  it('leaves the music level alone when ducking is off', async () => {
    const result = await mixAudio(
      options({ ducking: { enabled: false, depthDb: 12, attackMs: 30, releaseMs: 300 } }),
    );
    expect(Math.abs(await measuredDucking(result.outputPath))).toBeLessThan(1);
  });
});

describe('mixAudio loudness (two-pass loudnorm, linear)', () => {
  it.each([-16, -23])(
    'lands within 1 LU of %d LUFS without exceeding the true-peak target',
    async (target) => {
      const result = await mixAudio(options({ loudnessTargetLufs: target }));
      const measured = await measureLoudness(result.outputPath);
      expect(Math.abs(measured.integratedLufs - target)).toBeLessThan(1);
      expect(Math.abs(result.integratedLufs - target)).toBeLessThan(1);
      expect(measured.truePeakDb).toBeLessThan(-1.5 + 0.5);
      expect(result.normalization).toBe('linear');
    },
  );

  it('keeps linear normalisation even when the gain would push peaks over the ceiling', async () => {
    const hot = await writeTone({
      path: join(dir, 'peaky.wav'),
      frequency: 1000,
      durationMs: 6000,
      segments: [
        { fromMs: 0, toMs: 5800, amplitude: 0.02 },
        { fromMs: 5800, toMs: 5900, amplitude: 0.9 },
      ],
    });
    const result = await mixAudio(
      options({ narrationPath: hot, musicPath: null, loudnessTargetLufs: -14 }),
    );
    const measured = await measureLoudness(result.outputPath);
    expect(Math.abs(measured.integratedLufs - -14)).toBeLessThan(1);
    expect(measured.truePeakDb).toBeLessThan(-1);
    expect((await measureClipping(result.outputPath)).clipped).toBe(false);
  });
});

describe('mixAudio shape', () => {
  it('writes 48 kHz stereo audio as long as the narration', async () => {
    const result = await mixAudio(options());
    const info = await probeMedia(result.outputPath);
    expect(info.streams[0]).toMatchObject({ type: 'audio', sampleRate: 48_000, channels: 2 });
    expect(Math.abs(info.durationMs - 10_000)).toBeLessThan(50);
    expect(Math.abs(result.durationMs - 10_000)).toBeLessThan(50);
  });

  it('works without music', async () => {
    const result = await mixAudio(options({ musicPath: null }));
    expect(Math.abs(result.durationMs - 10_000)).toBeLessThan(50);
    const levels = await measureLevels(result.outputPath, 100, { lowpassHz: 400 });
    // Nothing in the music band during the silent parts of the narration.
    expect(musicLevel(levels, 100, 800, 1800)).toBeLessThan(-60);
  });

  it('loops music that is shorter than the narration', async () => {
    const result = await mixAudio(
      options({
        musicPath: shortMusic,
        ducking: { enabled: false, depthDb: 0, attackMs: 30, releaseMs: 300 },
      }),
    );
    const levels = await measureLevels(result.outputPath, 100, { lowpassHz: 400 });
    expect(Math.abs(result.durationMs - 10_000)).toBeLessThan(50);
    // Still playing at 8.5 s, well after the 3 s source ended (and before the fade-out).
    expect(musicLevel(levels, 100, 8300, 8800)).toBeGreaterThan(
      musicLevel(levels, 100, 1000, 1500) - 2,
    );
  });

  it('retimes the narration when the rate is unlocked (pitch preserved by atempo)', async () => {
    const result = await mixAudio(options({ narrationRate: 1.25 }));
    expect(Math.abs(result.durationMs - 8000)).toBeLessThan(60);
  });

  it('rejects a rate outside 0.5..2 and missing inputs', async () => {
    await expect(mixAudio(options({ narrationRate: 3 }))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const error = await mixAudio(options({ narrationPath: join(dir, 'missing.wav') })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MediaError);
    expect(error).toMatchObject({ code: 'not_found' });
  });
});
