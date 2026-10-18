import { join } from 'node:path';
import { ProviderError } from '@vc/pipeline';
import { z } from 'zod';
import { splitTextForSpeech } from './text-chunks';
import type { ProviderDefinition } from './types';
import { FREE_LOCAL } from './util';
import { concatPcm, durationSeconds, encodeWav, floatToPcm16 } from './wav';

/** Kokoro-82M (Apache-2.0) running locally through kokoro-js / ONNX. No key, no cost, no timings. */

const ID = 'kokoro';
const MAX_CHARS = 350; // Kokoro handles about 510 tokens per call; sentences are grouped well below that
const DTYPES = ['fp32', 'fp16', 'q8', 'q4', 'q4f16'] as const;
type Dtype = (typeof DTYPES)[number];

export type KokoroModel = {
  generate(
    text: string,
    options: { voice: string; speed: number },
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

export type KokoroDeps = {
  loadModel(args: { modelId: string; dtype: Dtype; cacheDir: string }): Promise<KokoroModel>;
};

const defaultDeps: KokoroDeps = {
  loadModel: async ({ modelId, dtype, cacheDir }) => {
    const { env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    const { KokoroTTS } = await import('kokoro-js');
    const tts = await KokoroTTS.from_pretrained(modelId, { dtype, device: 'cpu' });
    return {
      generate: (text, opts) => tts.generate(text, opts as Parameters<typeof tts.generate>[1]),
    };
  },
};

const options = z.strictObject({
  voice: z
    .string()
    .regex(/^[a-z]{2}_[a-z]+$/, 'A Kokoro voice id such as af_heart.')
    .default('af_heart'),
  dtype: z.enum(DTYPES).default('q8'),
  speed: z.number().min(0.5).max(2).default(1),
});

const missingPackage = (error: unknown) => {
  const text =
    error instanceof Error
      ? `${error.message} ${(error as { code?: string }).code ?? ''}`
      : String(error);
  return /kokoro-js|@huggingface\/transformers|ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(
    text,
  );
};

export const makeKokoroProvider = (deps: KokoroDeps = defaultDeps): ProviderDefinition => {
  const models = new Map<string, Promise<KokoroModel>>();
  const load = (modelId: string, dtype: Dtype, cacheDir: string) => {
    const key = `${modelId}|${dtype}|${cacheDir}`;
    let model = models.get(key);
    if (!model) {
      model = deps.loadModel({ modelId, dtype, cacheDir });
      models.set(key, model);
      model.catch(() => models.delete(key));
    }
    return model;
  };

  return {
    id: ID,
    label: 'Kokoro (local)',
    kind: 'local',
    description:
      'Kokoro-82M voice running on this machine; the model downloads once (about 90 MB).',
    credential: null,
    allowedHosts: () => [],
    roles: {
      voice: {
        role: 'voice',
        label: 'Kokoro-82M via kokoro-js',
        defaultModel: 'onnx-community/Kokoro-82M-v1.0-ONNX',
        suggestedModels: ['onnx-community/Kokoro-82M-v1.0-ONNX'],
        optionsSchema: options,
        validateModel: (model) =>
          /^[\w.-]+\/[\w.-]+$/.test(model)
            ? null
            : 'Use a Hugging Face model id such as onnx-community/Kokoro-82M-v1.0-ONNX.',
        pricing: () => FREE_LOCAL,
        create: (ctx) => {
          const opts = options.parse(ctx.options);
          const cacheDir = join(ctx.dataDir, 'models', 'kokoro');
          return {
            providerId: ID,
            model: ctx.model,
            voiceId: opts.voice,
            returnsTimings: false,
            async synthesize({ text }, callOptions) {
              const chunks = splitTextForSpeech(text, { maxChars: MAX_CHARS });
              if (chunks.length === 0)
                throw new ProviderError({
                  providerId: ID,
                  code: 'bad_request',
                  message: 'There is no text to speak.',
                });
              let model: KokoroModel;
              try {
                model = await load(ctx.model, opts.dtype, cacheDir);
              } catch (error) {
                throw new ProviderError({
                  providerId: ID,
                  code: missingPackage(error) ? 'unsupported' : 'network',
                  retryable: false,
                  message: missingPackage(error)
                    ? 'The local voice needs the kokoro-js package: run `npm install kokoro-js` and try again.'
                    : `Could not load the Kokoro model: ${error instanceof Error ? error.message : String(error)}`,
                });
              }
              const parts = [];
              for (const chunk of chunks) {
                callOptions?.signal?.throwIfAborted();
                const audio = await model.generate(chunk, { voice: opts.voice, speed: opts.speed });
                parts.push(floatToPcm16(audio.audio, audio.sampling_rate));
              }
              const pcm = concatPcm(parts);
              return {
                value: { audio: encodeWav(pcm), format: 'wav', alignment: null },
                usage: {
                  characters: chunks.join(' ').length,
                  audioSeconds: Math.round(durationSeconds(pcm) * 1000) / 1000,
                },
                model: ctx.model,
              };
            },
          };
        },
      },
    },
  };
};

export const kokoroProvider = makeKokoroProvider();
