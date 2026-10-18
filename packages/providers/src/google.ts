import type { SearchResult, UnitPrices } from '@vc/pipeline';
import { z } from 'zod';
import { httpJson, invalidResponse, type HttpOptions } from './http';
import type { AdapterContext, ProviderDefinition } from './types';
import { lookupByModel, priceOn, toBase64, withSource, type DatedPrice } from './util';

/** Gemini API (generateContent). Search uses Grounding with Google Search. */

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const ID = 'google';
const LABEL = 'Gemini';
const SOURCE = 'ai.google.dev/gemini-api/docs/pricing, checked 2026-10-18';

const dated = (
  now: readonly [number, number],
  later?: { from: string; prices: readonly [number, number] },
): DatedPrice[] => [
  { prices: { inputPerMTok: now[0], outputPerMTok: now[1] } },
  ...(later
    ? [
        {
          from: later.from,
          prices: { inputPerMTok: later.prices[0], outputPerMTok: later.prices[1] },
        },
      ]
    : []),
];

/** Google announced price rises for Gemini 4 Argon (1 Dec 2026) and Gemini 3.6/3.8 Flash (1 Jan 2027). */
const SCHEDULES: Readonly<Record<string, DatedPrice[]>> = {
  'gemini-4-argon': dated([2, 10], { from: '2026-12-01T00:00:00Z', prices: [4, 20] }),
  'gemini-3.8-flash': dated([0.75, 3.75], { from: '2027-01-01T00:00:00Z', prices: [1.5, 7.5] }),
  'gemini-3.6-flash': dated([0.75, 3.75], { from: '2027-01-01T00:00:00Z', prices: [1.5, 7.5] }),
  'gemini-3-flash-preview': dated([0.5, 3]),
  'gemini-3.5-flash-lite': dated([0.3, 2.5]),
  'gemini-3.1-flash-lite': dated([0.25, 1.5]),
  'gemini-3.1-pro-preview': dated([2, 12]),
  'gemini-2.5-pro': dated([1.25, 10]),
  'gemini-2.5-flash': dated([0.3, 2.5]),
  'gemini-2.5-flash-lite': dated([0.1, 0.4]),
};

const MODELS = [
  'gemini-3.8-flash',
  'gemini-4-argon',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.1-pro-preview',
  'gemini-2.5-flash',
] as const;
const BLOCKED_FINISH = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

const isGemini2 = (model: string) => model.startsWith('gemini-2.');

const tokenPricing = (model: string, at: Date, extra: UnitPrices = {}): UnitPrices | null => {
  const schedule = lookupByModel(SCHEDULES, model);
  const prices = schedule ? priceOn(schedule, at) : null;
  if (!prices) return null;
  const rise = schedule!.find((entry) => entry.from && Date.parse(entry.from) > at.getTime());
  return withSource(
    { ...prices, ...extra },
    rise ? `${SOURCE}; rises on ${rise.from!.slice(0, 10)}` : SOURCE,
  );
};

/** Grounding: Gemini 3+ $14 per 1,000 (5,000 free a month); Gemini 2.5 $35 per 1,000 (1,500 a day free). */
const searchPrice = (model: string): UnitPrices => ({
  perSearch: isGemini2(model) ? 0.035 : 0.014,
});

type Part = { text?: string; thought?: boolean };
type GenerateBody = {
  candidates?: Array<{
    content?: { parts?: Part[] };
    finishReason?: string;
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      groundingSupports?: Array<{ segment?: { text?: string }; groundingChunkIndices?: number[] }>;
    };
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
  modelVersion?: string;
};

const http = (ctx: AdapterContext, signal: AbortSignal | undefined): HttpOptions => ({
  providerId: ID,
  label: LABEL,
  fetch: ctx.fetch,
  apiKey: ctx.apiKey,
  timeoutMs: 300_000,
  ...(signal ? { signal } : {}),
});

