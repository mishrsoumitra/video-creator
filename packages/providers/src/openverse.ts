import type { ImageCandidate, ImageQuery, ImageSource } from '@vc/pipeline';
import { httpJson, type HttpOptions } from './http';

/*
 * Openverse (openly licensed images), anonymous access. Deliberately no `size` filter: the buckets
 * are coarse and drop every result without dimension metadata, which starves niche topics into
 * typographic fallbacks; the pipeline filters on real width instead. The aspect filter is used, but
 * if it leaves nothing the query is retried once without it (portrait images still work over a
 * blurred backdrop).
 */

const API = 'https://api.openverse.org/v1/images/';
const ANONYMOUS_PAGE_SIZE = 20;
const ASPECT: Readonly<Record<ImageQuery['aspect'], string>> = {
  '16:9': 'wide',
  '9:16': 'tall',
  '1:1': 'square',
};

type OpenverseResult = {
  id?: string;
  title?: string | null;
  url?: string | null;
  thumbnail?: string | null;
  creator?: string | null;
  license?: string | null;
  license_version?: string | null;
  license_url?: string | null;
  foreign_landing_url?: string | null;
  tags?: Array<{ name?: string }> | null;
  width?: number | null;
  height?: number | null;
  mature?: boolean | null;
};

export type OpenverseOptions = {
  fetch?: typeof fetch;
  userAgent?: string;
  timeoutMs?: number;
  sleep?: HttpOptions['sleep'];
};

const toCandidate = (r: OpenverseResult): ImageCandidate | null => {
  if (!r.id || !r.url) return null;
  const tags = [
    ...new Set((r.tags ?? []).map((t) => t.name?.trim().toLowerCase() ?? '').filter(Boolean)),
  ];
  return {
    id: r.id,
    provider: 'openverse',
    url: r.url,
    thumbnailUrl: r.thumbnail ?? null,
    title: r.title?.trim() ?? '',
    tags,
    width: typeof r.width === 'number' ? r.width : null,
    height: typeof r.height === 'number' ? r.height : null,
    license: (r.license ?? 'unknown').toLowerCase(),
    licenseVersion: r.license_version ?? null,
    licenseUrl: r.license_url ?? null,
    creator: r.creator?.trim() || null,
    sourceUrl: r.foreign_landing_url ?? null,
    mature: r.mature === true,
  };
};

export const createOpenverseSource = ({
  fetch = globalThis.fetch,
  userAgent = 'video-creator/0.1 (local topic-to-video app)',
  timeoutMs = 20_000,
  sleep,
}: OpenverseOptions = {}): ImageSource => ({
  id: 'openverse',
  async search(query, callOptions) {
    const run = (withAspect: boolean) => {
      const url = new URL(API);
      url.searchParams.set('q', query.query);
      url.searchParams.set('license', query.licenses.map((l) => l.toLowerCase()).join(','));
      url.searchParams.set(
        'page_size',
        String(Math.min(ANONYMOUS_PAGE_SIZE, Math.max(1, query.pageSize))),
      );
      url.searchParams.set('mature', 'false');
      if (withAspect) url.searchParams.set('aspect_ratio', ASPECT[query.aspect]);
      return httpJson<{ results?: OpenverseResult[] }>(
        url.href,
        { headers: { accept: 'application/json', 'user-agent': userAgent } },
        {
          providerId: 'openverse',
          label: 'Openverse',
          fetch,
          apiKey: null,
          timeoutMs,
          ...(sleep ? { sleep } : {}),
          ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
        },
      );
    };
    let body = await run(true);
    if ((body.results ?? []).length === 0) body = await run(false);
    return (body.results ?? []).map(toCandidate).filter((c): c is ImageCandidate => c !== null);
  },
});
