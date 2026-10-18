import { describe, expect, it } from 'vitest';
import { createOpenverseSource } from './openverse';
import { createFakeFetch, jsonResponse } from './testing/fake-fetch';

const result = (overrides: Record<string, unknown> = {}) => ({
  id: 'abc-123',
  title: 'Saturn V launch',
  url: 'https://live.staticflickr.com/1/saturn.jpg',
  thumbnail: 'https://api.openverse.org/v1/images/abc-123/thumb/',
  creator: 'NASA',
  creator_url: 'https://flickr.com/nasa',
  license: 'PDM',
  license_version: '1.0',
  license_url: 'https://creativecommons.org/publicdomain/mark/1.0/',
  foreign_landing_url: 'https://flickr.com/photos/nasa/1',
  provider: 'flickr',
  source: 'flickr',
  tags: [{ name: 'Rocket' }, { name: 'rocket' }, { name: 'Launch', accuracy: 0.9 }],
  width: 4000,
  height: 2250,
  mature: false,
  ...overrides,
});

describe('openverse image source (anonymous)', () => {
  it('queries with licence, page size, mature=false and the aspect ratio, without the coarse size filter', async () => {
    const fake = createFakeFetch(() => jsonResponse({ result_count: 1, results: [result()] }));
    const source = createOpenverseSource({ fetch: fake.fetch });
    const candidates = await source.search({
      query: 'saturn v launch',
      aspect: '16:9',
      licenses: ['cc0', 'pdm', 'by', 'by-sa'],
      pageSize: 20,
    });
    const url = fake.requests[0]!.url;
    expect(url.origin + url.pathname).toBe('https://api.openverse.org/v1/images/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'saturn v launch',
      license: 'cc0,pdm,by,by-sa',
      page_size: '20',
      mature: 'false',
      aspect_ratio: 'wide',
    });
    expect(fake.requests[0]!.headers.get('user-agent')).toMatch(/video-creator/);
    expect(source.id).toBe('openverse');
    expect(candidates).toEqual([
      {
        id: 'abc-123',
        provider: 'openverse',
        url: 'https://live.staticflickr.com/1/saturn.jpg',
        thumbnailUrl: 'https://api.openverse.org/v1/images/abc-123/thumb/',
        title: 'Saturn V launch',
        tags: ['rocket', 'launch'],
        width: 4000,
        height: 2250,
        license: 'pdm',
        licenseVersion: '1.0',
        licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
        creator: 'NASA',
        sourceUrl: 'https://flickr.com/photos/nasa/1',
        mature: false,
      },
    ]);
  });

  it.each([
    ['9:16', 'tall'],
    ['1:1', 'square'],
  ] as const)('maps aspect %s to %s', async (aspect, expected) => {
    const fake = createFakeFetch(() => jsonResponse({ results: [result()] }));
    await createOpenverseSource({ fetch: fake.fetch }).search({
      query: 'x',
      aspect,
      licenses: ['cc0'],
      pageSize: 5,
    });
    expect(fake.requests[0]!.url.searchParams.get('aspect_ratio')).toBe(expected);
  });

  it('clamps page size to the anonymous maximum of 20', async () => {
    const fake = createFakeFetch(() => jsonResponse({ results: [result()] }));
    await createOpenverseSource({ fetch: fake.fetch }).search({
      query: 'x',
      aspect: '16:9',
      licenses: ['cc0'],
      pageSize: 500,
    });
    expect(fake.requests[0]!.url.searchParams.get('page_size')).toBe('20');
  });

  it('retries once without the aspect filter when it returns nothing, so niche topics are not starved', async () => {
    const fake = createFakeFetch([
      () => jsonResponse({ results: [] }),
      () => jsonResponse({ results: [result({ id: 'portrait', width: 1000, height: 1500 })] }),
    ]);
    const candidates = await createOpenverseSource({ fetch: fake.fetch }).search({
      query: 'rare thing',
      aspect: '16:9',
      licenses: ['cc0'],
      pageSize: 20,
    });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.url.searchParams.has('aspect_ratio')).toBe(false);
    expect(candidates.map((c) => c.id)).toEqual(['portrait']);
  });

  it('tolerates missing metadata', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse({ results: [{ id: 'bare', url: 'https://x.test/a.jpg', license: 'BY' }] }),
    );
    const [candidate] = await createOpenverseSource({ fetch: fake.fetch }).search({
      query: 'x',
      aspect: '1:1',
      licenses: ['by'],
      pageSize: 5,
    });
    expect(candidate).toMatchObject({
      id: 'bare',
      title: '',
      tags: [],
      width: null,
      height: null,
      creator: null,
      licenseVersion: null,
      sourceUrl: null,
      thumbnailUrl: null,
      license: 'by',
    });
  });

  it('drops results without an image URL', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse({ results: [result({ url: null }), result({ id: 'ok' })] }),
    );
    const candidates = await createOpenverseSource({ fetch: fake.fetch }).search({
      query: 'x',
      aspect: '1:1',
      licenses: ['by'],
      pageSize: 5,
    });
    expect(candidates.map((c) => c.id)).toEqual(['ok']);
  });

  it('maps rate limiting to a retryable error', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse({ detail: 'Request was throttled.' }, { status: 429 }),
    );
    const source = createOpenverseSource({ fetch: fake.fetch, sleep: async () => undefined });
    await expect(
      source.search({ query: 'x', aspect: '1:1', licenses: ['by'], pageSize: 5 }),
    ).rejects.toMatchObject({ code: 'rate_limit' });
  });
});
