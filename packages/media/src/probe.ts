import { stat } from 'node:fs/promises';
import { MediaError } from './errors';
import { runFfprobe, type MediaOptions } from './process';

export type MediaStream = {
  type: 'audio' | 'video';
  codec: string;
  durationMs?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  frameCount?: number;
  sampleRate?: number;
  channels?: number;
};

export type MediaInfo = { durationMs: number; formatName: string; streams: MediaStream[] };

type RawStream = {
  codec_type?: string;
  codec_name?: string;
  duration?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  sample_rate?: string;
  channels?: number;
};

const ratio = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const [num, den] = value.split('/').map(Number);
  if (!num || !den || !Number.isFinite(num / den)) return undefined;
  return Math.round((num / den) * 1000) / 1000;
};

const ms = (seconds: string | undefined): number | undefined => {
  const value = Number(seconds);
  return seconds !== undefined && Number.isFinite(value) ? Math.round(value * 1000) : undefined;
};

export const assertExists = async (path: string): Promise<void> => {
  try {
    await stat(path);
  } catch {
    throw new MediaError({ code: 'not_found', message: `File not found: ${path}` });
  }
};

/** Duration, container and audio/video streams of a media file (ffprobe). */
export const probeMedia = async (path: string, options: MediaOptions = {}): Promise<MediaInfo> => {
  await assertExists(path);
  const { stdout } = await runFfprobe(
    ['-print_format', 'json', '-show_format', '-show_streams', path],
    { timeoutMs: 30_000, ...options },
  );
  let parsed: { format?: { duration?: string; format_name?: string }; streams?: RawStream[] };
  try {
    parsed = JSON.parse(stdout.toString('utf8')) as typeof parsed;
  } catch (error) {
    throw new MediaError({
      code: 'parse_failed',
      message: `ffprobe returned unreadable output for ${path}.`,
      cause: error,
    });
  }
  const streams: MediaStream[] = (parsed.streams ?? [])
    .filter((s) => s.codec_type === 'audio' || s.codec_type === 'video')
    .map((s) => {
      const stream: MediaStream = {
        type: s.codec_type as 'audio' | 'video',
        codec: s.codec_name ?? 'unknown',
      };
      const duration = ms(s.duration);
      if (duration !== undefined) stream.durationMs = duration;
      if (s.codec_type === 'video') {
        if (s.width !== undefined) stream.width = s.width;
        if (s.height !== undefined) stream.height = s.height;
        const fps = ratio(s.avg_frame_rate) ?? ratio(s.r_frame_rate);
        if (fps !== undefined) stream.frameRate = fps;
        const frames = Number(s.nb_frames);
        if (s.nb_frames !== undefined && Number.isInteger(frames) && frames > 0)
          stream.frameCount = frames;
        else if (fps !== undefined && duration !== undefined)
          stream.frameCount = Math.round((duration / 1000) * fps);
      } else {
        const rate = Number(s.sample_rate);
        if (Number.isFinite(rate) && rate > 0) stream.sampleRate = rate;
        if (s.channels !== undefined) stream.channels = s.channels;
      }
      return stream;
    });
  if (streams.length === 0)
    throw new MediaError({
      code: 'invalid_input',
      message: `${path} has no audio or video stream.`,
    });
  return {
    durationMs:
      ms(parsed.format?.duration) ?? Math.max(0, ...streams.map((s) => s.durationMs ?? 0)),
    formatName: parsed.format?.format_name ?? 'unknown',
    streams,
  };
};

/** Pixel size of a still image (or the first video stream). */
export const imageInfo = async (
  path: string,
  options: MediaOptions = {},
): Promise<{ width: number; height: number }> => {
  const info = await probeMedia(path, options);
  const video = info.streams.find((s) => s.type === 'video');
  if (!video?.width || !video.height)
    throw new MediaError({ code: 'invalid_input', message: `${path} is not an image.` });
  return { width: video.width, height: video.height };
};
