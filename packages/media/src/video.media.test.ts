import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  concatVideos,
  contactSheet,
  extractFrame,
  imageInfo,
  muxAudioVideo,
  probeMedia,
  samplePixels,
} from './index';
import { writeSolidImage, writeTestVideo, writeTone } from './testing';

let dir: string;
let video2s: string;
let video3s: string;
let audioLong: string;
let audioShort: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vc-media-video-it's-"));
  video2s = await writeTestVideo({ path: join(dir, 'two.mp4'), durationMs: 2000 });
  video3s = await writeTestVideo({ path: join(dir, 'three.mp4'), durationMs: 3000 });
  audioLong = await writeTone({
    path: join(dir, 'long.wav'),
    frequency: 440,
    durationMs: 4000,
    channels: 2,
  });
  audioShort = await writeTone({
    path: join(dir, 'short.wav'),
    frequency: 440,
    durationMs: 1000,
    channels: 2,
  });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const streamDuration = async (path: string, type: 'audio' | 'video') => {
  const info = await probeMedia(path);
  return info.streams.find((s) => s.type === type)!.durationMs!;
};

describe('muxAudioVideo', () => {
  it('copies the video stream and trims longer audio to the video length (mp4 + AAC)', async () => {
    const out = join(dir, 'muxed.mp4');
    const result = await muxAudioVideo({
      videoPath: video2s,
      audioPath: audioLong,
      outputPath: out,
      container: 'mp4',
    });
    const info = await probeMedia(out);
    expect(info.streams.map((s) => [s.type, s.codec])).toEqual([
      ['video', 'h264'],
      ['audio', 'aac'],
    ]);
    expect(Math.abs(result.durationMs - 2000)).toBeLessThan(100);
    expect(Math.abs((await streamDuration(out, 'audio')) - 2000)).toBeLessThan(100);
  });

  it('pads shorter audio with silence to the video length', async () => {
    const out = join(dir, 'padded.mp4');
    await muxAudioVideo({
      videoPath: video2s,
      audioPath: audioShort,
      outputPath: out,
      container: 'mp4',
    });
    expect(Math.abs((await streamDuration(out, 'audio')) - 2000)).toBeLessThan(100);
  });

  it('uses Opus in WebM and PCM in MOV', async () => {
    const webmVideo = await writeTestVideo({
      path: join(dir, 'clip.webm'),
      durationMs: 1000,
      codec: 'libvpx-vp9',
    });
    const webm = join(dir, 'muxed.webm');
    await muxAudioVideo({
      videoPath: webmVideo,
      audioPath: audioLong,
      outputPath: webm,
      container: 'webm',
    });
    expect((await probeMedia(webm)).streams.map((s) => s.codec)).toEqual(['vp9', 'opus']);

    const movVideo = await writeTestVideo({
      path: join(dir, 'clip.mov'),
      durationMs: 1000,
      codec: 'prores_ks',
    });
    const mov = join(dir, 'muxed.mov');
    await muxAudioVideo({
      videoPath: movVideo,
      audioPath: audioLong,
      outputPath: mov,
      container: 'mov',
    });
    expect((await probeMedia(mov)).streams.map((s) => s.codec)).toEqual(['prores', 'pcm_s16le']);
  });
});

describe('concatVideos', () => {
  it('joins clips with stream copy; the duration is the sum (paths with quotes are escaped)', async () => {
    const out = join(dir, 'joined.mp4');
    const result = await concatVideos({ inputs: [video2s, video3s], outputPath: out });
    expect(Math.abs(result.durationMs - 5000)).toBeLessThan(100);
    expect((await probeMedia(out)).streams[0]).toMatchObject({
      codec: 'h264',
      width: 320,
      height: 240,
    });
  });

  it('refuses an empty list', async () => {
    await expect(
      concatVideos({ inputs: [], outputPath: join(dir, 'none.mp4') }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('contactSheet and frames', () => {
  it('tiles 12 evenly spaced frames into a 4 × 3 grid', async () => {
    const out = join(dir, 'sheet.png');
    const result = await contactSheet({ videoPath: video3s, outputPath: out });
    expect(result.frameNumbers).toHaveLength(12);
    expect(await imageInfo(out)).toEqual({ width: 4 * 320, height: 3 * 240 });
    expect(result).toMatchObject({ width: 1280, height: 720, columns: 4, rows: 3 });
  });

  it('honours frames, columns and width', async () => {
    const out = join(dir, 'sheet-small.png');
    await contactSheet({ videoPath: video2s, outputPath: out, frames: 6, columns: 3, width: 160 });
    expect(await imageInfo(out)).toEqual({ width: 3 * 160, height: 2 * 120 });
  });

  it('extracts a single frame at a time', async () => {
    const out = join(dir, 'frame.png');
    await extractFrame({ videoPath: video2s, atMs: 1000, outputPath: out });
    expect(await imageInfo(out)).toEqual({ width: 320, height: 240 });
  });
});

describe('samplePixels', () => {
  it('downsamples an image to raw grey or RGB pixels', async () => {
    const path = await writeSolidImage({
      path: join(dir, 'red.png'),
      width: 640,
      height: 360,
      color: 'red',
    });
    const gray = await samplePixels(path, { width: 32, height: 18, format: 'gray' });
    expect(gray).toHaveLength(32 * 18);
    const rgb = await samplePixels(path, { width: 32, height: 18, format: 'rgb24' });
    expect(rgb).toHaveLength(32 * 18 * 3);
    expect(rgb[0]).toBeGreaterThan(240);
    expect(rgb[1]).toBeLessThan(15);
    expect(rgb[2]).toBeLessThan(15);
  });
});