const generate = (ctx: AdapterContext, body: Record<string, unknown>, signal?: AbortSignal) =>
  httpJson<GenerateBody>(
    `${API}/${encodeURIComponent(ctx.model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': ctx.apiKey ?? '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    http(ctx, signal),
  );

/** Thinking tokens count against maxOutputTokens on thinking models; leave room for them. */
const maxOutput = (requested: number) => Math.min(65_536, requested + 8_192);

const usageOf = (body: GenerateBody) => ({
  inputTokens:
    (body.usageMetadata?.promptTokenCount ?? 0) +
    (body.usageMetadata?.toolUsePromptTokenCount ?? 0),
  outputTokens:
    (body.usageMetadata?.candidatesTokenCount ?? 0) + (body.usageMetadata?.thoughtsTokenCount ?? 0),
});

const textOf = (body: GenerateBody): string => {
  if (body.promptFeedback?.blockReason)
    throw invalidResponse(ID, `Gemini blocked the prompt (${body.promptFeedback.blockReason}).`);
  const candidate = body.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought && p.text)
    .map((p) => p.text!)
    .join('');
  if (text.trim()) return text;
  const reason = candidate?.finishReason ?? 'no candidate';
  if (BLOCKED_FINISH.has(reason)) throw invalidResponse(ID, `Gemini stopped for ${reason}.`);
  throw invalidResponse(
    ID,
    reason === 'MAX_TOKENS'
      ? 'Gemini ran out of tokens before answering.'
      : `Gemini returned no text (${reason}).`,
  );
};

const groundedResults = (
  body: GenerateBody,
  maxResults: number,
): { results: SearchResult[]; grounded: boolean; queries: number } => {
  const metadata = body.candidates?.[0]?.groundingMetadata;
  const chunks = metadata?.groundingChunks ?? [];
  const snippets = new Map<number, string>();
  for (const support of metadata?.groundingSupports ?? []) {
    for (const index of support.groundingChunkIndices ?? []) {
      if (!snippets.has(index) && support.segment?.text)
        snippets.set(index, support.segment.text.trim());
    }
  }
  const order = [...snippets.keys(), ...chunks.map((_, i) => i).filter((i) => !snippets.has(i))];
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const index of order) {
    const web = chunks[index]?.web;
    if (!web?.uri || seen.has(web.uri)) continue;
    seen.add(web.uri);
    const snippet = snippets.get(index);
    results.push({
      url: web.uri,
      title: web.title?.trim() || 'Web result',
      ...(snippet ? { snippet } : {}),
    });
  }
  return {
    results: results.slice(0, maxResults),
    grounded: chunks.length > 0 || (metadata?.webSearchQueries?.length ?? 0) > 0,
    queries: metadata?.webSearchQueries?.length ?? 0,
  };
};

const options = z.strictObject({});

export const googleProvider: ProviderDefinition = {
  id: ID,
  label: LABEL,
  kind: 'cloud',
  description: 'Gemini models for scripts, Google Search grounding and image checks.',
  credential: {
    id: 'google',
    label: 'Gemini API key (Google AI Studio)',
    helpUrl: 'https://aistudio.google.com/apikey',
    hint: /^AIza/,
  },
  allowedHosts: () => ['generativelanguage.googleapis.com'],
  roles: {
    text: {
      role: 'text',
      label: 'Gemini generateContent',
      defaultModel: 'gemini-3.8-flash',
      suggestedModels: MODELS,
      optionsSchema: options,
      pricing: (model, at = new Date()) => tokenPricing(model, at),
      create: (ctx) => ({
        providerId: ID,
        model: ctx.model,
        async complete(request, callOptions) {
          const body = await generate(
            ctx,
            {
              ...(request.system
                ? { systemInstruction: { parts: [{ text: request.system }] } }
                : {}),
              contents: request.messages.map((m) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }],
              })),
              generationConfig: {
                maxOutputTokens: maxOutput(request.maxOutputTokens),
                ...(request.json ? { responseMimeType: 'application/json' } : {}),
                // Gemini 3+ is tuned for the default temperature; lowering it can cause looping.
                ...(request.temperature !== undefined && isGemini2(ctx.model)
                  ? { temperature: request.temperature }
                  : {}),
              },
            },
            callOptions?.signal,
          );
          return {
            value: textOf(body),
            usage: usageOf(body),
            model: body.modelVersion ?? ctx.model,
          };
        },
      }),
    },
    search: {
      role: 'search',
      label: 'Grounding with Google Search',
      defaultModel: 'gemini-3.8-flash',
      suggestedModels: MODELS,
      optionsSchema: options,
      pricing: (model, at = new Date()) => tokenPricing(model, at, searchPrice(model)),
      create: (ctx) => ({
        providerId: ID,
        model: ctx.model,
        usesModel: true,
        async search({ query, maxResults }, callOptions) {
          const body = await generate(
            ctx,
            {
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      text: `Search the web for: ${query}\nSummarise what authoritative sources say in a few sentences.`,
                    },
                  ],
                },
              ],
              tools: [{ google_search: {} }],
              generationConfig: { maxOutputTokens: maxOutput(1024) },
            },
            callOptions?.signal,
          );
          const { results, grounded, queries } = groundedResults(body, maxResults);
          const searches = !grounded ? 0 : isGemini2(ctx.model) ? 1 : Math.max(1, queries);
          return {
            value: results,
            usage: { ...usageOf(body), searches },
            model: body.modelVersion ?? ctx.model,
          };
        },
      }),
    },
    vision: {
      role: 'vision',
      label: 'Gemini image input',
      defaultModel: 'gemini-3.8-flash',
      suggestedModels: MODELS,
      optionsSchema: options,
      pricing: (model, at = new Date()) => tokenPricing(model, at),
      create: (ctx) => ({
        providerId: ID,
        model: ctx.model,
        async describe({ prompt, images, maxOutputTokens, json }, callOptions) {
          const body = await generate(
            ctx,
            {
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: prompt },
                    ...images.map((image) => ({
                      inlineData: { mimeType: image.mimeType, data: toBase64(image.data) },
                    })),
                  ],
                },
              ],
              generationConfig: {
                maxOutputTokens: maxOutput(maxOutputTokens),
                ...(json ? { responseMimeType: 'application/json' } : {}),
              },
            },
            callOptions?.signal,
          );
          return {
            value: textOf(body),
            usage: { ...usageOf(body), images: images.length },
            model: body.modelVersion ?? ctx.model,
          };
        },
      }),
    },
  },
};
