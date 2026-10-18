/** Test helper: a recording fetch with scripted responses. Never touches the network. */

export type RecordedRequest = {
  url: URL;
  method: string;
  headers: Headers;
  bodyText: string | null;
  json: unknown;
  form: FormData | null;
  signal: AbortSignal | null;
};

export type FakeHandler = (request: RecordedRequest) => Response | Promise<Response>;

export const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });

export const bytesResponse = (
  bytes: Uint8Array,
  contentType = 'application/octet-stream',
  status = 200,
): Response => new Response(bytes, { status, headers: { 'content-type': contentType } });

/** Resolves only when the request is aborted, with the abort reason. */
export const hangUntilAborted: FakeHandler = (request) =>
  new Promise((_resolve, reject) => {
    if (!request.signal) return;
    if (request.signal.aborted) reject(request.signal.reason);
    request.signal.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
  });

/**
 * Pass one handler (used for every request) or a list (one per request, in order). Requests beyond
 * the list fail loudly so a test cannot silently make an extra call.
 */
export const createFakeFetch = (handlers: FakeHandler | FakeHandler[]) => {
  const requests: RecordedRequest[] = [];
  const queue = Array.isArray(handlers) ? [...handlers] : null;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const contentType = request.headers.get('content-type') ?? '';
    let bodyText: string | null = null;
    let json: unknown = undefined;
    let form: FormData | null = null;
    if (request.body) {
      if (contentType.includes('multipart/form-data')) {
        form = await request.formData();
      } else {
        bodyText = await request.text();
        if (contentType.includes('json')) {
          try {
            json = JSON.parse(bodyText);
          } catch {
            json = undefined;
          }
        }
      }
    }
    const recorded: RecordedRequest = {
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
      bodyText,
      json,
      form,
      signal: init?.signal ?? null,
    };
    requests.push(recorded);
    const handler = queue ? queue.shift() : (handlers as FakeHandler);
    if (!handler) throw new Error(`Unexpected extra request to ${recorded.url.href}`);
    return handler(recorded);
  };
  return { fetch, requests };
};

/** A deterministic 16-bit PCM sine wave, for fake audio. */
export const sinePcm = (seconds: number, sampleRate = 24_000, frequency = 220): Int16Array => {
  const out = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++)
    out[i] = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 8000);
  return out;
};

export const pcmBytes = (samples: Int16Array): Uint8Array =>
  new Uint8Array(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
