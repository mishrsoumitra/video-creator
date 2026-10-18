import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialConfig, mergeConfig } from '@vc/config';
import { probeMedia } from '@vc/media';
import { writeSolidImage, writeTestVideo, writeTone } from '@vc/media/testing';
import { candidate } from '@vc/pipeline/testing';
import type { SafeDownload } from '@vc/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { libraryMusic } from './catalogs';
import { createServerMedia } from './media';

/* The server's ffmpeg glue against real ffmpeg: what the fakes in the API tests stand in for. */

let dir: string;
let jpeg: Uint8Array;
let png: Uint8Array;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vc-server-media-'));
  jpeg = new Uint8Array(
    await readFile(
      await writeSolidImage({
        path: join(dir, 'src.jpg'),
        width: 640,
        height: 360,
        color: '#1d4ed8',
      }),
    ),
  );
  png = new Uint8Array(
    await readFile(
      await writeSolidImage({
        path: join(dir, 'src.png'),
        width: 300,
        height: 400,
        color: '#b45309',
      }),
    ),
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

type DownloadCall = { url: string; maxBytes: number; allowedTypes: readonly string[] };
const downloaderFor = (files: Record<string, { contentType: string; bytes: Uint8Array }>) => {
  const calls: DownloadCall[] = [];
  return {
    calls,
    downloader: {
      async download(
        url: string,
        opts: { allowedTypes: readonly string[]; maxBytes: number },
      ): Promise<SafeDownload> {
        calls.push({ url, maxBytes: opts.maxBytes, allowedTypes: opts.allowedTypes });
        const file = files[url];
        if (!file) throw new Error(`404 ${url}`);
        return { url, ...file };
      },
    },
  };
};

describe('uploads', () => {
  it('accepts audio and reports its length', async () => {
    const path = join(dir, 'voice.wav');
    await writeTone({ path, frequency: 220, durationMs: 1500 });
    expect((await createServerMedia().assertAudio(path)).durationMs).toBeGreaterThan(1450);
  });

  it.each([
    ['a text file', async (path: string) => writeFile(path, 'hello')],
    ['a video without sound', async (path: string) => writeTestVideo({ path, durationMs: 500 })],
  ])('refuses %s', async (_name, make) => {
    const path = join(dir, `not-audio-${Math.random().toString(36).slice(2)}.mp4`);
    await make(path);
    await expect(createServerMedia().assertAudio(path)).rejects.toThrow(
      'That file is not audio ffmpeg can read.',
    );
  });
});

describe('scene images', () => {
  it('downloads through the safe downloader, names the file by its real type and reads its size', async () => {
    const { downloader, calls } = downloaderFor({
      'https://img.test/a': { contentType: 'image/jpeg', bytes: jpeg },
      'https://img.test/b': { contentType: 'image/png', bytes: png },
    });
    const ops = createServerMedia({ downloader: downloader as never }).imageOps(dir);
    expect(
      await ops.download(
        candidate({ id: 'a', title: 'Scene a', url: 'https://img.test/a' }),
        'scene-1.jpg',
      ),
    ).toEqual({ path: join(dir, 'scene-1.jpg'), width: 640, height: 360 });
    expect(
      await ops.download(
        candidate({ id: 'b', title: 'Scene b', url: 'https://img.test/b' }),
        'scene-2.jpg',
      ),
    ).toEqual({ path: join(dir, 'scene-2.png'), width: 300, height: 400 });
    expect(calls[0]!.allowedTypes).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(calls[0]!.maxBytes).toBe(20 * 1024 * 1024);
  });

  it('refuses bytes that are not a readable image, and leaves no file behind', async () => {
    const { downloader } = downloaderFor({
      'https://img.test/fake': {
        contentType: 'image/jpeg',
        bytes: new TextEncoder().encode('<html>not an image</html>'),
      },
    });
    const ops = createServerMedia({ downloader: downloader as never }).imageOps(dir);
    await expect(
      ops.download(
        candidate({ id: 'f', title: 'Scene f', url: 'https://img.test/fake' }),
        'scene-9.jpg',
      ),
    ).rejects.toThrow('https://img.test/fake is not a readable image.');
    await expect(access(join(dir, 'scene-9.jpg'))).rejects.toThrow();
  });

  it('fetches the small thumbnail for vision when there is one, with a smaller cap', async () => {
    const { downloader, calls } = downloaderFor({
      'https://img.test/thumb': { contentType: 'image/jpeg', bytes: jpeg },
      'https://img.test/full': { contentType: 'image/png', bytes: png },
    });
    const ops = createServerMedia({ downloader: downloader as never }).imageOps(dir);
    expect(
      await ops.thumbnail(
        candidate({
          id: 't',
          title: 'Scene t',
          url: 'https://img.test/full',
          thumbnailUrl: 'https://img.test/thumb',
        }),
      ),
    ).toMatchObject({ mimeType: 'image/jpeg' });
    expect(calls.at(-1)).toMatchObject({
      url: 'https://img.test/thumb',
      maxBytes: 4 * 1024 * 1024,
    });
    expect(
      await ops.thumbnail(
        candidate({ id: 'u', title: 'Scene u', url: 'https://img.test/full', thumbnailUrl: null }),
      ),
    ).toMatchObject({ mimeType: 'image/png' });
    expect(calls.at(-1)).toMatchObject({
      url: 'https://img.test/full',
      maxBytes: 20 * 1024 * 1024,
    });
  });

  it('pulls a palette and caption-placement stats from the pixels', async () => {
    const ops = createServerMedia().imageOps(dir);
    const palette = await ops.palette(join(dir, 'src.jpg'));
    expect(palette).toHaveLength(5);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(palette[0]!.slice(i, i + 2), 16));
    expect(b! - r!).toBeGreaterThan(100);
    expect(g!).toBeLessThan(120);
    const stats = await ops.analyze(join(dir, 'src.jpg'));
    expect(stats.busyness.bottom).toBeLessThan(0.05);
  });
});

