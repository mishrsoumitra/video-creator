import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MediaError } from './errors';
import { assertExists, probeMedia } from './probe';
import { runFfmpeg, type MediaOptions } from './process';

export type Container = 'mp4' | 'webm' | 'mov';

const AUDIO_CODEC: Readonly<Record<Container, string[]>> = {
  mp4: ['-c:a', 'aac', '-b:a', '192k'],
  webm: ['-c:a', 'libopus', '-b:a', '160k'],
  mov: ['-c:a', 'pcm_s16le'],
};

const videoDurationMs = async (path: string, options: MediaOptions) => {
  const info = await probeMedia(path, options);
  const video = info.streams.find((s) => s.type === 'video');
  if (!video)
    throw new MediaError({ code: 'invalid_input', message: `${path} has no video stream.` });
  return video.durationMs ?? info.durationMs;
};

/**
 * Puts the final audio under the rendered video. The video stream is copied untouched; the audio
 * is encoded for the container and padded with silence or trimmed to the exact video length.
 */
export const muxAudioVideo = async (
  options: MediaOptions & {
    videoPath: string;
    audioPath: string;
    outputPath: string;
    container: Container;
  },
): Promise<{ outputPath: string; durationMs: number }> => {
  await assertExists(options.videoPath);
  await assertExists(options.audioPath);
  const duration = await videoDurationMs(options.videoPath, options);
  await runFfmpeg(
    [
      '-y',
      '-i',
      options.videoPath,
      '-i',
      options.audioPath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      ...AUDIO_CODEC[options.container],
      '-ar',
      '48000',
      '-af',
      'apad',
      '-t',
      (duration / 1000).toFixed(6),
      ...(options.container === 'mp4' ? ['-movflags', '+faststart'] : []),
      '-f',
      options.container,
      options.outputPath,
    ],
    { timeoutMs: 10 * 60_000, ...options },
  );
  return {
    outputPath: options.outputPath,
    durationMs: (await probeMedia(options.outputPath, options)).durationMs,
  };
};

/** The concat demuxer's list file, with single quotes escaped. */
export const buildConcatList = (paths: readonly string[]): string => {
  if (paths.length === 0)
    throw new MediaError({
      code: 'invalid_input',
      message: 'Concatenation needs at least one input.',
    });
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'\n`).join('');
};

/** Joins clips that share codec settings (e.g. render chunks) without re-encoding. */
export const concatVideos = async (
  options: MediaOptions & { inputs: readonly string[]; outputPath: string },
): Promise<{ outputPath: string; durationMs: number }> => {
  if (options.inputs.length === 0)
    throw new MediaError({
      code: 'invalid_input',
      message: 'Concatenation needs at least one input.',
    });
  for (const input of options.inputs) await assertExists(input);
  const scratch = await mkdtemp(join(tmpdir(), 'vc-concat-'));
  try {
    const list = join(scratch, 'list.txt');
    await writeFile(list, buildConcatList(options.inputs.map((p) => resolve(p))));
    await runFfmpeg(
      ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', options.outputPath],
      { timeoutMs: 10 * 60_000, ...options },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return {
    outputPath: options.outputPath,
    durationMs: (await probeMedia(options.outputPath, options)).durationMs,
  };
};

/** `count` frame numbers spread evenly over `total` frames (all frames when there are fewer). */
export const selectFrameNumbers = (total: number, count: number): number[] => {
  if (total <= count) return Array.from({ length: Math.max(0, total) }, (_, i) => i);
  return Array.from({ length: count }, (_, i) => Math.floor(((i + 0.5) * total) / count));
};

export type ContactSheetResult = {
  outputPath: string;
  frameNumbers: number[];
  columns: number;
  rows: number;
  width: number;
  height: number;
};

/** A PNG grid of evenly spaced frames, used for the optional final vision check. */
export const contactSheet = async (
  options: MediaOptions & {
    videoPath: string;
    outputPath: string;
    frames?: number;
    columns?: number;
    width?: number;
  },
): Promise<ContactSheetResult> => {
  const { frames = 12, columns = 4, width = 320 } = options;
  if (!(frames >= 1 && columns >= 1 && width >= 2))
    throw new MediaError({
      code: 'invalid_input',
      message: 'frames, columns and width must be positive.',
    });
  await assertExists(options.videoPath);
  const info = await probeMedia(options.videoPath, options);
  const video = info.streams.find((s) => s.type === 'video');
  if (!video?.width || !video.height || !video.frameCount) {
    throw new MediaError({
      code: 'invalid_input',
      message: `${options.videoPath} has no measurable video stream.`,
    });
  }
  const frameNumbers = selectFrameNumbers(video.frameCount, frames);
  const usedColumns = Math.min(columns, frameNumbers.length);
  const rows = Math.ceil(frameNumbers.length / usedColumns);
  const tileHeight = Math.max(2, Math.round((width * video.height) / video.width / 2) * 2);
  const select = frameNumbers.map((n) => `eq(n,${n})`).join('+');
  await runFfmpeg(
    [
      '-y',
      '-i',
      options.videoPath,
      '-vf',
      `select='${select}',scale=${width}:${tileHeight},tile=${usedColumns}x${rows}`,
      '-fps_mode',
      'vfr',
      '-frames:v',
      '1',
      '-update',
      '1',
      options.outputPath,
    ],
    { timeoutMs: 2 * 60_000, ...options },
  );
  return {
    outputPath: options.outputPath,
    frameNumbers,
    columns: usedColumns,
    rows,
    width: usedColumns * width,
    height: rows * tileHeight,
  };
};

/** One frame at a time offset, as PNG/JPEG depending on the output extension. */
export const extractFrame = async (
  options: MediaOptions & { videoPath: string; atMs: number; outputPath: string },
): Promise<{ outputPath: string }> => {
  await assertExists(options.videoPath);
  if (!(options.atMs >= 0))
    throw new MediaError({ code: 'invalid_input', message: 'atMs must be zero or more.' });
  await runFfmpeg(
    [
      '-y',
      '-ss',
      (options.atMs / 1000).toFixed(3),
      '-i',
      options.videoPath,
      '-frames:v',
      '1',
      '-update',
      '1',
      options.outputPath,
    ],
    {
      timeoutMs: 60_000,
      ...options,
    },
  );
  return { outputPath: options.outputPath };
};
