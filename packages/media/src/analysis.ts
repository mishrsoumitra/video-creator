import { MediaError } from './errors';
import { assertExists } from './probe';
import { runFfmpeg, type MediaOptions } from './process';

export type LoudnormStats = {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  outputI: number;
  outputTp: number;
  outputLra: number;
  outputThresh: number;
  normalizationType: string;
  targetOffset: number;
};

const num = (value: unknown): number => {
  if (value === '-inf') return Number.NEGATIVE_INFINITY;
  if (value === 'inf' || value === '+inf') return Number.POSITIVE_INFINITY;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
};

/** Parses the JSON block loudnorm prints (print_format=json) at the end of stderr. */
export const parseLoudnormJson = (stderr: string): LoudnormStats => {
  const end = stderr.lastIndexOf('}');
  const start = end === -1 ? -1 : stderr.lastIndexOf('{', end);
  if (start === -1)
    throw new MediaError({ code: 'parse_failed', message: 'loudnorm printed no statistics.' });
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  } catch (error) {
    throw new MediaError({
      code: 'parse_failed',
      message: 'loudnorm statistics were not valid JSON.',
      cause: error,
    });
  }
  return {
    inputI: num(raw.input_i),
    inputTp: num(raw.input_tp),
    inputLra: num(raw.input_lra),
    inputThresh: num(raw.input_thresh),
    outputI: num(raw.output_i),
    outputTp: num(raw.output_tp),
    outputLra: num(raw.output_lra),
    outputThresh: num(raw.output_thresh),
    normalizationType: String(raw.normalization_type ?? ''),
    targetOffset: num(raw.target_offset),
  };
};

/** Runs loudnorm in measurement mode (EBU R128) over a file. */
export const loudnormMeasure = async (
  path: string,
  options: MediaOptions & { filterPrefix?: string } = {},
): Promise<LoudnormStats> => {
  await assertExists(path);
  const filter = `${options.filterPrefix ? `${options.filterPrefix},` : ''}loudnorm=print_format=json`;
  const { stderr } = await runFfmpeg(
    ['-loglevel', 'info', '-nostats', '-i', path, '-af', filter, '-f', 'null', '-'],
    { timeoutMs: 10 * 60_000, ...options },
  );
  return parseLoudnormJson(stderr);
};

export type Loudness = { integratedLufs: number; truePeakDb: number; lra: number };

/** Integrated loudness (LUFS), true peak (dBTP) and loudness range (LU). */
export const measureLoudness = async (
  path: string,
  options: MediaOptions = {},
): Promise<Loudness> => {
  const stats = await loudnormMeasure(path, options);
  return { integratedLufs: stats.inputI, truePeakDb: stats.inputTp, lra: stats.inputLra };
};

/** Streams the file as signed 16-bit PCM through `onSamples`. */
const scanPcm = async (
  path: string,
  args: { sampleRate?: number; channels?: number; filter?: string },
  onSamples: (samples: Int16Array) => void,
  options: MediaOptions,
): Promise<void> => {
  await assertExists(path);
  let carry: Buffer | null = null;
  await runFfmpeg(
    [
      '-i',
      path,
      '-vn',
      ...(args.filter ? ['-af', args.filter] : []),
      ...(args.channels ? ['-ac', String(args.channels)] : []),
      ...(args.sampleRate ? ['-ar', String(args.sampleRate)] : []),
      '-f',
      's16le',
      '-c:a',
      'pcm_s16le',
      '-',
    ],
    {
      timeoutMs: 10 * 60_000,
      ...options,
      onStdout: (chunk) => {
        let data = carry ? Buffer.concat([carry, chunk]) : chunk;
        const usable = data.length - (data.length % 2);
        carry = usable < data.length ? data.subarray(usable) : null;
        data = data.subarray(0, usable);
        if (data.length === 0) return;
        // Copy into an aligned buffer: Int16Array needs an even byte offset.
        const aligned = new Int16Array(data.length / 2);
        for (let i = 0; i < aligned.length; i++) aligned[i] = data.readInt16LE(i * 2);
        onSamples(aligned);
      },
    },
  );
};

export type Clipping = { peakDbfs: number; clippedSamples: number; clipped: boolean };

/** Sample peak and full-scale sample count. Clipped when the peak reaches -0.1 dBFS or any sample is full scale. */
export const measureClipping = async (
  path: string,
  options: MediaOptions = {},
): Promise<Clipping> => {
  let maxAbs = 0;
  let clippedSamples = 0;
  await scanPcm(
    path,
    {},
    (samples) => {
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i]!;
        const a = v < 0 ? -v : v;
        if (a > maxAbs) maxAbs = a;
        if (v >= 32767 || v <= -32768) clippedSamples++;
      }
    },
    options,
  );
  const peakDbfs = maxAbs === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(maxAbs / 32768);
  return { peakDbfs, clippedSamples, clipped: clippedSamples > 0 || peakDbfs >= -0.1 };
};

export type LevelOptions = MediaOptions & {
  /** Low-pass (Hz) before measuring, three cascaded 2-pole filters (≈36 dB/octave). */
  lowpassHz?: number;
  highpassHz?: number;
};

const LEVEL_RATE = 16_000;

/** RMS level in dBFS of the mono downmix, per window. -Infinity for digital silence. */
export const measureLevels = async (
  path: string,
  windowMs: number,
  options: LevelOptions = {},
): Promise<number[]> => {
  if (!(windowMs > 0))
    throw new MediaError({ code: 'invalid_input', message: 'windowMs must be positive.' });
  const filters: string[] = [];
  if (options.highpassHz) filters.push(...Array(3).fill(`highpass=f=${options.highpassHz}`));
  if (options.lowpassHz) filters.push(...Array(3).fill(`lowpass=f=${options.lowpassHz}`));
  const windowSamples = Math.max(1, Math.round((windowMs / 1000) * LEVEL_RATE));
  const levels: number[] = [];
  let sum = 0;
  let count = 0;
  const flush = () => {
    const rms = Math.sqrt(sum / count) / 32768;
    levels.push(rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms));
    sum = 0;
    count = 0;
  };
  await scanPcm(
    path,
    {
      sampleRate: LEVEL_RATE,
      channels: 1,
      ...(filters.length ? { filter: filters.join(',') } : {}),
    },
    (samples) => {
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i]!;
        sum += v * v;
        if (++count === windowSamples) flush();
      }
    },
    options,
  );
  // Keep a trailing partial window only when it is at least half a window long.
  if (count >= windowSamples / 2) flush();
  return levels;
};
