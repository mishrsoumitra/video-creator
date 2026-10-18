import {
  ProviderError,
  type ProviderErrorCode,
  type SearchResult,
  type UnitPrices,
} from '@vc/pipeline';
import { z } from 'zod';
import { httpJson, invalidResponse, type HttpOptions } from './http';
import type { AdapterContext, ProviderDefinition } from './types';
import { extractJsonText, lookupByModel, toBase64, withSource } from './util';

/*
 * Anthropic Messages API over raw HTTP (the official SDK is not a dependency here, and every
 * adapter shares one fetch path so the key guard sees every request).
 */

const API = 'https://api.anthropic.com/v1/messages';
const ID = 'anthropic';
const LABEL = 'Anthropic';
const VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const SOURCE =
  'Anthropic model pricing (claude-api reference, cached 2026-10-06); web search $10 per 1,000 searches';
const JSON_INSTRUCTION =
  'Reply with one JSON object and nothing else: no prose and no code fences.';

/** USD per 1M tokens [input, output]. Haiku 5.5 rises to $0.50/$2.50 above 100K prompt tokens. */
const TOKEN_PRICES: Readonly<Record<string, readonly [number, number]>> = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
};

const MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
] as const;

/** Models with server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
];
/** Models that run web_search_20260209 (dynamic filtering); others get the basic tool. */
const DYNAMIC_FILTERING = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-fable-5',
];

const matches = (model: string, ids: readonly string[]) =>
  ids.some((id) => model === id || model.startsWith(`${id}-`));

const version = (model: string): { major: number; minor: number } | null => {
  const m = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return null;
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  return { major: Number(m[1]), minor: minor > 99 ? 0 : minor }; // "4-20250514" is a dated snapshot of 4.0
};

/** temperature/top_p are rejected (400) from Opus 4.7, Sonnet 5 and every 5.x model on. */
export const supportsSampling = (model: string): boolean => {
  if (/^claude-(?:instant|2|3)/.test(model)) return true;
  const v = version(model);
  return v !== null && (v.major < 4 || (v.major === 4 && v.minor <= 6));
};

const supportsEffort = (model: string): boolean => {
  const v = version(model);
  return v !== null && (v.major >= 5 || (v.major === 4 && v.minor >= 6));
};

export const webSearchToolType = (model: string): 'web_search_20260209' | 'web_search_20250305' =>
  matches(model, DYNAMIC_FILTERING) ? 'web_search_20260209' : 'web_search_20250305';

const options = z.strictObject({
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  /** Re-run a declined request on a fallback model inside the same call. */
  refusalFallback: z.boolean().default(true),
});
type Options = z.infer<typeof options>;

const tokenPricing = (model: string, extra: UnitPrices = {}): UnitPrices | null => {
  const price = lookupByModel(TOKEN_PRICES, model);
  return price
    ? withSource({ inputPerMTok: price[0], outputPerMTok: price[1], ...extra }, SOURCE)
    : null;
};

type Block = {
  type: string;
  text?: string;
  name?: string;
  citations?: Array<{ type: string; url?: string; title?: string; cited_text?: string }>;
  content?: unknown;
};
type MessageBody = {
  model?: string;
  content?: Block[];
  stop_reason?: string;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  };
};

const http = (ctx: AdapterContext, signal: AbortSignal | undefined): HttpOptions => ({
  providerId: ID,
  label: LABEL,
  fetch: ctx.fetch,
  apiKey: ctx.apiKey,
  timeoutMs: 300_000,
  ...(signal ? { signal } : {}),
});

const send = (
  ctx: AdapterContext,
  opts: Options,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => {
  const fallback = opts.refusalFallback && matches(ctx.model, FALLBACK_MODELS);
  return httpJson<MessageBody>(
    API,
    {
      method: 'POST',
      headers: {
        'x-api-key': ctx.apiKey ?? '',
        'anthropic-version': VERSION,
        'content-type': 'application/json',
        ...(fallback ? { 'anthropic-beta': FALLBACK_BETA } : {}),
      },
      body: JSON.stringify({
        model: ctx.model,
        ...body,
        ...(supportsEffort(ctx.model) ? { output_config: { effort: opts.effort } } : {}),
        ...(fallback ? { fallbacks: 'default' } : {}),
      }),
    },
    http(ctx, signal),
  );
};

/** Thinking is on by default on current models, so leave room for it above the visible answer. */
const maxTokens = (requested: number) => Math.min(32_000, Math.max(16_000, requested + 8_000));

const usageOf = (body: MessageBody) => ({
  inputTokens:
    (body.usage?.input_tokens ?? 0) +
    (body.usage?.cache_creation_input_tokens ?? 0) +
    (body.usage?.cache_read_input_tokens ?? 0),
  outputTokens: body.usage?.output_tokens ?? 0,
});

const textOf = (body: MessageBody): string => {
  if (body.stop_reason === 'refusal') {
    throw invalidResponse(
      ID,
      `Claude declined the request (${body.stop_details?.category ?? 'no category given'}).`,
    );
  }
  const text = (body.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  if (text.trim()) return text;
  throw invalidResponse(
    ID,
    body.stop_reason === 'max_tokens'
      ? 'Claude ran out of tokens before answering.'
      : 'Claude returned no text.',
  );
};

const SEARCH_ERRORS: Readonly<Record<string, ProviderErrorCode>> = {
  too_many_requests: 'rate_limit',
  invalid_input: 'bad_request',
  query_too_long: 'bad_request',
  max_uses_exceeded: 'server',
  unavailable: 'server',
};

const searchResults = (body: MessageBody, maxResults: number): SearchResult[] => {
  const cited = new Map<string, SearchResult>();
  const found = new Map<string, SearchResult>();
  let errorCode: string | null = null;
  for (const block of body.content ?? []) {
    if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content)) {
        for (const item of block.content as Array<{
          type?: string;
          url?: string;
          title?: string;
        }>) {
          if (item.type === 'web_search_result' && item.url && !found.has(item.url))
            found.set(item.url, {
              url: item.url,
              title: item.title?.trim() || new URL(item.url).hostname,
            });
        }
      } else if (block.content && typeof block.content === 'object') {
        errorCode = String((block.content as { error_code?: string }).error_code ?? 'unavailable');
      }
    }
    for (const citation of block.citations ?? []) {
      if (
        citation.type !== 'web_search_result_location' ||
        !citation.url ||
        cited.has(citation.url)
      )
        continue;
      cited.set(citation.url, {
        url: citation.url,
        title: citation.title?.trim() || new URL(citation.url).hostname,
        ...(citation.cited_text ? { snippet: citation.cited_text.trim() } : {}),
      });
    }
  }
  const results = [...cited.values(), ...[...found.values()].filter((r) => !cited.has(r.url))];
  if (results.length === 0 && errorCode) {
    throw new ProviderError({
      providerId: ID,
      code: SEARCH_ERRORS[errorCode] ?? 'server',
      message: `Claude web search failed: ${errorCode}`,
    });
  }
  return results.slice(0, maxResults);
};

