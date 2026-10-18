import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loudnormMeasure, parseLoudnormJson } from './analysis';
import { MediaError } from './errors';
import { assertExists, probeMedia } from './probe';
import { runFfmpeg, type MediaOptions } from './process';

/*
 * Ducking: the narration is boosted +30 dB and hard-limited at full scale to make a sidechain key
 * whose level is the same however loud the voice is. With peak detection, ratio 20 and the hardest
 * knee, the compressor then reduces the music by (key − threshold) × (1 − 1/20) while anyone speaks.
 * Calibrated against measurements: the key's effective level is −0.95 dBFS, so
 *   threshold_dB = −0.95 − depth / 0.95
 * gives measured ducking within 0.5 dB of the target for steady tones (3–30 dB) and about 1 dB
 * less for syllable-modulated speech.
 */
export const DUCKING_KEY_LEVEL_DB = -0.95;
export const DUCKING_RATIO = 20;
const MIN_THRESHOLD = 0.000976563; // ffmpeg's lower bound for sidechaincompress threshold

export const duckingThreshold = (depthDb: number): number => {
  const thresholdDb = DUCKING_KEY_LEVEL_DB - depthDb / (1 - 1 / DUCKING_RATIO);
  return Math.min(1, Math.max(MIN_THRESHOLD, 10 ** (thresholdDb / 20)));
};

export type DuckingOptions = {
  enabled: boolean;
  depthDb: number;
  attackMs: number;
  releaseMs: number;
};

export type MixGraphParams = {
  musicPresent: boolean;
  narrationVolume: number;
  narrationRate: number;
  musicVolume: number;
  ducking: DuckingOptions;
  /** Output length in seconds (narration length divided by its rate). */
  durationSeconds: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
};

const f6 = (n: number) => n.toFixed(6);
const FORMAT = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

/** The filter_complex for narration [0:a] + optional looped music [1:a] → [out]. */
export const buildMixGraph = (p: MixGraphParams): string => {
  const narration = [
    FORMAT,
    `volume=${f6(p.narrationVolume)}`,
    ...(p.narrationRate !== 1 ? [`atempo=${f6(p.narrationRate)}`] : []),
  ].join(',');
  if (!p.musicPresent) return `[0:a]${narration}[out]`;

  const fadeOutStart = Math.max(0, p.durationSeconds - p.fadeOutSeconds);
  const music = [
    FORMAT,
    `atrim=duration=${f6(p.durationSeconds)}`,
    'asetpts=PTS-STARTPTS',
    `volume=${f6(p.musicVolume)}`,
    `afade=t=in:st=0:d=${f6(p.fadeInSeconds)}`,
    `afade=t=out:st=${f6(fadeOutStart)}:d=${f6(p.fadeOutSeconds)}`,
  ].join(',');
  const mix = 'amix=inputs=2:duration=first:dropout_transition=0:normalize=0';
  const ducks = p.ducking.enabled && p.ducking.depthDb > 0;
  if (!ducks) return `[0:a]${narration}[narr];[1:a]${music}[mus];[narr][mus]${mix}[out]`;

  const compressor = [
    `sidechaincompress=threshold=${f6(duckingThreshold(p.ducking.depthDb))}`,
    `ratio=${DUCKING_RATIO}`,
    `attack=${p.ducking.attackMs}`,
    `release=${p.ducking.releaseMs}`,
    'knee=1',
    'detection=peak',
    'link=maximum',
    'makeup=1',
  ].join(':');
  return [
    `[0:a]${narration},asplit=2[narr][keysrc]`,
    '[keysrc]volume=30dB,alimiter=limit=1:level=disabled:attack=1:release=20[key]',
    `[1:a]${music}[mus]`,
    `[mus][key]${compressor}[ducked]`,
    `[narr][ducked]${mix}[out]`,
  ].join(';');
};

export type NormalizeOptions = MediaOptions & {
  targetLufs: number;
  truePeakDb?: number;
  sampleRate?: number;
  channels?: number;
};

export type NormalizeResult = {
  integratedLufs: number;
  truePeakDb: number;
  normalization: 'linear' | 'dynamic' | 'none';
};

const db = (value: number) => 10 ** (value / 20);

/**
 * Two-pass loudnorm in linear mode. When the gain needed would push peaks past the true-peak
 * target (loudnorm would fall back to dynamic mode), the gain is applied first through a
 * brick-wall limiter, so the second loudnorm pass stays linear.
 */
