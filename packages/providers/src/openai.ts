import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openAiWhisperApiToCaptions } from '@remotion/openai-whisper';
import {
  ProviderError,
  type SearchResult,
  type TimedWord,
  type UnitPrices,
  type VisionImage,
} from '@vc/pipeline';
import { z } from 'zod';
import { httpBytes, httpJson, invalidResponse, type HttpOptions } from './http';
import { splitTextForSpeech } from './text-chunks';
import type { AdapterContext, ProviderDefinition } from './types';
import { audioMimeType, lookupByModel, toBase64, withSource } from './util';
import { concatPcm, durationSeconds, encodeWav, pcm16FromBytes } from './wav';

/*
 * OpenAI. Text, search and vision use the Responses API: it is OpenAI's API for new integrations and
 * the only one with the GA `web_search` tool (filters, source lists), so one request shape serves
 * three roles. Voice uses /audio/speech; word timing uses whisper-1, the only transcription model
 * with word timestamps.
 */

const API = 'https://api.openai.com/v1';
const ID = 'openai';
const LABEL = 'OpenAI';
const SOURCE = 'developers.openai.com/api/docs/pricing, checked 2026-10-18';
const MAX_SPEECH_CHARS = 4000; // the speech endpoint takes at most 4,096 characters
const SPEECH_SAMPLE_RATE = 24_000; // response_format=pcm is 24 kHz 16-bit mono
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const JSON_INSTRUCTION = 'Respond with a single JSON object.';

/** USD per 1M tokens [input, output], standard tier, short context. */
const TOKEN_PRICES: Readonly<Record<string, readonly [number, number]>> = {
  'gpt-6-astra': [10, 50],
  'gpt-6.1-sol': [2, 10],
  'gpt-6-sol': [2, 10],
  'gpt-6-luna': [0.1, 0.5],
  'gpt-5.6-sol': [4, 20],
  'gpt-5.6-terra': [2, 12],
  'gpt-5.6-luna': [0.2, 1.2],
  'gpt-5.5': [5, 30],
  'gpt-5.4': [2.5, 15],
  'gpt-5.4-mini': [0.75, 4.5],
  'gpt-5.4-nano': [0.2, 1.25],
  'gpt-5.2': [1.75, 14],
  'gpt-5.1': [1.25, 10],
  'gpt-5': [1.25, 10],
  'gpt-5-mini': [0.25, 2],
  'gpt-5-nano': [0.05, 0.4],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
  'gpt-4o': [2.5, 10],
  'gpt-4o-2024-05-13': [5, 15],
  'gpt-4o-mini': [0.15, 0.6],
  o3: [2, 8],
  'o4-mini': [1.1, 4.4],
};

const tokenPricing = (model: string, extra: UnitPrices = {}): UnitPrices | null => {
  const price = lookupByModel(TOKEN_PRICES, model);
  return price
    ? withSource({ inputPerMTok: price[0], outputPerMTok: price[1], ...extra }, SOURCE)
    : null;
};

const TEXT_MODELS = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-luna',
  'gpt-5.6-terra',
  'gpt-5.5',
  'gpt-5.4-mini',
  'gpt-4.1-mini',
] as const;
const VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;
/** Voices tts-1 and tts-1-hd do not have. */
const NEWER_VOICES = new Set(['ballad', 'verse', 'marin', 'cedar']);

const isReasoningModel = (model: string) => /^(o\d|gpt-5|gpt-6)/.test(model);
const REASONING_HEADROOM = { low: 2048, medium: 8192, high: 16384 } as const;

const effort = z.enum(['low', 'medium', 'high']);
const textOptions = z.strictObject({ reasoningEffort: effort.optional() });
const searchOptions = z.strictObject({
  reasoningEffort: effort.optional(),
  searchContextSize: z.enum(['low', 'medium', 'high']).optional(),
});
const voiceOptions = z.strictObject({
  voice: z.enum(VOICES).default('marin'),
  instructions: z
    .string()
    .max(1000)
    .default('Narrate clearly and warmly, like a documentary narrator, at a natural pace.'),
  speed: z.number().min(0.25).max(4).optional(),
});

const headers = (apiKey: string | null, json = true): Record<string, string> => ({
  authorization: `Bearer ${apiKey ?? ''}`,
  ...(json ? { 'content-type': 'application/json' } : {}),
});

const http = (
  ctx: AdapterContext,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): HttpOptions => ({
  providerId: ID,
  label: LABEL,
  fetch: ctx.fetch,
  apiKey: ctx.apiKey,
  timeoutMs,
  ...(signal ? { signal } : {}),
});