export const anthropicProvider: ProviderDefinition = {
  id: ID,
  label: LABEL,
  kind: 'cloud',
  description: 'Claude models for scripts, web search (citations always on) and image checks.',
  credential: {
    id: 'anthropic',
    label: 'Anthropic API key',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    hint: /^sk-ant-/,
  },
  allowedHosts: () => ['api.anthropic.com'],
  roles: {
    text: {
      role: 'text',
      label: 'Anthropic Messages API',
      defaultModel: 'claude-opus-5-5',
      suggestedModels: MODELS,
      optionsSchema: options,
      pricing: (model) => tokenPricing(model),
      create: (ctx) => {
        const opts = options.parse(ctx.options);
        return {
          providerId: ID,
          model: ctx.model,
          async complete(request, callOptions) {
            const system = [request.system, request.json ? JSON_INSTRUCTION : undefined]
              .filter(Boolean)
              .join('\n\n');
            const body = await send(
              ctx,
              opts,
              {
                max_tokens: maxTokens(request.maxOutputTokens),
                ...(system ? { system } : {}),
                messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
                ...(request.temperature !== undefined && supportsSampling(ctx.model)
                  ? { temperature: request.temperature }
                  : {}),
              },
              callOptions?.signal,
            );
            const text = textOf(body);
            return {
              value: request.json ? extractJsonText(text) : text,
              usage: usageOf(body),
              model: body.model ?? ctx.model,
            };
          },
        };
      },
    },
    search: {
      role: 'search',
      label: 'Claude web_search server tool',
      defaultModel: 'claude-opus-5-5',
      suggestedModels: MODELS,
      optionsSchema: options,
      pricing: (model) => tokenPricing(model, { perSearch: 0.01 }),
      create: (ctx) => {
        const opts = options.parse(ctx.options);
        return {
          providerId: ID,
          model: ctx.model,
          usesModel: true,
          async search({ query, maxResults }, callOptions) {
            const body = await send(
              ctx,
              opts,
              {
                max_tokens: maxTokens(1024),
                messages: [
                  {
                    role: 'user',
                    content: `Search the web for: ${query}\nFind up to ${maxResults} authoritative, factual sources and summarise what they say in a few sentences.`,
                  },
                ],
                tools: [{ type: webSearchToolType(ctx.model), name: 'web_search', max_uses: 3 }],
              },
              callOptions?.signal,
            );
            const searches =
              body.usage?.server_tool_use?.web_search_requests ??
              (body.content ?? []).filter(
                (b) => b.type === 'server_tool_use' && b.name === 'web_search',
              ).length;
            return {
              value: searchResults(body, maxResults),
              usage: { ...usageOf(body), searches },
              model: body.model ?? ctx.model,
            };
          },
        };
      },
    },
    vision: {
      role: 'vision',
      label: 'Claude image input',
      defaultModel: 'claude-opus-5-5',
      suggestedModels: MODELS,
      optionsSchema: options,
      pricing: (model) => tokenPricing(model),
      create: (ctx) => {
        const opts = options.parse(ctx.options);
        return {
          providerId: ID,
          model: ctx.model,
          async describe({ prompt, images, maxOutputTokens, json }, callOptions) {
            const body = await send(
              ctx,
              opts,
              {
                max_tokens: maxTokens(maxOutputTokens),
                ...(json ? { system: JSON_INSTRUCTION } : {}),
                messages: [
                  {
                    role: 'user',
                    content: [
                      ...images.map((image) => ({
                        type: 'image',
                        source: {
                          type: 'base64',
                          media_type: image.mimeType,
                          data: toBase64(image.data),
                        },
                      })),
                      { type: 'text', text: prompt },
                    ],
                  },
                ],
              },
              callOptions?.signal,
            );
            const text = textOf(body);
            return {
              value: json ? extractJsonText(text) : text,
              usage: { ...usageOf(body), images: images.length },
              model: body.model ?? ctx.model,
            };
          },
        };
      },
    },
  },
};
