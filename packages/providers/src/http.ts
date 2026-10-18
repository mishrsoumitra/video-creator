import { ProviderError, type ProviderErrorCode } from '@vc/pipeline';

export const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2;
/** Longer waits are not worth holding a job for; the error surfaces instead. */
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_MESSAGE_CHARS = 400;

export type HttpOptions = {
  providerId: string;
  /** Human name used in error messages. */
  label?: string;
  fetch: typeof fetch;
  /** Scrubbed from every error message. */
  apiKey: string | null;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
};

export type HttpInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: RequestInit['body'];
};

/** Replaces every occurrence of the secret, raw and URL-encoded, with "[redacted]". */
export const scrub = (text: string, secret: string | null | undefined): string => {
  if (!secret) return text;
  let out = text;
  for (const form of new Set([secret, encodeURIComponent(secret)]))
    out = out.split(form).join('[redacted]');
  return out;
};

/** Retry-After as milliseconds: seconds or an HTTP date. */
export const parseRetryAfter = (value: string | null, now = Date.now()): number | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
};

const QUOTA =
  /insufficient_quota|quota_exceeded|exceeded your current quota|billing hard limit|credit balance is too low/i;
const BAD_KEY =
  /API_KEY_INVALID|API key not valid|invalid[ _-]?(x-)?api[ _-]?key|incorrect api key/i;

const pickMessage = (body: unknown): string | null => {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const fromError = record.error;
  if (typeof fromError === 'string') return fromError;
  if (fromError && typeof fromError === 'object') {
    const message = (fromError as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  const detail = record.detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object') {
    const message = (detail as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return typeof record.message === 'string' ? record.message : null;
};

const codeForStatus = (status: number): ProviderErrorCode => {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'bad_request';
};

/** Maps an HTTP failure to a ProviderError with a scrubbed, length-limited message. */
export const errorFromResponse = (
  providerId: string,
  label: string,
  status: number,
  bodyText: string,
  apiKey: string | null,
): ProviderError => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = bodyText;
  }
  let code = codeForStatus(status);
  if ((status === 429 || status === 401 || status === 403) && QUOTA.test(bodyText)) code = 'quota';
  if (status === 400 && BAD_KEY.test(bodyText)) code = 'auth';
  const raw = (pickMessage(parsed) ?? bodyText).replace(/\s+/g, ' ').trim();
  const detail = scrub(raw, apiKey).slice(0, MAX_MESSAGE_CHARS);
  return new ProviderError({
    providerId,
    code,
    status,
    message: `${label} returned HTTP ${status}${detail ? `: ${detail}` : ''}`,
  });
};

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const describeFailure = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
  return `${error.message}${cause}`;
};

type Attempt = { response: Response; body: ArrayBuffer };

/** One request with timeout, error mapping and bounded retries. Returns the 2xx response body. */
const send = async (url: string, init: HttpInit, options: HttpOptions): Promise<Attempt> => {
  const label = options.label ?? options.providerId;
  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let attempt = 0;
  for (;;) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let error: ProviderError;
    let retryAfterMs: number | null = null;
    try {
      const response = await options.fetch(url, {
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.body ?? null,
        signal,
      });
      const body = await response.arrayBuffer();
      if (response.ok) return { response, body };
      error = errorFromResponse(
        options.providerId,
        label,
        response.status,
        new TextDecoder().decode(body),
        options.apiKey,
      );
      retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    } catch (caught) {
      if (caught instanceof ProviderError) throw caught;
      if (options.signal?.aborted) throw options.signal.reason;
      error = timeout.aborted
        ? new ProviderError({
            providerId: options.providerId,
            code: 'timeout',
            message: `${label} did not answer within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`,
          })
        : new ProviderError({
            providerId: options.providerId,
            code: 'network',
            message: scrub(`Could not reach ${label}: ${describeFailure(caught)}`, options.apiKey),
          });
    }
    if (
      !error.retryable ||
      attempt >= maxRetries ||
      (retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS)
    )
      throw error;
    const backoff = Math.min(8_000, 500 * 2 ** attempt) + random() * 250;
    await sleep(retryAfterMs ?? backoff, options.signal);
    attempt++;
  }
};

export const httpJson = async <T = unknown>(
  url: string,
  init: HttpInit,
  options: HttpOptions,
): Promise<T> => {
  const { body } = await send(url, init, options);
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError({
      providerId: options.providerId,
      code: 'invalid_response',
      retryable: false,
      message: `${options.label ?? options.providerId} sent a response that is not JSON: ${scrub(text.slice(0, 120), options.apiKey)}`,
    });
  }
};

export const httpBytes = async (
  url: string,
  init: HttpInit,
  options: HttpOptions,
): Promise<{ bytes: Uint8Array; contentType: string | null }> => {
  const { response, body } = await send(url, init, options);
  return { bytes: new Uint8Array(body), contentType: response.headers.get('content-type') };
};

export const invalidResponse = (providerId: string, message: string): ProviderError =>
  new ProviderError({ providerId, code: 'invalid_response', retryable: false, message });
