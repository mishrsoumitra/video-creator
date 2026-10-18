import { ProviderError } from '@vc/pipeline';
import { describe, expect, it } from 'vitest';
import { errorFromResponse, httpBytes, httpJson, parseRetryAfter, scrub } from './http';
import { createFakeFetch, hangUntilAborted, jsonResponse } from './testing/fake-fetch';

const KEY = 'sk-test-SECRET+key/123456789';
const noSleep = () => Promise.resolve();

const options = (
  fetch: typeof globalThis.fetch,
  extra: Partial<Parameters<typeof httpJson>[2]> = {},
) => ({
  providerId: 'acme',
  label: 'Acme',
  fetch,
  apiKey: KEY,
  sleep: noSleep,
  random: () => 0,
  ...extra,
});

const caught = async (promise: Promise<unknown>): Promise<ProviderError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error('expected a rejection');
};

describe('httpJson', () => {
  it('returns the parsed body and sends the request as given', async () => {
    const fake = createFakeFetch(() => jsonResponse({ ok: true }));
    const data = await httpJson<{ ok: boolean }>(
      'https://api.acme.test/v1/x',
      { method: 'POST', headers: { 'x-a': '1' }, body: '{"q":1}' },
      options(fake.fetch),
    );
    expect(data).toEqual({ ok: true });
    expect(fake.requests[0]!.method).toBe('POST');
    expect(fake.requests[0]!.headers.get('x-a')).toBe('1');
    expect(fake.requests[0]!.bodyText).toBe('{"q":1}');
  });

  it('maps an unparseable success body to invalid_response', async () => {
    const fake = createFakeFetch(() => new Response('<html>oops</html>', { status: 200 }));
    const error = await caught(httpJson('https://api.acme.test', {}, options(fake.fetch)));
    expect(error.code).toBe('invalid_response');
    expect(error.retryable).toBe(false);
  });

  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [402, 'quota', false],
    [404, 'not_found', false],
    [400, 'bad_request', false],
    [422, 'bad_request', false],
    [429, 'rate_limit', true],
    [500, 'server', true],
    [503, 'server', true],
    [529, 'server', true],
  ] as const)('maps HTTP %d to %s', async (status, code, retryable) => {
    const fake = createFakeFetch(() => jsonResponse({ error: { message: 'nope' } }, { status }));
    const error = await caught(
      httpJson('https://api.acme.test', {}, options(fake.fetch, { maxRetries: 0 })),
    );
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(retryable);
    expect(error.providerId).toBe('acme');
    expect(error.message).toContain('nope');
  });

  it('treats a 429 that says insufficient_quota as quota, and does not retry it', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse(
        { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } },
        { status: 429 },
      ),
    );
    const error = await caught(httpJson('https://api.acme.test', {}, options(fake.fetch)));
    expect(error.code).toBe('quota');
    expect(fake.requests).toHaveLength(1);
  });

  it('treats a 400 that says the API key is invalid as auth', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse(
        {
          error: {
            status: 'INVALID_ARGUMENT',
            message: 'API key not valid. Please pass a valid API key.',
          },
        },
        { status: 400 },
      ),
    );
    expect((await caught(httpJson('https://api.acme.test', {}, options(fake.fetch)))).code).toBe(
      'auth',
    );
  });

  it('retries retryable failures twice with exponential backoff, then gives up', async () => {
    const delays: number[] = [];
    const fake = createFakeFetch(() =>
      jsonResponse({ error: { message: 'busy' } }, { status: 503 }),
    );
    const error = await caught(
      httpJson(
        'https://api.acme.test',
        {},
        options(fake.fetch, { sleep: async (ms) => void delays.push(ms) }),
      ),
    );
    expect(error.code).toBe('server');
    expect(fake.requests).toHaveLength(3);
    expect(delays).toHaveLength(2);
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
  });

  it('succeeds when a retry succeeds', async () => {
    const fake = createFakeFetch([
      () => jsonResponse({}, { status: 502 }),
      () => jsonResponse({ fine: 1 }),
    ]);
    expect(await httpJson('https://api.acme.test', {}, options(fake.fetch))).toEqual({ fine: 1 });
  });

  it('honours Retry-After', async () => {
    const delays: number[] = [];
    const fake = createFakeFetch([
      () => jsonResponse({}, { status: 429, headers: { 'retry-after': '2' } }),
      () => jsonResponse({ ok: 1 }),
    ]);
    await httpJson(
      'https://api.acme.test',
      {},
      options(fake.fetch, { sleep: async (ms) => void delays.push(ms) }),
    );
    expect(delays).toEqual([2000]);
  });

  it('does not wait out an absurd Retry-After; it fails instead', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse({}, { status: 429, headers: { 'retry-after': '3600' } }),
    );
    const error = await caught(httpJson('https://api.acme.test', {}, options(fake.fetch)));
    expect(error.code).toBe('rate_limit');
    expect(fake.requests).toHaveLength(1);
  });

  it('never retries client errors', async () => {
    const fake = createFakeFetch(() => jsonResponse({}, { status: 400 }));
    await caught(httpJson('https://api.acme.test', {}, options(fake.fetch)));
    expect(fake.requests).toHaveLength(1);
  });

  it('turns a network failure into a retryable network error', async () => {
    const fake = createFakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const error = await caught(httpJson('https://api.acme.test', {}, options(fake.fetch)));
    expect(error.code).toBe('network');
    expect(fake.requests).toHaveLength(3);
  });

  it('times out slow requests', async () => {
    const fake = createFakeFetch(hangUntilAborted);
    const error = await caught(
      httpJson('https://api.acme.test', {}, options(fake.fetch, { timeoutMs: 15, maxRetries: 1 })),
    );
    expect(error.code).toBe('timeout');
    expect(fake.requests).toHaveLength(2);
  });

  it('stops immediately, without retrying, when the caller aborts', async () => {
    const controller = new AbortController();
    const fake = createFakeFetch((request) => {
      controller.abort(new DOMException('stop', 'AbortError'));
      return hangUntilAborted(request);
    });
    await expect(
      httpJson('https://api.acme.test', {}, options(fake.fetch, { signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.requests).toHaveLength(1);
  });

  it('never leaks the key, raw or URL-encoded, in an error message', async () => {
    const fake = createFakeFetch([
      () =>
        jsonResponse(
          { error: `bad key ${KEY} for https://x.test/?api_key=${encodeURIComponent(KEY)}` },
          { status: 401 },
        ),
      () => {
        throw new TypeError(
          `fetch failed for https://serpapi.com/search.json?api_key=${encodeURIComponent(KEY)}`,
        );
      },
    ]);
    const first = await caught(httpJson('https://api.acme.test', {}, options(fake.fetch)));
    expect(first.message).not.toContain(KEY);
    expect(first.message).not.toContain(encodeURIComponent(KEY));
    expect(first.message).toContain('[redacted]');
    const second = await caught(
      httpJson('https://api.acme.test', {}, options(fake.fetch, { maxRetries: 0 })),
    );
    expect(second.message).not.toContain(encodeURIComponent(KEY));
    expect(JSON.stringify(second)).not.toContain(encodeURIComponent(KEY));
  });
});

describe('httpBytes', () => {
  it('returns raw bytes and the content type', async () => {
    const fake = createFakeFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/wav' } }),
    );
    const out = await httpBytes(
      'https://api.acme.test/speech',
      { method: 'POST' },
      options(fake.fetch),
    );
    expect([...out.bytes]).toEqual([1, 2, 3]);
    expect(out.contentType).toBe('audio/wav');
  });

  it('maps errors like httpJson does', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse(
        { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota.' } },
        { status: 401 },
      ),
    );
    expect((await caught(httpBytes('https://api.acme.test', {}, options(fake.fetch)))).code).toBe(
      'quota',
    );
  });
});

describe('helpers', () => {
  it('scrubs every occurrence of a secret and its URL encoding', () => {
    expect(scrub(`a ${KEY} b ${encodeURIComponent(KEY)}`, KEY)).toBe('a [redacted] b [redacted]');
    expect(scrub('nothing here', KEY)).toBe('nothing here');
    expect(scrub('x', null)).toBe('x');
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('pulls the message out of each vendor’s error shape', () => {
    const message = (body: unknown) =>
      errorFromResponse('acme', 'Acme', 400, JSON.stringify(body), null).message;
    expect(message({ error: { message: 'openai style' } })).toContain('openai style');
    expect(
      message({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'anthropic style' },
      }),
    ).toContain('anthropic style');
    expect(message({ detail: { message: 'elevenlabs style' } })).toContain('elevenlabs style');
    expect(message({ detail: 'plain detail' })).toContain('plain detail');
    expect(message({ error: 'serpapi style' })).toContain('serpapi style');
    expect(
      errorFromResponse('acme', 'Acme', 500, 'x'.repeat(5000), null).message.length,
    ).toBeLessThan(600);
  });
});
