import { runProcess, ffmpegBinary, type MediaOptions } from './process';

/** "ffmpeg version 9.0.2 Copyright …" → "9.0.2"; null when the line is not a version banner. */
export const parseFfmpegVersion = (firstLine: string): string | null =>
  /^ffmpeg version (\S+)/.exec(firstLine.trim())?.[1] ?? null;

/** For health checks: which ffmpeg the app will use. */
export const ffmpegVersion = async (
  options: MediaOptions = {},
): Promise<{ version: string; raw: string }> => {
  const { stdout } = await runProcess(ffmpegBinary(options), ['-version'], {
    timeoutMs: 15_000,
    ...options,
  });
  const raw = stdout.toString('utf8').split('\n')[0]?.trim() ?? '';
  return { version: parseFfmpegVersion(raw) ?? 'unknown', raw };
};
