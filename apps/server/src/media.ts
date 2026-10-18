import { readFile, rm, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  concatAudio,
  contactSheet,
  convertAudio,
  imageInfo,
  measureClipping,
  mixAudio,
  muxAudioVideo,
  probeMedia,
  samplePixels,
  silentWav,
  toWav16kMono,
} from '@vc/media';
import { analyzeGray, extractPalette, type ImageOps } from '@vc/pipeline';
import { createSafeDownloader } from '@vc/providers';
import type { ServerMedia } from './services';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_THUMB_BYTES = 4 * 1024 * 1024;

/** ffmpeg-backed media for the server, and safe image downloads. */
export const createServerMedia = (
  options: { downloader?: ReturnType<typeof createSafeDownloader> } = {},
): ServerMedia => {
  const downloader = options.downloader ?? createSafeDownloader({ timeoutMs: 30_000 });
  const durationMs = async (path: string) => (await probeMedia(path)).durationMs;

  const imageOps = (jobDir: string): ImageOps => ({
    async download(candidate, name, callOptions) {
      const file = await downloader.download(candidate.url, {
        allowedTypes: IMAGE_TYPES,
        maxBytes: MAX_IMAGE_BYTES,
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      });
      const path = `${jobDir}/${name.slice(0, name.length - extname(name).length)}${EXT[file.contentType] ?? '.jpg'}`;
      await writeFile(path, file.bytes);
      try {
        const { width, height } = await imageInfo(path);
        if (!(width > 0 && height > 0)) throw new Error('no dimensions');
        return { path, width, height };
      } catch {
        await rm(path, { force: true });
        throw new Error(`${candidate.url} is not a readable image.`);
      }
    },
    async thumbnail(candidate, callOptions) {
      const file = await downloader.download(candidate.thumbnailUrl ?? candidate.url, {
        allowedTypes: IMAGE_TYPES,
        maxBytes: candidate.thumbnailUrl ? MAX_THUMB_BYTES : MAX_IMAGE_BYTES,
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      });
      return {
        data: file.bytes,
        mimeType: file.contentType as 'image/jpeg' | 'image/png' | 'image/webp',
      };
    },
    async analyze(path) {
      return analyzeGray(
        await samplePixels(path, { width: 64, height: 36, format: 'gray' }),
        64,
        36,
      );
    },
    async palette(path) {
      return extractPalette(
        await samplePixels(path, { width: 48, height: 27, format: 'rgb24' }),
        48,
        27,
      );
    },
  });

  return {
    probeDurationMs: durationMs,
    async assertAudio(path) {
      try {
        const info = await probeMedia(path);
        if (!info.streams.some((s) => s.type === 'audio') || !(info.durationMs > 0))
          throw new Error('no audio');
        return { durationMs: Math.round(info.durationMs) };
      } catch {
        throw new Error('That file is not audio ffmpeg can read.');
      }
    },
    async mixAudio({ narrationPath, musicPath, audio, outputPath }) {
      const r = await mixAudio({
        narrationPath,
        musicPath,
        outputPath,
        narrationVolume: audio.narrationVolume,
        narrationRate: audio.unlockPlaybackRate ? audio.narrationPlaybackRate : 1,
        musicVolume: audio.music.volume,
        ducking: audio.ducking,
        loudnessTargetLufs: audio.loudnessTargetLufs,
      });
      return { integratedLufs: r.integratedLufs, truePeakDb: r.truePeakDb };
    },
    async mux(args) {
      await muxAudioVideo(args);
    },
    measureClipping: (path) => measureClipping(path),
    async contactSheet(videoPath, outputPath) {
      await contactSheet({ videoPath, outputPath });
      return { data: new Uint8Array(await readFile(outputPath)), mimeType: 'image/png' };
    },
    pipeline: {
      durationMs,
      toWav: async (input, output) => {
        await convertAudio(input, output, { sampleRate: 48_000 });
      },
      concatAudio: async (inputs, output) => {
        await concatAudio(inputs, output);
      },
      toSpeechWav: async (input, output) => {
        await toWav16kMono(input, output);
      },
    },
    imageOps,
    helpers: {
      toWav16kMono: async (input, output) => {
        await toWav16kMono(input, output);
      },
      durationMs,
    },
    async silentWav(path, ms) {
      await writeFile(path, silentWav(ms));
    },
  };
};
