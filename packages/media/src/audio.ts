import { MediaError } from './errors';
import { assertExists } from './probe';
import { runFfmpeg, type MediaOptions } from './process';

export type ConvertAudioOptions = MediaOptions & { sampleRate?: number; channels?: number };

/** Decodes any audio ffmpeg reads into 16-bit PCM WAV, optionally resampled / remixed. */
export const convertAudio = async (
  inputPath: string,
  outputPath: string,
  options: ConvertAudioOptions = {},
): Promise<{ outputPath: string }> => {
  await assertExists(inputPath);
  if (
    options.sampleRate !== undefined &&
    !(Number.isInteger(options.sampleRate) && options.sampleRate > 0)
  ) {
    throw new MediaError({
      code: 'invalid_input',
      message: 'sampleRate must be a positive integer.',
    });
  }
  if (
    options.channels !== undefined &&
    !(Number.isInteger(options.channels) && options.channels >= 1 && options.channels <= 8)
  ) {
    throw new MediaError({ code: 'invalid_input', message: 'channels must be between 1 and 8.' });
  }
  await runFfmpeg(
    [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-c:a',
      'pcm_s16le',
      ...(options.sampleRate ? ['-ar', String(options.sampleRate)] : []),
      ...(options.channels ? ['-ac', String(options.channels)] : []),
      '-f',
      'wav',
      outputPath,
    ],
    { timeoutMs: 5 * 60_000, ...options },
  );
  return { outputPath };
};

/** The input whisper.cpp expects: 16 kHz, mono, 16-bit PCM WAV. */
export const toWav16kMono = (inputPath: string, outputPath: string, options: MediaOptions = {}) =>
  convertAudio(inputPath, outputPath, { ...options, sampleRate: 16_000, channels: 1 });

/** Joins audio files end to end (e.g. TTS parts) into one 16-bit mono WAV at `sampleRate` (48 kHz). */
export const concatAudio = async (
  inputPaths: readonly string[],
  outputPath: string,
  options: MediaOptions & { sampleRate?: number } = {},
): Promise<{ outputPath: string }> => {
  if (inputPaths.length === 0)
    throw new MediaError({
      code: 'invalid_input',
      message: 'Concatenation needs at least one input.',
    });
  for (const input of inputPaths) await assertExists(input);
  const sampleRate = options.sampleRate ?? 48_000;
  const normalise = inputPaths
    .map(
      (_, i) =>
        `[${i}:a]aresample=${sampleRate},aformat=sample_fmts=s16:channel_layouts=mono[a${i}]`,
    )
    .join(';');
  const join = `${inputPaths.map((_, i) => `[a${i}]`).join('')}concat=n=${inputPaths.length}:v=0:a=1[out]`;
  await runFfmpeg(
    [
      '-y',
      ...inputPaths.flatMap((p) => ['-i', p]),
      '-filter_complex',
      `${normalise};${join}`,
      '-map',
      '[out]',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      outputPath,
    ],
    { timeoutMs: 10 * 60_000, ...options },
  );
  return { outputPath };
};
