import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caption } from '@remotion/captions';
import {
  downloadWhisperModel,
  installWhisperCpp,
  toCaptions,
  transcribe,
  type Language,
  type TranscriptionJson,
  type WhisperModel,
} from '@remotion/install-whisper-cpp';
import { ProviderError } from '@vc/pipeline';
import { z } from 'zod';
import type { ProviderDefinition } from './types';
import { FREE_LOCAL } from './util';

/** whisper.cpp on this machine (via @remotion/install-whisper-cpp): local word timings, no key. */

const ID = 'whisper-cpp';
const WHISPER_MODELS = [
  'tiny',
  'tiny.en',
  'base',
  'base.en',
  'small',
  'small.en',
  'medium',
  'medium.en',
  'large-v1',
  'large-v2',
  'large-v3',
  'large-v3-turbo',
] as const;

export type WhisperCppDeps = {
  /** Unix builds clone and `make` whisper.cpp, which needs git, make and cmake. */
  hasBuildTools(): Promise<boolean>;
  installWhisperCpp(args: {
    version: string;
    to: string;
    printOutput: boolean;
    signal?: AbortSignal | null;
  }): Promise<{ alreadyExisted: boolean }>;
  downloadWhisperModel(args: {
    model: WhisperModel;
    folder: string;
    printOutput: boolean;
    signal?: AbortSignal;
  }): Promise<{ alreadyExisted: boolean }>;
  transcribe(args: {
    inputPath: string;
    whisperPath: string;
    whisperCppVersion: string;
    model: WhisperModel;
    modelFolder: string;
    tokenLevelTimestamps: true;
    splitOnWord: boolean;
    printOutput: boolean;
    language: Language | null;
    signal?: AbortSignal;
  }): Promise<TranscriptionJson<true>>;
  toCaptions(args: { whisperCppOutput: TranscriptionJson<true> }): { captions: Caption[] };
};

const which = (tool: string) =>
  new Promise<boolean>((resolve) => execFile('which', [tool], (error) => resolve(!error)));

const defaultDeps: WhisperCppDeps = {
  hasBuildTools: async () =>
    process.platform === 'win32' ||
    (await Promise.all(['git', 'make', 'cmake'].map(which))).every(Boolean),
  installWhisperCpp: (args) => installWhisperCpp({ ...args, signal: args.signal ?? null }),
  downloadWhisperModel: (args) => downloadWhisperModel(args),
  transcribe: (args) => transcribe(args),
  toCaptions: (args) => toCaptions(args),
};

const options = z.strictObject({
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default('1.7.6'),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
});

const unsupported = (message: string) =>
  new ProviderError({ providerId: ID, code: 'unsupported', retryable: false, message });

export const makeWhisperCppProvider = (deps: WhisperCppDeps = defaultDeps): ProviderDefinition => ({
  id: ID,
  label: 'whisper.cpp (local)',
  kind: 'local',
  description:
    'Word timings computed on this machine; installs whisper.cpp and a model on first use.',
  credential: null,
  allowedHosts: () => [],
  roles: {
    align: {
      role: 'align',
      label: 'whisper.cpp with token-level timestamps',
      defaultModel: 'base.en',
      suggestedModels: [
        'base.en',
        'small.en',
        'tiny.en',
        'medium.en',
        'large-v3-turbo',
        'base',
        'small',
      ],
      optionsSchema: options,
      validateModel: (model) =>
        (WHISPER_MODELS as readonly string[]).includes(model)
          ? null
          : `whisper.cpp models are ${WHISPER_MODELS.join(', ')}.`,
      pricing: () => FREE_LOCAL,
      create: (ctx) => {
        const opts = options.parse(ctx.options);
        const root = join(ctx.dataDir, 'whisper.cpp');
        const installDir = join(root, opts.version);
        const modelFolder = join(root, 'models');
        const model = ctx.model as WhisperModel;
        return {
          providerId: ID,
          model: ctx.model,
          async align({ audioPath, language }, callOptions) {
            const media = ctx.media;
            if (!media)
              throw unsupported(
                'Local word timing needs ffmpeg to convert audio to 16 kHz WAV, and no converter was provided.',
              );
            const signal = callOptions?.signal;
            if (!existsSync(installDir) && !(await deps.hasBuildTools())) {
              throw unsupported(
                'Installing whisper.cpp needs git, make and cmake (e.g. `brew install cmake`). Install them, or choose OpenAI whisper-1 for word timing.',
              );
            }
            try {
              await deps.installWhisperCpp({
                version: opts.version,
                to: installDir,
                printOutput: false,
                ...(signal ? { signal } : {}),
              });
              await deps.downloadWhisperModel({
                model,
                folder: modelFolder,
                printOutput: false,
                ...(signal ? { signal } : {}),
              });
            } catch (error) {
              if (signal?.aborted) throw signal.reason;
              throw unsupported(
                `Could not set up whisper.cpp ${opts.version}: ${error instanceof Error ? error.message : String(error)}. Delete ${installDir} to retry, or choose OpenAI whisper-1.`,
              );
            }
            const temp = await mkdtemp(join(tmpdir(), 'vc-whisper-cpp-'));
            try {
              const wav = join(temp, 'audio-16k.wav');
              await media.toWav16kMono(audioPath, wav);
              const output = await deps.transcribe({
                inputPath: wav,
                whisperPath: installDir,
                whisperCppVersion: opts.version,
                model,
                modelFolder,
                tokenLevelTimestamps: true,
                splitOnWord: true,
                printOutput: false,
                language: (model.endsWith('.en')
                  ? 'en'
                  : (language ?? opts.language ?? null)) as Language | null,
                ...(signal ? { signal } : {}),
              });
              const words = deps
                .toCaptions({ whisperCppOutput: output })
                .captions.map((c) => ({
                  text: c.text.trim(),
                  startMs: Math.round(c.startMs),
                  endMs: Math.round(c.endMs),
                  confidence: c.confidence,
                }))
                .filter((w) => w.text.length > 0);
              return {
                value: words,
                usage: { audioSeconds: (await media.durationMs(audioPath)) / 1000 },
                model: ctx.model,
              };
            } finally {
              await rm(temp, { recursive: true, force: true });
            }
          },
        };
      },
    },
  },
});

export const whisperCppProvider = makeWhisperCppProvider();
