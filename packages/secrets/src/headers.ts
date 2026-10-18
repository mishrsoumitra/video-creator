import { REDACTED } from './scrubber';

/** Headers provider keys (and sessions) travel in. Matched case-insensitively. */
export const SENSITIVE_HEADER_NAMES: readonly string[] = Object.freeze([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'xi-api-key',
  'x-goog-api-key',
  'ocp-apim-subscription-key',
  'x-subscription-token',
  'api-key',
  'cookie',
  'set-cookie',
]);

const SENSITIVE_HEADERS = new Set(SENSITIVE_HEADER_NAMES);

/** Query parameters that carry keys (SerpAPI and Google pass keys in the URL). */
const SENSITIVE_PARAMS = new Set([
  'api_key',
  'apikey',
  'api-key',
  'key',
  'token',
  'access_token',
  'refresh_token',
  'client_secret',
  'secret',
  'password',
  'sig',
  'signature',
  'x-goog-api-key',
]);

export type HeaderInput =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string | readonly string[] | number | undefined>;

/** A plain-object copy of headers with sensitive values replaced by [REDACTED]. */
export const redactHeaders = (headers: HeaderInput): Record<string, string | string[]> => {
  const entries: Array<[string, string | string[]]> = [];
  if (headers instanceof Headers) {
    headers.forEach((value, name) => entries.push([name, value]));
  } else if (Array.isArray(headers)) {
    for (const [name, value] of headers as ReadonlyArray<readonly [string, string]>)
      entries.push([name, value]);
  } else {
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      entries.push([name, Array.isArray(value) ? value.map(String) : String(value)]);
    }
  }
  return Object.fromEntries(
    entries.map(([name, value]) => [
      name,
      SENSITIVE_HEADERS.has(name.toLowerCase())
        ? Array.isArray(value)
          ? value.map(() => REDACTED)
          : REDACTED
        : value,
    ]),
  );
};

/**
 * Masks key-like query parameters and userinfo passwords. Works on full URLs and on log text that
 * merely contains a query string; everything else is left byte-for-byte unchanged.
 */
export const redactUrl = (url: string): string =>
  url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#:@\s]+):([^@/?#\s]+)@/i, `$1:${REDACTED}@`)
    .replace(/([?&;])([^=&#\s]+)=([^&#\s]*)/g, (match, separator: string, name: string) =>
      SENSITIVE_PARAMS.has(name.toLowerCase()) ? `${separator}${name}=${REDACTED}` : match,
    );
