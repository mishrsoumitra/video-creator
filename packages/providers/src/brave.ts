import type { SearchResult } from '@vc/pipeline';
import { z } from 'zod';
import { httpJson } from './http';
import type { ProviderDefinition } from './types';
import { withSource } from './util';

/** Brave Search API: a plain web search, no model involved (not counted as AI). */

const API = 'https://api.search.brave.com/res/v1/web/search';
const ID = 'brave';
const MAX_COUNT = 20;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
  nbsp: ' ',
};

/** Brave marks matches with <strong> and escapes entities in descriptions. */
export const plainText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      const key = name.toLowerCase();
      if (key in ENTITIES) return ENTITIES[key]!;
      if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
      if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
      return whole;
    })
    .replace(/\s+/g, ' ')
    .trim();

type BraveBody = {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
};

export const braveProvider: ProviderDefinition = {
  id: ID,
  label: 'Brave Search',
  kind: 'cloud',
  description: 'Plain web search API; the text model then reads the pages.',
  credential: {
    id: 'brave',
    label: 'Brave Search API key',
    helpUrl: 'https://api-dashboard.search.brave.com/app/keys',
  },
  allowedHosts: () => ['api.search.brave.com'],
  roles: {
    search: {
      role: 'search',
      label: 'Brave web search API',
      defaultModel: 'brave-web-search',
      suggestedModels: ['brave-web-search'],
      optionsSchema: z.strictObject({
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
      }),
      pricing: () =>
        withSource(
          { perSearch: 0.005 },
          'Brave Search API "Search" plan, $5 per 1,000 requests (third-party summaries, Oct 2026; verify on brave.com)',
        ),
      create: (ctx) => ({
        providerId: ID,
        model: null,
        usesModel: false,
        async search({ query, maxResults }, callOptions) {
          const url = new URL(API);
          url.searchParams.set('q', query);
          url.searchParams.set('count', String(Math.min(MAX_COUNT, Math.max(1, maxResults))));
          if (typeof ctx.options.country === 'string')
            url.searchParams.set('country', ctx.options.country);
          const body = await httpJson<BraveBody>(
            url.href,
            { headers: { accept: 'application/json', 'x-subscription-token': ctx.apiKey ?? '' } },
            {
              providerId: ID,
              label: 'Brave Search',
              fetch: ctx.fetch,
              apiKey: ctx.apiKey,
              timeoutMs: 20_000,
              ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
            },
          );
          const results: SearchResult[] = (body.web?.results ?? [])
            .filter((r) => typeof r.url === 'string' && r.url.length > 0)
            .slice(0, maxResults)
            .map((r) => {
              const snippet = plainText(r.description ?? '');
              return {
                url: r.url!,
                title: plainText(r.title ?? '') || new URL(r.url!).hostname,
                ...(snippet ? { snippet } : {}),
              };
            });
          return { value: results, usage: { searches: 1 }, model: 'brave-web-search' };
        },
      }),
    },
  },
};
