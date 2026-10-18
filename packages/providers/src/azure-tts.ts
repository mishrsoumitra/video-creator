import { ProviderError } from '@vc/pipeline';
import { z } from 'zod';
import { httpBytes } from './http';
import { splitTextForSpeech } from './text-chunks';
import type { ProviderDefinition } from './types';
import { withSource } from './util';
import { concatPcm, decodeWav, durationSeconds, encodeWav } from './wav';

/** Azure AI Speech neural voices over REST (SSML in, RIFF PCM out). The "model" is the voice name. */

const ID = 'azure-tts';
const MAX_CHARS = 3_000;
const SOURCE =
  'about $15 per 1M characters for neural voices, $22 for HD (third-party price lists; the Azure page showed no numbers, verify)';

export const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const options = z.strictObject({
  /** The Speech resource region; it becomes the host name, so only plain region ids are allowed. */
  region: z
    .string()
    .regex(/^[a-z0-9]{2,32}$/, 'Use the Azure region id of your Speech resource, e.g. eastus.'),
  languageCode: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})+$/)
    .optional(),
});

const VOICE_NAME = /^[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z0-9:]+$/;

export const azureTtsProvider: ProviderDefinition = {
  id: ID,
  label: 'Azure AI Speech',
  kind: 'cloud',
  description: 'Azure neural voices; timings come from a separate alignment step.',
  credential: {
    id: 'azure-speech',
    label: 'Azure Speech resource key',
    helpUrl:
      'https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/SpeechServices',
  },
  allowedHosts: (opts) =>
    typeof opts.region === 'string' && /^[a-z0-9]{2,32}$/.test(opts.region)
      ? [`${opts.region}.tts.speech.microsoft.com`]
      : [],
  roles: {
    voice: {
      role: 'voice',
      label: 'Azure neural text-to-speech (REST)',
      defaultModel: 'en-US-AndrewMultilingualNeural',
      suggestedModels: [
        'en-US-AndrewMultilingualNeural',
        'en-US-AvaMultilingualNeural',
        'en-US-BrianMultilingualNeural',
        'en-US-EmmaMultilingualNeural',
        'en-GB-RyanNeural',
        'en-US-JennyNeural',
      ],
      optionsSchema: options,
      validateModel: (model) =>
        VOICE_NAME.test(model)
          ? null
          : `"${model}" is not an Azure voice name such as en-US-JennyNeural.`,
      pricing: (model) => withSource({ perMChars: /DragonHD|:/.test(model) ? 22 : 15 }, SOURCE),
      create: (ctx) => {
        const opts = options.parse(ctx.options);
        const lang = opts.languageCode ?? ctx.model.split('-').slice(0, 2).join('-');
        return {
          providerId: ID,
          model: ctx.model,
          voiceId: ctx.model,
          returnsTimings: false,
          async synthesize({ text }, callOptions) {
            const chunks = splitTextForSpeech(text, { maxChars: MAX_CHARS });
            if (chunks.length === 0)
              throw new ProviderError({
                providerId: ID,
                code: 'bad_request',
                message: 'There is no text to speak.',
              });
            const parts = [];
            for (const chunk of chunks) {
              const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(lang)}"><voice name="${escapeXml(ctx.model)}">${escapeXml(chunk)}</voice></speak>`;
              const { bytes } = await httpBytes(
                `https://${opts.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
                {
                  method: 'POST',
                  headers: {
                    'ocp-apim-subscription-key': ctx.apiKey ?? '',
                    'content-type': 'application/ssml+xml',
                    'x-microsoft-outputformat': 'riff-24khz-16bit-mono-pcm',
                    'user-agent': 'video-creator',
                  },
                  body: ssml,
                },
                {
                  providerId: ID,
                  label: 'Azure Speech',
                  fetch: ctx.fetch,
                  apiKey: ctx.apiKey,
                  timeoutMs: 120_000,
                  ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
                },
              );
              parts.push(decodeWav(bytes));
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
