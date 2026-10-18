import type { SearchResult } from '@vc/pipeline';
import { z } from 'zod';
import { httpJson } from './http';
import type { ProviderDefinition } from './types';
import { withSource } from './util';

/**
 * SerpAPI: search-engine results through a plain API (no model). Its key travels in the query
 * string, so the guard and the error scrubber both have to handle URL-carried keys.
 */

const API = 'https://serpapi.com/search.json';
const ID = 'serpapi';
const ENGINES = ['google', 'bing', 'duckduckgo'] as const;

type SerpBody = {
  error?: string;
  organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
};

export const serpapiProvider: ProviderDefinition = {
  id: ID,
  label: 'SerpAPI',
  kind: 'cloud',
  description: 'Search-engine results through a plain API; the text model then reads the pages.',
  credential: {
    id: 'serpapi',
    label: 'SerpAPI key',
    helpUrl: 'https://serpapi.com/manage-api-key',
  },
  allowedHosts: () => ['serpapi.com'],
  roles: {
    search: {
      role: 'search',
      label: 'SerpAPI search results',
      defaultModel: 'google',
      suggestedModels: ENGINES,
      optionsSchema: z.strictObject({}),
      validateModel: (model) =>
        (ENGINES as readonly string[]).includes(model)
          ? null
          : `SerpAPI engine must be one of ${ENGINES.join(', ')}.`,
      pricing: () =>
        withSource(
          { perSearch: 0.015 },
          'SerpAPI Developer plan, $75 for 5,000 searches a month (subscription, third-party summaries, Oct 2026)',
        ),
      create: (ctx) => ({
        providerId: ID,
        model: null,
        usesModel: false,
        async search({ query, maxResults }, callOptions) {
          const url = new URL(API);
          url.searchParams.set('engine', ctx.model);
          url.searchParams.set('q', query);
          url.searchParams.set('num', String(Math.min(100, Math.max(1, maxResults))));
          url.searchParams.set('api_key', ctx.apiKey ?? '');
          const body = await httpJson<SerpBody>(
            url.href,
            { headers: { accept: 'application/json' } },
            {
              providerId: ID,
              label: 'SerpAPI',
              fetch: ctx.fetch,
              apiKey: ctx.apiKey,
              timeoutMs: 30_000,
              ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
            },
          );
          const results: SearchResult[] = (body.organic_results ?? [])
            .filter((r) => typeof r.link === 'string' && r.link.length > 0)
            .slice(0, maxResults)
            .map((r) => ({
              url: r.link!,
              title: r.title?.trim() || new URL(r.link!).hostname,
              ...(r.snippet ? { snippet: r.snippet.trim() } : {}),
            }));
          return { value: results, usage: { searches: 1 }, model: ctx.model };
        },
      }),
    },
  },
};