describe('audio', () => {
  it('keeps narration at 1.0 unless the playback rate is unlocked', async () => {
    const narrationPath = join(dir, 'narration.wav');
    await writeTone({ path: narrationPath, frequency: 300, durationMs: 4000 });
    const media = createServerMedia();
    const locked = mergeConfig(initialConfig(), {
      audio: {
        narrationPlaybackRate: 1.25,
        unlockPlaybackRate: false,
        music: { source: 'none', trackId: null },
      },
    });
    await media.mixAudio({
      narrationPath,
      musicPath: null,
      audio: locked.audio,
      outputPath: join(dir, 'locked.wav'),
    });
    expect((await probeMedia(join(dir, 'locked.wav'))).durationMs).toBeCloseTo(4000, -2);

    const unlocked = mergeConfig(locked, { audio: { unlockPlaybackRate: true } });
    await media.mixAudio({
      narrationPath,
      musicPath: null,
      audio: unlocked.audio,
      outputPath: join(dir, 'unlocked.wav'),
    });
    expect((await probeMedia(join(dir, 'unlocked.wav'))).durationMs).toBeCloseTo(3200, -2);
  });

  it('converts, joins and resamples for the pipeline', async () => {
    const media = createServerMedia();
    const a = join(dir, 'a.wav');
    const b = join(dir, 'b.wav');
    await writeTone({ path: a, frequency: 300, durationMs: 1000, sampleRate: 22_050 });
    await writeTone({ path: b, frequency: 500, durationMs: 1500 });
    await media.pipeline.toWav(a, join(dir, 'a48.wav'));
    expect((await probeMedia(join(dir, 'a48.wav'))).streams[0]).toMatchObject({
      type: 'audio',
      sampleRate: 48_000,
    });
    await media.pipeline.concatAudio([a, b], join(dir, 'ab.wav'));
    expect(await media.pipeline.durationMs(join(dir, 'ab.wav'))).toBeCloseTo(2500, -2);
    await media.pipeline.toSpeechWav(b, join(dir, 'b16.wav'));
    expect((await probeMedia(join(dir, 'b16.wav'))).streams[0]).toMatchObject({
      sampleRate: 16_000,
      channels: 1,
    });
  });

  it('writes a silent wav of the asked length for word-timing test calls', async () => {
    await createServerMedia().silentWav(join(dir, 'silence.wav'), 1200);
    expect((await probeMedia(join(dir, 'silence.wav'))).durationMs).toBeCloseTo(1200, -2);
  });
});

describe('library music', () => {
  it('generates a track once per length, even when asked twice at the same moment', async () => {
    const music = libraryMusic(dir);
    const [first, second] = await Promise.all([
      music.pathFor('soft-pad', 3000),
      music.pathFor('soft-pad', 3000),
    ]);
    expect(first).toBe(second);
    const made = (await stat(first)).mtimeMs;
    expect(await music.pathFor('soft-pad', 3000)).toBe(first);
    expect((await stat(first)).mtimeMs).toBe(made);
    const longer = await music.pathFor('soft-pad', 4000);
    expect(longer).not.toBe(first);
    expect((await probeMedia(longer)).durationMs).toBeCloseTo(4000, -2);
  });
});
