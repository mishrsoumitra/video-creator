import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Readability } from '@mozilla/readability';
import { ProviderError, type FetchedPage, type PageFetcher } from '@vc/pipeline';
import { parseHTML } from 'linkedom';
import { errorFromResponse } from './http';

/*
 * Fetches public web pages for research, safely. Search results can point anywhere, and this
 * server runs on the user's machine next to their LAN and cloud metadata endpoints, so:
 * only http(s), no credentials in URLs, no local host names, and every resolved address must be
 * public. The connection is pinned to the addresses that were checked (a custom `lookup`), so a
 * DNS answer cannot change between the check and the connect. Redirects are followed by hand and
 * re-checked hop by hop. No cookies or auth headers are ever sent; bodies are capped after
 * decompression.
 */

const ID = 'web';

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type DnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export type PageFetcherOptions = {
  lookup?: DnsLookup;
  /** Defaults to "public addresses only". Tests override it to reach a local server. */
  isAddressAllowed?: (address: string) => boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
};

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** Expands an IPv6 address to eight 16-bit groups (handles "::" and a trailing dotted quad). */
const ipv6Groups = (input: string): number[] | null => {
  let address = input
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    address = `${address.slice(0, -dotted[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(0, fill)).fill('0'), ...tail];
  return groups.length === 8 ? groups.map((g) => Number.parseInt(g, 16)) : null;
};

/** True for anything that is not a public unicast address, including non-addresses. */
export const isBlockedAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) return blocked.check(address, 'ipv4');
  if (version !== 6) return true;
  const groups = ipv6Groups(address);
  if (!groups) return true;
  // IPv4-mapped (::ffff:a.b.c.d): never used by public DNS, always refused.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return true;
  // NAT64 (64:ff9b::/96): judge the embedded IPv4 address.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    const v4 = `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
    return blocked.check(v4, 'ipv4');
  }
  return blocked.check(address, 'ipv6');
};

const refuse = (message: string) =>
  new ProviderError({ providerId: ID, code: 'bad_request', retryable: false, message });

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|localdomain)$/;

