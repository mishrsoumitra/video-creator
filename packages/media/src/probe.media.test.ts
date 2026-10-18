import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MediaError,
  convertAudio,
  encodeWav,
  ffmpegVersion,
  imageInfo,
  probeMedia,
  silentWav,
  toWav16kMono,
} from './index';
import { writeSolidImage, writeTestVideo, writeTone } from './testing';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vc-media-probe-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('probeMedia', () => {
  it('reads duration, sample rate and channels of a wav', async () => {
    const path = await writeTone({
      path: join(dir, 'tone.wav'),
      frequency: 440,
      durationMs: 1500,
      channels: 2,
    });
    const info = await probeMedia(path);
    expect(info.durationMs).toBeCloseTo(1500, -1);
    expect(info.formatName).toContain('wav');
    expect(info.streams).toEqual([
      expect.objectContaining({
        type: 'audio',
        codec: 'pcm_s16le',
        sampleRate: 48_000,
        channels: 2,
      }),
    ]);
  });

  it('reads codec, size and frame rate of a video', async () => {
    const path = await writeTestVideo({
      path: join(dir, 'clip.mp4'),
      durationMs: 2000,
      width: 320,
      height: 240,
      fps: 30,
    });
    const info = await probeMedia(path);
    expect(info.durationMs).toBeCloseTo(2000, -2);
    const video = info.streams.find((s) => s.type === 'video')!;
    expect(video).toMatchObject({ codec: 'h264', width: 320, height: 240, frameRate: 30 });
    expect(video.frameCount).toBe(60);
  });

  it('reports a missing file as not_found without spawning ffprobe', async () => {
    const error = await probeMedia(join(dir, 'nope.wav')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaError);
    expect(error).toMatchObject({ code: 'not_found' });
  });

  it('reports a file that is not media as a failure', async () => {
    const path = join(dir, 'text.wav');
    await writeFile(path, 'this is not audio');
    await expect(probeMedia(path)).rejects.toBeInstanceOf(MediaError);
  });
});

describe('imageInfo', () => {
  it('reads the size of a still image', async () => {
    const path = await writeSolidImage({
      path: join(dir, 'red.png'),
      width: 64,
      height: 36,
      color: 'red',
    });
    expect(await imageInfo(path)).toEqual({ width: 64, height: 36 });
  });
});

describe('audio conversion', () => {
  it('converts to 16 kHz mono 16-bit wav for whisper.cpp', async () => {
    const input = await writeTone({
      path: join(dir, 'stereo.wav'),
      frequency: 440,
      durationMs: 1000,
      channels: 2,
    });
    const output = join(dir, 'whisper.wav');
    await toWav16kMono(input, output);
    const info = await probeMedia(output);
    expect(info.streams[0]).toMatchObject({ codec: 'pcm_s16le', sampleRate: 16_000, channels: 1 });
    expect(info.durationMs).toBeCloseTo(1000, -1);
  });

  it('converts with explicit rate and channel count', async () => {
    const input = await writeTone({ path: join(dir, 'mono.wav'), frequency: 440, durationMs: 500 });
    const output = join(dir, 'converted.wav');
    await convertAudio(input, output, { sampleRate: 22_050, channels: 2 });
    expect((await probeMedia(output)).streams[0]).toMatchObject({
      sampleRate: 22_050,
      channels: 2,
    });
  });

  it('writes WAV files ffprobe accepts', async () => {
    const path = join(dir, 'silent.wav');
    await writeFile(path, silentWav(750));
    expect((await probeMedia(path)).durationMs).toBeCloseTo(750, -1);
    const custom = join(dir, 'custom.wav');
    await writeFile(custom, encodeWav([new Float32Array(8000), new Float32Array(8000)], 8000));
    expect((await probeMedia(custom)).streams[0]).toMatchObject({ channels: 2, sampleRate: 8000 });
  });
});

describe('ffmpegVersion', () => {
  it('reports the installed version', async () => {
    const version = await ffmpegVersion();
    expect(version.version).toMatch(/\d+\.\d+/);
    expect(version.raw).toMatch(/^ffmpeg version/);
  });
});
