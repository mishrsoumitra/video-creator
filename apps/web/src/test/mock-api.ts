import { vi } from 'vitest';

export type MockCall = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
};
export type MockContext = MockCall & { params: Record<string, string> };
type Handler = unknown | ((ctx: MockContext) => unknown);

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const apiError = (
  status: number,
  code: string,
  message: string,
  fields?: Array<{ path: string; message: string }>,
) => jsonResponse({ error: { code, message, ...(fields ? { fields } : {}) } }, status);

const match = (pattern: string, path: string): Record<string, string> | null => {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return params;
};

/** Stubs global fetch with a tiny router: keys are "METHOD /api/path/:param". */
export const mockApi = (routes: Record<string, Handler>) => {
  const calls: MockCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // keep raw text
      }
    }
    const call: MockCall = { method, path: url.pathname, query: url.searchParams, body, headers };
    calls.push(call);
    for (const [key, handler] of Object.entries(routes)) {
      const [m, pattern] = key.split(' ') as [string, string];
      if (m !== method) continue;
      const params = match(pattern, url.pathname);
      if (!params) continue;
      const result =
        typeof handler === 'function'
          ? await (handler as (ctx: MockContext) => unknown)({ ...call, params })
          : handler;
      if (result instanceof Response) return result;
      if (result === undefined) return new Response(null, { status: 204 });
      return jsonResponse(result);
    }
    return apiError(404, 'not_found', `No mock for ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    calls,
    callsTo: (method: string, path: string) =>
      calls.filter((c) => c.method === method && match(path, c.path) !== null),
  };
};

/** A controllable EventSource for job updates. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  emit(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
  close() {
    this.closed = true;
  }
}