const parse = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refuse(`Not a valid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw refuse(`Only http and https pages can be fetched (${url.protocol}).`);
  if (url.username || url.password) throw refuse('URLs with credentials are not fetched.');
  return url;
};

const defaultLookup: DnsLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));

const ALLOWED_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);

/* ------------------------------------------------------- readable text */

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BR',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL',
]);
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'SVG',
  'IFRAME',
  'HEAD',
  'CANVAS',
  'OBJECT',
]);

type DomNode = {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  tagName?: string;
};

const blockText = (root: DomNode | null | undefined): string => {
  if (!root) return '';
  const out: string[] = [];
  const walk = (node: DomNode) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) out.push(child.textContent ?? '');
      else if (child.nodeType === 1) {
        const tag = (child.tagName ?? '').toUpperCase();
        if (SKIP_TAGS.has(tag)) continue;
        const block = BLOCK_TAGS.has(tag);
        if (block) out.push('\n');
        walk(child);
        if (block) out.push('\n');
      }
    }
  };
  walk(root);
  return out
    .join('')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
};

/** The slice of linkedom's document we use (its own typings lean on ambient DOM globals). */
type HtmlDocument = {
  querySelector(selector: string): { textContent: string | null } | null;
  querySelectorAll(selector: string): Iterable<{ remove(): void }>;
  body: unknown;
  documentElement: unknown;
};
const parseDocument = (html: string): HtmlDocument =>
  (parseHTML(html) as unknown as { document: HtmlDocument }).document;

/** Readability first; the stripped body when Readability finds less than a paragraph or two. */
export const htmlToReadableText = (html: string): { title: string; text: string } => {
  const document = parseDocument(html);
  const documentTitle = (document.querySelector('title')?.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  let articleText = '';
  let articleTitle = '';
  try {
    const article = new Readability(document as unknown as Document).parse();
    articleTitle = article?.title?.trim() ?? '';
    if (article?.content)
      articleText = blockText(
        parseDocument(`<!doctype html><html><body>${article.content}</body></html>`)
          .body as DomNode,
      );
  } catch {
    articleText = '';
  }
  const title = documentTitle || articleTitle;
  if (articleText.length >= 200) return { title, text: articleText };
  const fallback = parseDocument(html);
  for (const node of fallback.querySelectorAll(
    'script,style,noscript,template,svg,iframe,nav,header,footer,aside,form,button',
  ))
    node.remove();
  const bodyText = blockText((fallback.body ?? fallback.documentElement) as DomNode);
  return { title, text: bodyText.length >= articleText.length ? bodyText : articleText };
};

/* ------------------------------------------------------------ transport */

type RawResponse = { status: number; headers: IncomingMessage['headers']; body: Readable };

const pinnedLookup = (addresses: ResolvedAddress[]): LookupFunction =>
  ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options.all)
      callback(
        null,
        addresses.map(({ address, family }) => ({ address, family })),
      );
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  }) as unknown as LookupFunction;

const open = (
  url: URL,
  addresses: ResolvedAddress[] | null,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const options: RequestOptions = {
      method: 'GET',
      headers,
      signal,
      agent: false,
      ...(addresses ? { lookup: pinnedLookup(addresses) } : {}),
    };
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, (res) =>
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }),
    );
    req.on('error', reject);
    req.end();
  });

const readCapped = (
  res: RawResponse,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> =>
  new Promise((resolve, reject) => {
    const encoding = String(res.headers['content-encoding'] ?? '')
      .toLowerCase()
      .trim();
    const stream: Readable =
      encoding === 'gzip' || encoding === 'x-gzip'
        ? res.body.pipe(createGunzip())
        : encoding === 'deflate'
          ? res.body.pipe(createInflate())
          : encoding === 'br'
            ? res.body.pipe(createBrotliDecompress())
            : res.body;
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    let truncated = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ bytes: Buffer.concat(chunks), truncated });
    };
    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      const room = maxBytes - size;
      if (chunk.length >= room) {
        if (chunk.length > room) truncated = true;
        chunks.push(chunk.subarray(0, room));
        size = maxBytes;
        finish();
        res.body.destroy();
        if (stream !== res.body) stream.destroy();
      } else {
        chunks.push(chunk);
        size += chunk.length;
      }
    });
    stream.on('end', finish);
    stream.on('error', (error) => {
      if (!done) {
        done = true;
        reject(error);
      }
    });
  });

const decode = (bytes: Buffer, contentType: string, isHtml: boolean): string => {
  let label = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!label && isHtml)
    label = /<meta[^>]+charset=["']?([\w-]+)/i.exec(
      bytes.subarray(0, 2048).toString('latin1'),
    )?.[1];
  try {
    return new TextDecoder(label ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
};

const titleFromUrl = (url: URL) => {
  const last = url.pathname.split('/').filter(Boolean).at(-1);
  try {
    return last ? decodeURIComponent(last) : url.hostname;
  } catch {
    return url.hostname;
  }
};

type SafeGetOptions = {
  accept: string;
  isAllowedType: (mime: string) => boolean;
  typeError: (url: URL, mime: string) => string;
  maxBytes: number;
  signal?: AbortSignal | undefined;
};

type SafeGetResult = {
  url: URL;
  contentType: string;
  mime: string;
  bytes: Buffer;
  truncated: boolean;
};

/** The shared hop-by-hop GET: vetted, pinned addresses, manual redirects, capped body. */
const createSafeGetter = ({
  lookup = defaultLookup,
  isAddressAllowed = (address: string) => !isBlockedAddress(address),
  timeoutMs = 15_000,
  maxRedirects = 5,
  userAgent = 'video-creator/0.1 (local app)',
}: Omit<PageFetcherOptions, 'maxBytes'>) => {
  /** Validates the URL and returns the addresses to connect to (null for an IP literal). */
  const vet = async (url: URL): Promise<ResolvedAddress[] | null> => {
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
    if (isIP(host)) {
      if (!isAddressAllowed(host))
        throw refuse(`Refusing to fetch ${host}: it is a private or local address.`);
      return null;
    }
    if (!host.includes('.') || LOCAL_NAMES.test(host))
      throw refuse(`Refusing to fetch ${host}: local host names are not allowed.`);
    let addresses: ResolvedAddress[];
    try {
      addresses = await lookup(host);
    } catch (error) {
      throw new ProviderError({
        providerId: ID,
        code: 'network',
        retryable: false,
        message: `Could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (addresses.length === 0)
      throw new ProviderError({
        providerId: ID,
        code: 'network',
        retryable: false,
        message: `${host} has no addresses.`,
      });
    const bad = addresses.find((a) => !isAddressAllowed(a.address));
    if (bad)
      throw refuse(
        `Refusing to fetch ${host}: it resolves to a private or local address (${bad.address}).`,
      );
    return addresses;
  };

  return async (raw: string, options: SafeGetOptions): Promise<SafeGetResult> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const headers = {
      'user-agent': userAgent,
      accept: options.accept,
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en',
    };
    let url = parse(raw);
    try {
      for (let hop = 0; ; hop++) {
        const addresses = await vet(url);
        const res = await open(url, addresses, headers, signal);
        if (res.status >= 300 && res.status < 400 && res.headers.location) {
          res.body.resume();
          if (hop >= maxRedirects) throw refuse(`Too many redirects (more than ${maxRedirects}).`);
          url = parse(new URL(res.headers.location, url).href);
          continue;
        }
        if (res.status < 200 || res.status >= 300) {
          const { bytes } = await readCapped(res, 4096);
          throw errorFromResponse(
            ID,
            `The page ${url.hostname}`,
            res.status,
            bytes.toString('utf8'),
            null,
          );
        }
        const contentType = String(res.headers['content-type'] ?? '');
        const mime = contentType.split(';')[0]!.trim().toLowerCase();
        if (!options.isAllowedType(mime)) {
          res.body.resume();
          throw new ProviderError({
            providerId: ID,
            code: 'unsupported',
            retryable: false,
            message: options.typeError(url, mime),
          });
        }
        const { bytes, truncated } = await readCapped(res, options.maxBytes);
        return { url, contentType, mime, bytes, truncated };
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (options.signal?.aborted) throw options.signal.reason;
      if (timeout.aborted)
        throw new ProviderError({
          providerId: ID,
          code: 'timeout',
          message: `${url.hostname} did not answer within ${timeoutMs} ms.`,
        });
      throw new ProviderError({
        providerId: ID,
        code: 'network',
        message: `Could not fetch ${url.hostname}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
};

export const createPageFetcher = ({
  maxBytes = 2 * 1024 * 1024,
  userAgent = 'video-creator/0.1 (research fetcher; local app)',
  ...rest
}: PageFetcherOptions = {}): PageFetcher => {
  const get = createSafeGetter({ ...rest, userAgent });
  return {
    async fetchPage(raw, callOptions) {
      const res = await get(raw, {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        isAllowedType: (mime) => !mime || ALLOWED_TYPES.has(mime),
        typeError: (url, mime) => `${url.href} is not a web page (${mime}).`,
        maxBytes,
        signal: callOptions?.signal,
      });
      const isHtml = res.mime !== 'text/plain';
      const text = decode(res.bytes, res.contentType, isHtml);
      if (!isHtml)
        return {
          url: res.url.href,
          title: titleFromUrl(res.url),
          text: text.replace(/\r\n?/g, '\n').trim(),
        } satisfies FetchedPage;
      const readable = htmlToReadableText(text);
      return {
        url: res.url.href,
        title: readable.title || titleFromUrl(res.url),
        text: readable.text,
      };
    },
  };
};

export type SafeDownload = { url: string; contentType: string; bytes: Uint8Array };

/**
 * Downloads a public file (scene images) with the same protections as the page fetcher. A body
 * over the cap is refused, never truncated: a cut-off image is a corrupt image.
 */
export const createSafeDownloader = (options: Omit<PageFetcherOptions, 'maxBytes'> = {}) => {
  const get = createSafeGetter(options);
  return {
    async download(
      raw: string,
      {
        allowedTypes,
        maxBytes,
        signal,
      }: { allowedTypes: readonly string[]; maxBytes: number; signal?: AbortSignal },
    ): Promise<SafeDownload> {
      const res = await get(raw, {
        accept: allowedTypes.join(','),
        isAllowedType: (mime) => allowedTypes.includes(mime),
        typeError: (url, mime) =>
          `${url.href} is ${mime || 'of an unknown type'}, not ${allowedTypes.join(' or ')}.`,
        maxBytes,
        signal,
      });
      if (res.truncated)
        throw new ProviderError({
          providerId: ID,
          code: 'bad_request',
          retryable: false,
          message: `${res.url.href} is too large (over ${maxBytes} bytes).`,
        });
      return { url: res.url.href, contentType: res.mime, bytes: new Uint8Array(res.bytes) };
    },
  };
};
