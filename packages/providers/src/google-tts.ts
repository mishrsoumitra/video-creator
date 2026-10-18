import { ProviderError } from '@vc/pipeline';
import { z } from 'zod';
import { httpJson } from './http';
import { splitTextForSpeech } from './text-chunks';
import type { ProviderDefinition } from './types';
import { fromBase64, withSource } from './util';
import { concatPcm, decodeWav, durationSeconds, encodeWav } from './wav';

/** Google Cloud Text-to-Speech. The "model" is the voice name, e.g. en-US-Chirp3-HD-Charon. */

const API = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const ID = 'google-tts';
const MAX_BYTES = 4_800; // the API takes at most 5,000 bytes of input per request
const OFFICIAL =
  'cloud.google.com/text-to-speech/pricing (Standard/WaveNet $4, Neural2/Polyglot $16, Studio $160 per 1M characters)';

const options = z.strictObject({
  languageCode: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})+$/)
    .optional(),
  speakingRate: z.number().min(0.25).max(2).optional(),
});

const VOICE_NAME = /^[a-z]{2,3}-[A-Z]{2,3}-[A-Za-z0-9-]+$/;

export const googleTtsProvider: ProviderDefinition = {
  id: ID,
  label: 'Google Cloud Text-to-Speech',
  kind: 'cloud',
  description:
    'Google Cloud voices (Chirp 3 HD, Neural2, WaveNet); timings come from a separate alignment step.',
  credential: {
    id: 'google-cloud',
    label: 'Google Cloud API key with Text-to-Speech enabled',
    helpUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  allowedHosts: () => ['texttospeech.googleapis.com'],
  roles: {
    voice: {
      role: 'voice',
      label: 'Google Cloud text:synthesize (LINEAR16)',
      defaultModel: 'en-US-Chirp3-HD-Charon',
      suggestedModels: [
        'en-US-Chirp3-HD-Charon',
        'en-US-Chirp3-HD-Aoede',
        'en-US-Neural2-D',
        'en-US-Neural2-F',
        'en-GB-Neural2-B',
        'en-US-Studio-O',
        'en-US-Wavenet-D',
        'en-US-Standard-B',
      ],
      optionsSchema: options,
      validateModel: (model) =>
        VOICE_NAME.test(model)
          ? null
          : `"${model}" is not a Google voice name such as en-US-Neural2-D.`,
      pricing: (model) => {
        if (/Chirp3?-HD/i.test(model))
          return withSource(
            { perMChars: 30 },
            'Chirp 3 HD at $30 per 1M characters (third-party price lists; the Google page did not render, verify)',
          );
        if (/Studio/i.test(model)) return withSource({ perMChars: 160 }, OFFICIAL);
        if (/Neural2|Polyglot/i.test(model)) return withSource({ perMChars: 16 }, OFFICIAL);
        if (/Wavenet|Standard/i.test(model)) return withSource({ perMChars: 4 }, OFFICIAL);
        return null;
      },
      create: (ctx) => {
        const opts = options.parse(ctx.options);
        const languageCode = opts.languageCode ?? ctx.model.split('-').slice(0, 2).join('-');
        return {
          providerId: ID,
          model: ctx.model,
          voiceId: ctx.model,
          returnsTimings: false,
          async synthesize({ text }, callOptions) {
            const chunks = splitTextForSpeech(text, { maxBytes: MAX_BYTES });
            if (chunks.length === 0)
              throw new ProviderError({
                providerId: ID,
                code: 'bad_request',
                message: 'There is no text to speak.',
              });
            const parts = [];
            for (const chunk of chunks) {
              const body = await httpJson<{ audioContent?: string }>(
                API,
                {
                  method: 'POST',
                  headers: {
                    'x-goog-api-key': ctx.apiKey ?? '',
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify({
                    input: { text: chunk },
                    voice: { languageCode, name: ctx.model },
                    audioConfig: {
                      audioEncoding: 'LINEAR16',
                      sampleRateHertz: 24_000,
                      ...(opts.speakingRate !== undefined
                        ? { speakingRate: opts.speakingRate }
                        : {}),
                    },
                  }),
                },
                {
                  providerId: ID,
                  label: 'Google Text-to-Speech',
                  fetch: ctx.fetch,
                  apiKey: ctx.apiKey,
                  timeoutMs: 120_000,
                  ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
                },
              );
              if (!body.audioContent)
                throw new ProviderError({
                  providerId: ID,
                  code: 'invalid_response',
                  retryable: false,
                  message: 'Google Text-to-Speech returned no audio.',
                });
              parts.push(decodeWav(fromBase64(body.audioContent)));
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
