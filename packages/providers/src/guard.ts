import { isIP } from 'node:net';
import { ProviderError } from '@vc/pipeline';

export type GuardOptions = {
  providerId: string;
  apiKey: string | null;
  /** Exact hostnames the key may be sent to. */
  allowedHosts: readonly string[];
  /** Local providers may use plain http, but only to a loopback host. */
  allowHttpLocalhost?: boolean;
};

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const stripBrackets = (host: string) => host.replace(/^\[|\]$/g, '');

export const isLoopbackHost = (hostname: string): boolean => {
  const host = stripBrackets(hostname.toLowerCase());
  if (host === 'localhost') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  return host === '::1';
};

const requestUrl = (input: FetchInput): URL =>
  new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input);

const contains = (haystack: string, key: string) =>
  haystack.includes(key) || haystack.includes(encodeURIComponent(key));

const carriesKey = (input: FetchInput, init: FetchInit, key: string): boolean => {
  if (contains(requestUrl(input).href, key)) return true;
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  let found = false;
  headers.forEach((value) => {
    if (contains(value, key)) found = true;
  });
  if (found) return true;
  const body = init?.body;
  if (typeof body === 'string') return contains(body, key);
  if (body instanceof URLSearchParams) return contains(body.toString(), key);
  if (body instanceof FormData) {
    for (const [, value] of body.entries())
      if (typeof value === 'string' && contains(value, key)) return true;
  }
  return false;
};

const hostAllowed = (url: URL, options: GuardOptions): boolean => {
  const host = stripBrackets(url.hostname.toLowerCase());
  const listed = options.allowedHosts.some(
    (allowed) => stripBrackets(allowed.toLowerCase()) === host,
  );
  if (!listed) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && options.allowHttpLocalhost === true && isLoopbackHost(host);
};

/**
 * Wraps fetch so a request that carries the API key (URL, header or string body) is refused
 * before it leaves the process unless it goes to one of the provider's own hosts.
 */
export const guardedFetch = (fetchImpl: typeof fetch, options: GuardOptions): typeof fetch => {
  const guarded = (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const key = options.apiKey;
    if (key && carriesKey(input, init, key)) {
      const url = requestUrl(input);
      if (!hostAllowed(url, options)) {
        return Promise.reject(
          new ProviderError({
            providerId: options.providerId,
            code: 'key_host_mismatch',
            retryable: false,
            message: `Refusing to send the ${options.providerId} key to ${url.protocol}//${url.host}; it may only go to ${options.allowedHosts.join(', ') || 'no host'}.`,
          }),
        );
      }
    }
    return fetchImpl(input, init);
  };
  return guarded as typeof fetch;
};