export const normalizeLoudness = async (
  inputPath: string,
  outputPath: string,
  options: NormalizeOptions,
): Promise<NormalizeResult> => {
  const { targetLufs, truePeakDb = -1.5, sampleRate = 48_000, channels = 2 } = options;
  if (!(targetLufs >= -70 && targetLufs <= -5))
    throw new MediaError({
      code: 'invalid_input',
      message: 'The loudness target must be between -70 and -5 LUFS.',
    });
  if (!(truePeakDb >= -9 && truePeakDb <= 0))
    throw new MediaError({
      code: 'invalid_input',
      message: 'The true-peak target must be between -9 and 0 dBTP.',
    });
  const output = [
    '-ar',
    String(sampleRate),
    '-ac',
    String(channels),
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    outputPath,
  ];

  let measured = await loudnormMeasure(inputPath, options);
  if (!Number.isFinite(measured.inputI)) {
    await runFfmpeg(['-y', '-i', inputPath, ...output], { timeoutMs: 10 * 60_000, ...options });
    return {
      integratedLufs: Number.NEGATIVE_INFINITY,
      truePeakDb: Number.NEGATIVE_INFINITY,
      normalization: 'none',
    };
  }

  let source = inputPath;
  let scratch: string | null = null;
  try {
    const gain = targetLufs - measured.inputI;
    if (measured.inputTp + gain > truePeakDb) {
      scratch = await mkdtemp(join(tmpdir(), 'vc-loudnorm-'));
      source = join(scratch, 'limited.wav');
      const limit = db(truePeakDb - 1);
      await runFfmpeg(
        [
          '-y',
          '-i',
          inputPath,
          '-af',
          `volume=${gain.toFixed(3)}dB,alimiter=limit=${limit.toFixed(6)}:attack=2:release=60:level=disabled`,
          '-c:a',
          'pcm_f32le',
          source,
        ],
        { timeoutMs: 10 * 60_000, ...options },
      );
      measured = await loudnormMeasure(source, options);
    }
    const lra = Math.min(50, Math.max(11, Math.ceil(measured.inputLra + 1)));
    const loudnorm = [
      `loudnorm=I=${targetLufs}`,
      `TP=${truePeakDb}`,
      `LRA=${lra}`,
      `measured_I=${measured.inputI}`,
      `measured_TP=${measured.inputTp}`,
      `measured_LRA=${measured.inputLra}`,
      `measured_thresh=${measured.inputThresh}`,
      `offset=${measured.targetOffset}`,
      'linear=true',
      'print_format=json',
    ].join(':');
    const { stderr } = await runFfmpeg(
      [
        '-loglevel',
        'info',
        '-nostats',
        '-y',
        '-i',
        source,
        '-af',
        `${loudnorm},aresample=${sampleRate}`,
        ...output,
      ],
      {
        timeoutMs: 10 * 60_000,
        ...options,
      },
    );
    const stats = parseLoudnormJson(stderr);
    return {
      integratedLufs: stats.outputI,
      truePeakDb: stats.outputTp,
      normalization: stats.normalizationType === 'linear' ? 'linear' : 'dynamic',
    };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
};

export type MixAudioOptions = MediaOptions & {
  narrationPath: string;
  musicPath: string | null;
  outputPath: string;
  narrationVolume: number;
  /** 1.0 unless the user unlocked the narration rate; atempo keeps the pitch. */
  narrationRate?: number;
  musicVolume: number;
  ducking: DuckingOptions;
  loudnessTargetLufs: number;
  truePeakDb?: number;
  musicFadeInMs?: number;
  musicFadeOutMs?: number;
};

export type MixAudioResult = NormalizeResult & { outputPath: string; durationMs: number };

/**
 * Narration + optional music (looped and trimmed to the narration, faded, ducked under the voice),
 * mixed without normalising, then brought to the loudness target. Output: 48 kHz stereo WAV.
 */
export const mixAudio = async (options: MixAudioOptions): Promise<MixAudioResult> => {
  const rate = options.narrationRate ?? 1;
  if (!(rate >= 0.5 && rate <= 2))
    throw new MediaError({
      code: 'invalid_input',
      message: 'The narration rate must be between 0.5 and 2.',
    });
  if (!(options.narrationVolume >= 0) || !(options.musicVolume >= 0))
    throw new MediaError({ code: 'invalid_input', message: 'Volumes must be zero or more.' });
  await assertExists(options.narrationPath);
  if (options.musicPath) await assertExists(options.musicPath);

  const narration = await probeMedia(options.narrationPath, options);
  const durationSeconds = narration.durationMs / 1000 / rate;
  const fadeInSeconds = Math.min((options.musicFadeInMs ?? 500) / 1000, durationSeconds / 4);
  const fadeOutSeconds = Math.min((options.musicFadeOutMs ?? 1000) / 1000, durationSeconds / 4);
  const graph = buildMixGraph({
    musicPresent: options.musicPath !== null,
    narrationVolume: options.narrationVolume,
    narrationRate: rate,
    musicVolume: options.musicVolume,
    ducking: options.ducking,
    durationSeconds,
    fadeInSeconds,
    fadeOutSeconds,
  });

  const scratch = await mkdtemp(join(tmpdir(), 'vc-mix-'));
  try {
    const premix = join(scratch, 'premix.wav');
    await runFfmpeg(
      [
        '-y',
        '-i',
        options.narrationPath,
        ...(options.musicPath ? ['-stream_loop', '-1', '-i', options.musicPath] : []),
        '-filter_complex',
        graph,
        '-map',
        '[out]',
        '-t',
        durationSeconds.toFixed(6),
        '-c:a',
        'pcm_f32le',
        '-ar',
        '48000',
        premix,
      ],
      { timeoutMs: 10 * 60_000, ...options },
    );
    const normalized = await normalizeLoudness(premix, options.outputPath, {
      ...options,
      targetLufs: options.loudnessTargetLufs,
      ...(options.truePeakDb === undefined ? {} : { truePeakDb: options.truePeakDb }),
    });
    const info = await probeMedia(options.outputPath, options);
    return { ...normalized, outputPath: options.outputPath, durationMs: info.durationMs };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