type Annotation = {
  type: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
};
type OutputItem = {
  type: string;
  content?: Array<{ type: string; text?: string; refusal?: string; annotations?: Annotation[] }>;
  action?: { type?: string; sources?: Array<{ type?: string; url?: string }> };
};
type ResponsesBody = {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: OutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

const maxOutput = (model: string, requested: number, level: z.infer<typeof effort> | undefined) =>
  isReasoningModel(model)
    ? Math.min(128_000, requested + REASONING_HEADROOM[level ?? 'medium'])
    : requested;

const responses = (ctx: AdapterContext, body: Record<string, unknown>, signal?: AbortSignal) =>
  httpJson<ResponsesBody>(
    `${API}/responses`,
    {
      method: 'POST',
      headers: headers(ctx.apiKey),
      body: JSON.stringify({ store: false, ...body }),
    },
    http(ctx, signal, 300_000),
  );

const messageParts = (body: ResponsesBody) =>
  (body.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? []);

const outputText = (body: ResponsesBody): string => {
  const parts = messageParts(body);
  const text = parts
    .filter((p) => p.type === 'output_text')
    .map((p) => p.text ?? '')
    .join('');
  if (text.trim()) return text;
  const refusal = parts.find((p) => p.type === 'refusal')?.refusal;
  if (refusal) throw invalidResponse(ID, `OpenAI declined the request: ${refusal}`);
  if (body.status === 'incomplete')
    throw invalidResponse(
      ID,
      `OpenAI stopped before answering (${body.incomplete_details?.reason ?? 'incomplete'}).`,
    );
  throw invalidResponse(ID, 'OpenAI returned no text.');
};

const tokenUsage = (body: ResponsesBody) => ({
  inputTokens: body.usage?.input_tokens ?? 0,
  outputTokens: body.usage?.output_tokens ?? 0,
});

/** The sentence of `text` that contains [start, end). */
const sentenceAround = (text: string, start: number, end: number): string => {
  let s = Math.max(0, Math.min(start, text.length));
  while (s < text.length && /\s/.test(text[s]!)) s++;
  while (s > 1 && !(/\s/.test(text[s - 1]!) && /[.!?]/.test(text[s - 2]!))) s--;
  if (s === 1) s = 0;
  let e = Math.max(s, Math.min(end, text.length) - 1);
  while (e < text.length - 1 && !/[.!?]/.test(text[e]!)) e++;
  return text.slice(s, e + 1).trim();
};

const searchResults = (body: ResponsesBody, maxResults: number): SearchResult[] => {
  const byUrl = new Map<string, SearchResult>();
  for (const part of messageParts(body)) {
    for (const note of part.annotations ?? []) {
      if (note.type !== 'url_citation' || !note.url || byUrl.has(note.url)) continue;
      const snippet =
        part.text && note.start_index !== undefined && note.end_index !== undefined
          ? sentenceAround(part.text, note.start_index, note.end_index)
          : '';
      byUrl.set(note.url, {
        url: note.url,
        title: note.title?.trim() || new URL(note.url).hostname,
        ...(snippet ? { snippet } : {}),
      });
    }
  }
  for (const item of body.output ?? []) {
    for (const source of item.action?.sources ?? []) {
      if (!source.url || byUrl.has(source.url)) continue;
      byUrl.set(source.url, { url: source.url, title: new URL(source.url).hostname });
    }
  }
  return [...byUrl.values()].slice(0, maxResults);
};

const dataUrl = (image: VisionImage) => `data:${image.mimeType};base64,${toBase64(image.data)}`;

type WhisperVerbose = {
  duration?: number | string;
  text?: string;
  words?: Array<{ word: string; start: number; end: number }>;
};

const whisperWords = (body: WhisperVerbose): TimedWord[] => {
  const round = (ms: number) => Math.round(ms);
  let words: TimedWord[];
  try {
    words = openAiWhisperApiToCaptions({ transcription: body }).captions.map((c) => ({
      text: c.text.trim(),
      startMs: round(c.startMs),
      endMs: round(c.endMs),
      confidence: null,
    }));
  } catch {
    words = (body.words ?? []).map((w) => ({
      text: w.word.trim(),
      startMs: round(w.start * 1000),
      endMs: round(w.end * 1000),
      confidence: null,
    }));
  }
  words = words.filter((w) => w.text.length > 0);
  if (words.length === 0) throw invalidResponse(ID, 'whisper-1 returned no word timestamps.');
  return words;
};

export const openaiProvider: ProviderDefinition = {
  id: ID,
  label: LABEL,
  kind: 'cloud',
  description:
    'GPT models for scripts, web search and image checks; TTS voices; whisper-1 word timings.',
  credential: {
    id: 'openai',
    label: 'OpenAI API key',
    helpUrl: 'https://platform.openai.com/api-keys',
    hint: /^sk-/,
  },
  allowedHosts: () => ['api.openai.com'],
  roles: {
    text: {
      role: 'text',
      label: 'OpenAI Responses API',
      defaultModel: 'gpt-6.1-sol',
      suggestedModels: TEXT_MODELS,
      optionsSchema: textOptions,
      pricing: (model) => tokenPricing(model),
      create: (ctx) => {
        const options = textOptions.parse(ctx.options);
        return {
          providerId: ID,
          model: ctx.model,
          async complete(request, callOptions) {
            const reasoning = isReasoningModel(ctx.model);
            const instructions = [request.system, request.json ? JSON_INSTRUCTION : undefined]
              .filter(Boolean)
              .join('\n\n');
            const body = await responses(
              ctx,
              {
                model: ctx.model,
                input: request.messages.map((m) => ({ role: m.role, content: m.content })),
                max_output_tokens: maxOutput(
                  ctx.model,
                  request.maxOutputTokens,
                  options.reasoningEffort,
                ),
                ...(instructions ? { instructions } : {}),
                ...(request.json ? { text: { format: { type: 'json_object' } } } : {}),
                ...(reasoning && options.reasoningEffort
                  ? { reasoning: { effort: options.reasoningEffort } }
                  : {}),
                ...(!reasoning && request.temperature !== undefined
                  ? { temperature: request.temperature }
                  : {}),
              },
              callOptions?.signal,
            );
            return {
              value: outputText(body),
              usage: tokenUsage(body),
              model: body.model ?? ctx.model,
            };
          },
        };
      },
    },
    search: {
      role: 'search',
      label: 'OpenAI web_search tool (Responses API)',
      defaultModel: 'gpt-6.1-sol',
      suggestedModels: TEXT_MODELS,
      optionsSchema: searchOptions,
      pricing: (model) => tokenPricing(model, { perSearch: 0.01 }),
      create: (ctx) => {
        const options = searchOptions.parse(ctx.options);
        return {
          providerId: ID,
          model: ctx.model,
          usesModel: true,
          async search({ query, maxResults }, callOptions) {
            const body = await responses(
              ctx,
              {
                model: ctx.model,
                input: `Search the web for: ${query}\nFind up to ${maxResults} authoritative, factual sources and summarise what they say in a few sentences, citing them.`,
                tools: [
                  {
                    type: 'web_search',
                    ...(options.searchContextSize
                      ? { search_context_size: options.searchContextSize }
                      : {}),
                  },
                ],
                include: ['web_search_call.action.sources'],
                max_output_tokens: maxOutput(ctx.model, 1024, options.reasoningEffort),
                ...(isReasoningModel(ctx.model) && options.reasoningEffort
                  ? { reasoning: { effort: options.reasoningEffort } }
                  : {}),
              },
              callOptions?.signal,
            );
            const searches = (body.output ?? []).filter(
              (item) => item.type === 'web_search_call',
            ).length;
            return {
              value: searchResults(body, maxResults),
              usage: { ...tokenUsage(body), searches },
              model: body.model ?? ctx.model,
            };
          },
        };
      },
    },
    voice: {
      role: 'voice',
      label: 'OpenAI text-to-speech',
      defaultModel: 'gpt-4o-mini-tts',
      suggestedModels: ['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1'],
      optionsSchema: voiceOptions,
      pricing: (model) => {
        if (model.startsWith('gpt-4o-mini-tts')) {
          return withSource(
            { perAudioMinute: 0.015 },
            `${SOURCE}: $0.60/1M text tokens + $12/1M audio tokens, about $0.015 per minute`,
          );
        }
        if (model === 'tts-1-hd') return withSource({ perMChars: 30 }, SOURCE);
        if (model === 'tts-1') return withSource({ perMChars: 15 }, SOURCE);
        return null;
      },
      create: (ctx) => {
        const options = voiceOptions.parse(ctx.options);
        const legacy = ctx.model.startsWith('tts-1');
        if (legacy && NEWER_VOICES.has(options.voice)) {
          throw new ProviderError({
            providerId: ID,
            code: 'bad_request',
            message: `The ${options.voice} voice needs gpt-4o-mini-tts; ${ctx.model} cannot use it.`,
          });
        }
        return {
          providerId: ID,
          model: ctx.model,
          voiceId: options.voice,
          returnsTimings: false,
          async synthesize({ text }, callOptions) {
            const chunks = splitTextForSpeech(text, { maxChars: MAX_SPEECH_CHARS });
            if (chunks.length === 0)
              throw new ProviderError({
                providerId: ID,
                code: 'bad_request',
                message: 'There is no text to speak.',
              });
            const parts = [];
            for (const chunk of chunks) {
              const { bytes } = await httpBytes(
                `${API}/audio/speech`,
                {
                  method: 'POST',
                  headers: headers(ctx.apiKey),
                  body: JSON.stringify({
                    model: ctx.model,
                    voice: options.voice,
                    input: chunk,
                    response_format: 'pcm',
                    ...(!legacy && options.instructions
                      ? { instructions: options.instructions }
                      : {}),
                    ...(options.speed !== undefined ? { speed: options.speed } : {}),
                  }),
                },
                http(ctx, callOptions?.signal, 180_000),
              );
              parts.push(pcm16FromBytes(bytes, SPEECH_SAMPLE_RATE, 1));
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
    align: {
      role: 'align',
      label: 'OpenAI whisper-1 word timestamps',
      defaultModel: 'whisper-1',
      suggestedModels: ['whisper-1'],
      optionsSchema: z.strictObject({}),
      validateModel: (model) =>
        model === 'whisper-1'
          ? null
          : `Only whisper-1 returns word timestamps (timestamp_granularities[]=word); ${model} does not.`,
      pricing: (model) =>
        model === 'whisper-1' ? withSource({ perAudioMinute: 0.006 }, SOURCE) : null,
      create: (ctx) => ({
        providerId: ID,
        model: ctx.model,
        async align({ audioPath, language, prompt }, callOptions) {
          let path = audioPath;
          let tempDir: string | null = null;
          try {
            if ((await stat(path)).size > MAX_UPLOAD_BYTES) {
              if (!ctx.media) {
                throw new ProviderError({
                  providerId: ID,
                  code: 'bad_request',
                  message:
                    'The narration is over whisper-1’s 25 MB upload limit and no audio converter is available.',
                });
              }
              tempDir = await mkdtemp(join(tmpdir(), 'vc-whisper-'));
              path = join(tempDir, 'audio-16k.wav');
              await ctx.media.toWav16kMono(audioPath, path);
              if ((await stat(path)).size > MAX_UPLOAD_BYTES) {
                throw new ProviderError({
                  providerId: ID,
                  code: 'bad_request',
                  message:
                    'The narration is too long for whisper-1 (over 25 MB even as 16 kHz mono).',
                });
              }
            }
            const form = new FormData();
            form.append(
              'file',
              new Blob([await readFile(path)], { type: audioMimeType(path) }),
              basename(path),
            );
            form.append('model', ctx.model);
            form.append('response_format', 'verbose_json');
            form.append('timestamp_granularities[]', 'word');
            if (language) form.append('language', language);
            if (prompt) form.append('prompt', prompt.slice(0, 800));
            const body = await httpJson<WhisperVerbose>(
              `${API}/audio/transcriptions`,
              { method: 'POST', headers: headers(ctx.apiKey, false), body: form },
              http(ctx, callOptions?.signal, 300_000),
            );
            return {
              value: whisperWords(body),
              usage: { audioSeconds: Number(body.duration) || 0 },
              model: ctx.model,
            };
          } finally {
            if (tempDir) await rm(tempDir, { recursive: true, force: true });
          }
        },
      }),
    },
    vision: {
      role: 'vision',
      label: 'OpenAI image input (Responses API)',
      defaultModel: 'gpt-6.1-sol',
      suggestedModels: TEXT_MODELS,
      optionsSchema: textOptions,
      pricing: (model) => tokenPricing(model),
      create: (ctx) => {
        const options = textOptions.parse(ctx.options);
        return {
          providerId: ID,
          model: ctx.model,
          async describe({ prompt, images, maxOutputTokens, json }, callOptions) {
            const body = await responses(
              ctx,
              {
                model: ctx.model,
                input: [
                  {
                    role: 'user',
                    content: [
                      { type: 'input_text', text: prompt },
                      ...images.map((image) => ({
                        type: 'input_image',
                        image_url: dataUrl(image),
                      })),
                    ],
                  },
                ],
                max_output_tokens: maxOutput(ctx.model, maxOutputTokens, options.reasoningEffort),
                ...(json
                  ? { instructions: JSON_INSTRUCTION, text: { format: { type: 'json_object' } } }
                  : {}),
                ...(isReasoningModel(ctx.model) && options.reasoningEffort
                  ? { reasoning: { effort: options.reasoningEffort } }
                  : {}),
              },
              callOptions?.signal,
            );
            return {
              value: outputText(body),
              usage: { ...tokenUsage(body), images: images.length },
              model: body.model ?? ctx.model,
            };
          },
        };
      },
    },
  },
};
