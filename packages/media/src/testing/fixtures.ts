import { writeFile } from 'node:fs/promises';
import { runFfmpeg } from '../process';
import { encodeWav } from '../wav';

export type ToneSegment = { fromMs: number; toMs: number; amplitude: number };

/**
 * Writes a sine tone as 16-bit WAV, computed in JS so levels are exact. Segments set the amplitude
 * over time (anything outside every segment is silence); omit them for a constant tone.
 */
export const writeTone = async ({
  path,
  frequency,
  durationMs,
  amplitude = 0.25,
  segments,
  sampleRate = 48_000,
  channels = 1,
}: {
  path: string;
  frequency: number;
  durationMs: number;
  amplitude?: number;
  segments?: ToneSegment[];
  sampleRate?: number;
  channels?: 1 | 2;
}): Promise<string> => {
  const length = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const tMs = (i / sampleRate) * 1000;
    const gain = segments
      ? (segments.find((s) => tMs >= s.fromMs && tMs < s.toMs)?.amplitude ?? 0)
      : amplitude;
    samples[i] = gain * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  await writeFile(path, encodeWav(channels === 2 ? [samples, samples] : samples, sampleRate));
  return path;
};

/** A square wave at full scale: every sample is ±1, i.e. clipped. */
export const writeClippedSquare = async ({
  path,
  durationMs,
  frequency = 440,
  sampleRate = 48_000,
}: {
  path: string;
  durationMs: number;
  frequency?: number;
  sampleRate?: number;
}) => {
  const length = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++)
    samples[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) >= 0 ? 1.2 : -1.2;
  await writeFile(path, encodeWav(samples, sampleRate));
  return path;
};

/** A short test-pattern video (no audio). */
export const writeTestVideo = async ({
  path,
  durationMs,
  width = 320,
  height = 240,
  fps = 30,
  codec = 'libx264',
}: {
  path: string;
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: 'libx264' | 'libvpx-vp9' | 'prores_ks';
}): Promise<string> => {
  const codecArgs =
    codec === 'libx264'
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
      : codec === 'libvpx-vp9'
        ? [
            '-c:v',
            'libvpx-vp9',
            '-deadline',
            'realtime',
            '-cpu-used',
            '8',
            '-b:v',
            '200k',
            '-pix_fmt',
            'yuv420p',
          ]
        : ['-c:v', 'prores_ks', '-profile:v', '0'];
  await runFfmpeg(
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${width}x${height}:rate=${fps}:duration=${durationMs / 1000}`,
      ...codecArgs,
      path,
    ],
    {},
  );
  return path;
};

/** A solid-colour still image. */
export const writeSolidImage = async ({
  path,
  width,
  height,
  color,
}: {
  path: string;
  width: number;
  height: number;
  color: string;
}) => {
  await runFfmpeg(
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=${width}x${height}`,
      '-frames:v',
      '1',
      '-update',
      '1',
      path,
    ],
    {},
  );
  return path;
};
