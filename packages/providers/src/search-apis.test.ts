import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { braveProvider } from './brave';
import { createRoleProvider } from './registry';
import { serpapiProvider } from './serpapi';
import { createFakeFetch, jsonResponse, type FakeHandler } from './testing/fake-fetch';

const search = (
  providerId: string,
  handler: FakeHandler | FakeHandler[],
  apiKey = 'key-SECRET-0123456789',
) => {
  const fake = createFakeFetch(handler);
  return {
    fake,
    provider: createRoleProvider({
      providerId,
      role: 'search',
      apiKey,
      dataDir: tmpdir(),
      fetch: fake.fetch,
    }),
  };
};

describe('brave search (plain API, no model)', () => {
  it('sends the subscription token header and maps web results, stripping highlight tags', async () => {
    const { fake, provider } = search('brave', () =>
      jsonResponse({
        web: {
          results: [
            {
              title: 'Apollo program - Wikipedia',
              url: 'https://en.wikipedia.org/wiki/Apollo_program',
              description: 'The <strong>Apollo</strong> program &amp; the Moon.',
            },
            { title: 'NASA Apollo', url: 'https://nasa.gov/apollo', description: '' },
          ],
        },
      }),
    );
    const result = await provider.search({ query: 'apollo program', maxResults: 5 });
    const req = fake.requests[0]!;
    expect(req.url.origin + req.url.pathname).toBe(
      'https://api.search.brave.com/res/v1/web/search',
    );
    expect(req.url.searchParams.get('q')).toBe('apollo program');
    expect(req.url.searchParams.get('count')).toBe('5');
    expect(req.headers.get('x-subscription-token')).toBe('key-SECRET-0123456789');
    expect(provider.usesModel).toBe(false);
    expect(provider.model).toBeNull();
    expect(result.value).toEqual([
      {
        url: 'https://en.wikipedia.org/wiki/Apollo_program',
        title: 'Apollo program - Wikipedia',
        snippet: 'The Apollo program & the Moon.',
      },
      { url: 'https://nasa.gov/apollo', title: 'NASA Apollo' },
    ]);
    expect(result.usage).toEqual({ searches: 1 });
  });

  it('caps count at the API maximum of 20', async () => {
    const { fake, provider } = search('brave', () => jsonResponse({ web: { results: [] } }));
    await provider.search({ query: 'x', maxResults: 50 });
    expect(fake.requests[0]!.url.searchParams.get('count')).toBe('20');
  });

  it('copes with a response that has no web section', async () => {
    const { provider } = search('brave', () => jsonResponse({ query: {} }));
    expect((await provider.search({ query: 'x', maxResults: 5 })).value).toEqual([]);
  });

  it('charges per request', () => {
    expect(braveProvider.roles.search!.pricing('brave-web-search')).toMatchObject({
      perSearch: 0.005,
    });
  });
});

describe('serpapi (plain API; the key travels in the query string)', () => {
  it('maps organic results', async () => {
    const { fake, provider } = search('serpapi', () =>
      jsonResponse({
        organic_results: [
          { title: 'Apollo', link: 'https://example.org/apollo', snippet: 'Moon program' },
          { title: 'No link' },
        ],
      }),
    );
    const result = await provider.search({ query: 'apollo', maxResults: 3 });
    const url = fake.requests[0]!.url;
    expect(url.origin + url.pathname).toBe('https://serpapi.com/search.json');
    expect(url.searchParams.get('engine')).toBe('google');
    expect(url.searchParams.get('api_key')).toBe('key-SECRET-0123456789');
    expect(result.value).toEqual([
      { url: 'https://example.org/apollo', title: 'Apollo', snippet: 'Moon program' },
    ]);
  });

  it('treats "no results" as an empty list, not an error', async () => {
    const { provider } = search('serpapi', () =>
      jsonResponse({ error: "Google hasn't returned any results for this query." }),
    );
    expect((await provider.search({ query: 'zzz', maxResults: 3 })).value).toEqual([]);
  });

  it('never puts the key in an error message, even when the server echoes it', async () => {
    const key = 'serp-SECRET-key-0123456789';
    const { provider } = search(
      'serpapi',
      [() => jsonResponse({ error: `Invalid API key: ${key}` }, { status: 401 })],
      key,
    );
    const error = await provider.search({ query: 'x', maxResults: 3 }).catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'auth' });
    expect((error as Error).message).not.toContain(key);
  });

  it('never puts the key in a network error message either', async () => {
    const key = 'serp-SECRET-key-0123456789';
    const failing: FakeHandler = (request) => {
      throw new TypeError(`request to ${request.url.href} failed`);
    };
    const { provider } = search('serpapi', [failing, failing, failing], key);
    const error = (await provider
      .search({ query: 'x', maxResults: 3 })
      .catch((e: Error) => e)) as Error;
    expect(error.message).not.toContain(key);
    expect(error.message).not.toContain(encodeURIComponent(key));
  });

  it('is priced per search on the Developer plan', () => {
    expect(serpapiProvider.roles.search!.pricing('google')).toMatchObject({ perSearch: 0.015 });
  });
});
