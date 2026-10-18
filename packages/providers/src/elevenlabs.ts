import { ProviderError, type CharacterAlignment } from '@vc/pipeline';
import { z } from 'zod';
import { httpJson } from './http';
import { splitTextForSpeech } from './text-chunks';
import type { ProviderDefinition } from './types';
import { fromBase64, withSource } from './util';
import { concatPcm, durationSeconds, encodeWav, pcm16FromBytes, type Pcm16 } from './wav';

/**
 * ElevenLabs text-to-speech /with-timestamps: audio and character timings in the same call, so no
 * separate alignment step is needed. Audio is requested as raw 24 kHz PCM, which makes joining
 * chunks and offsetting their timings exact.
 */

const API = 'https://api.elevenlabs.io/v1/text-to-speech';
const ID = 'elevenlabs';
const SAMPLE_RATE = 24_000;
const SOURCE = 'elevenlabs.io/pricing/api (pay-as-you-go API), checked 2026-10-18';

/** Characters per request by model (ElevenLabs model docs); unknown models get the common 10,000. */
const MAX_CHARS: Readonly<Record<string, number>> = {
  eleven_v3: 5_000,
  eleven_flash_v2_5: 40_000,
  eleven_flash_v2: 30_000,
};
const chunkLimit = (model: string) => Math.floor((MAX_CHARS[model] ?? 10_000) * 0.9);

const options = z.strictObject({
  /** A premade voice ("George"); any voice id from the user's library works. */
  voiceId: z
    .string()
    .regex(/^[A-Za-z0-9]{8,64}$/, 'An ElevenLabs voice id is 8-64 letters and digits.')
    .default('JBFqnCBsd6RMkjVDRZzb'),
  stability: z.number().min(0).max(1).optional(),
  similarityBoost: z.number().min(0).max(1).optional(),
  languageCode: z
    .string()
    .regex(/^[a-z]{2,3}$/)
    .optional(),
});

type TimestampsBody = {
  audio_base64?: string;
  alignment?: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  } | null;
};

export const elevenlabsProvider: ProviderDefinition = {
  id: ID,
  label: 'ElevenLabs',
  kind: 'cloud',
  description: 'Natural voices with word timings in the same call (no separate alignment needed).',
  credential: {
    id: 'elevenlabs',
    label: 'ElevenLabs API key',
    helpUrl: 'https://elevenlabs.io/app/settings/api-keys',
    hint: /^sk_/,
  },
  allowedHosts: () => ['api.elevenlabs.io'],
  roles: {
    voice: {
      role: 'voice',
      label: 'ElevenLabs text-to-speech with timestamps',
      defaultModel: 'eleven_multilingual_v2',
      suggestedModels: [
        'eleven_multilingual_v2',
        'eleven_v4',
        'eleven_v3',
        'eleven_flash_v2_5',
        'eleven_v4_turbo',
      ],
      optionsSchema: options,
      pricing: (model) => {
        if (/flash|turbo|conversational/.test(model)) return withSource({ perMChars: 40 }, SOURCE);
        if (/^eleven_(v4|v3|multilingual)/.test(model))
          return withSource({ perMChars: 80 }, SOURCE);
        return null;
      },
      create: (ctx) => {
        const opts = options.parse(ctx.options);
        const settings =
          opts.stability !== undefined || opts.similarityBoost !== undefined
            ? {
                voice_settings: {
                  ...(opts.stability !== undefined ? { stability: opts.stability } : {}),
                  ...(opts.similarityBoost !== undefined
                    ? { similarity_boost: opts.similarityBoost }
                    : {}),
                },
              }
            : {};
        return {
          providerId: ID,
          model: ctx.model,
          voiceId: opts.voiceId,
          returnsTimings: true,
          async synthesize({ text }, callOptions) {
            const chunks = splitTextForSpeech(text, { maxChars: chunkLimit(ctx.model) });
            if (chunks.length === 0)
              throw new ProviderError({
                providerId: ID,
                code: 'bad_request',
                message: 'There is no text to speak.',
              });
            const parts: Pcm16[] = [];
            const alignment: CharacterAlignment = {
              characters: [],
              startTimesSeconds: [],
              endTimesSeconds: [],
            };
            let complete = true;
            let offset = 0;
            for (const [i, chunk] of chunks.entries()) {
              const body = await httpJson<TimestampsBody>(
                `${API}/${opts.voiceId}/with-timestamps?output_format=pcm_${SAMPLE_RATE}`,
                {
                  method: 'POST',
                  headers: {
                    'xi-api-key': ctx.apiKey ?? '',
                    'content-type': 'application/json',
                    accept: 'application/json',
                  },
                  body: JSON.stringify({
                    text: chunk,
                    model_id: ctx.model,
                    ...(i > 0 ? { previous_text: chunks[i - 1] } : {}),
                    ...(i + 1 < chunks.length ? { next_text: chunks[i + 1] } : {}),
                    ...(opts.languageCode ? { language_code: opts.languageCode } : {}),
                    ...settings,
                  }),
                },
                {
                  providerId: ID,
                  label: 'ElevenLabs',
                  fetch: ctx.fetch,
                  apiKey: ctx.apiKey,
                  timeoutMs: 180_000,
                  ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
                },
              );
              if (!body.audio_base64)
                throw new ProviderError({
                  providerId: ID,
                  code: 'invalid_response',
                  retryable: false,
                  message: 'ElevenLabs returned no audio.',
                });
              const pcm = pcm16FromBytes(fromBase64(body.audio_base64), SAMPLE_RATE, 1);
              const a = body.alignment;
              if (
                a &&
                a.characters.length === a.character_start_times_seconds.length &&
                a.characters.length === a.character_end_times_seconds.length
              ) {
                if (i > 0) {
                  alignment.characters.push(' ');
                  alignment.startTimesSeconds.push(offset);
                  alignment.endTimesSeconds.push(offset);
                }
                alignment.characters.push(...a.characters);
                alignment.startTimesSeconds.push(
                  ...a.character_start_times_seconds.map((t) => t + offset),
                );
                alignment.endTimesSeconds.push(
                  ...a.character_end_times_seconds.map((t) => t + offset),
                );
              } else {
                complete = false;
              }
              parts.push(pcm);
              offset += durationSeconds(pcm);
            }
            const pcm = concatPcm(parts);
            return {
              value: {
                audio: encodeWav(pcm),
                format: 'wav',
                alignment: complete ? alignment : null,
              },
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
