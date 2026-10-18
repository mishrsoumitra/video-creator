import { CLIENT_HEADER, CLIENT_HEADER_VALUE, initialConfig } from '@vc/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, api, connectJobEvents } from './api';
import { FakeEventSource, apiError, mockApi } from './test/mock-api';
import { completeSetup, jobDetail, settingsResponse } from './test/fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe('api client', () => {
  it('GETs without the client header and parses JSON', async () => {
    const m = mockApi({ 'GET /api/setup': completeSetup() });
    expect((await api.getSetup()).complete).toBe(true);
    expect(m.calls[0]!.headers.get(CLIENT_HEADER)).toBeNull();
  });

  it('sends the client header and a JSON body on every mutating request', async () => {
    const m = mockApi({
      'PUT /api/settings': (ctx: { body: unknown }) => ctx.body,
      'DELETE /api/presets/:id': undefined,
      'POST /api/jobs': { id: 'job9' },
    });
    await api.putSettings({ ...settingsResponse(), costCapUsd: 3 });
    await api.deletePreset('mine');
    const created = await api.createJob({
      topic: 'Volcanoes',
      lengthSeconds: 60,
      config: initialConfig(),
    });
    expect(created.id).toBe('job9');
    for (const call of m.calls) expect(call.headers.get(CLIENT_HEADER)).toBe(CLIENT_HEADER_VALUE);
    expect(m.calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(m.calls[0]!.body).toEqual({ ...settingsResponse(), costCapUsd: 3 });
  });

  it('sends no content type on bodiless POSTs, which the server would reject as an empty JSON body', async () => {
    const m = mockApi({
      'POST /api/vault/lock': completeSetup(),
      'POST /api/setup/roles/:role/test': { ok: true },
    });
    await api.vaultLock();
    await api.testRole('text');
    for (const call of m.calls) {
      expect(call.headers.get('content-type')).toBeNull();
      expect(call.body).toBeUndefined();
      expect(call.headers.get(CLIENT_HEADER)).toBe(CLIENT_HEADER_VALUE);
    }
  });

  it('turns an ApiError body into an ApiRequestError with code, message and fields', async () => {
    mockApi({
      'POST /api/jobs': apiError(400, 'invalid_request', 'Check the fields.', [
        { path: 'topic', message: 'Too short' },
      ]),
    });
    const error = await api
      .createJob({ topic: 'x', lengthSeconds: 60, config: initialConfig() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: 'Check the fields.',
      fields: [{ path: 'topic', message: 'Too short' }],
    });
  });

  it('falls back to a generic error for non-JSON failures', async () => {
    mockApi({ 'GET /api/jobs': new Response('Bad gateway', { status: 502 }) });
    await expect(api.listJobs()).rejects.toMatchObject({ status: 502, code: 'http_502' });
  });

  it('uploads files as multipart with the kind in the query', async () => {
    const m = mockApi({
      'POST /api/uploads': { id: 'upl1', kind: 'recording', name: 'take.wav', durationMs: 4000 },
    });
    const file = new File([new Uint8Array([1, 2, 3])], 'take.wav', { type: 'audio/wav' });
    const res = await api.upload('recording', file);
    expect(res.id).toBe('upl1');
    expect(m.calls[0]!.query.get('kind')).toBe('recording');
    expect(m.calls[0]!.body).toBeInstanceOf(FormData);
    expect(m.calls[0]!.headers.get('content-type')).toBeNull();
    expect(m.calls[0]!.headers.get(CLIENT_HEADER)).toBe(CLIENT_HEADER_VALUE);
  });

  it('encodes path segments', async () => {
    const m = mockApi({
      'GET /api/fonts/:family': { fontFamily: 'Playfair Display', importName: 'PlayfairDisplay' },
    });
    await api.getFont('Playfair Display');
    expect(m.calls[0]!.path).toBe('/api/fonts/Playfair%20Display');
  });
});

describe('connectJobEvents', () => {
  it('streams job events through EventSource', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const seen: string[] = [];
    const stop = connectJobEvents('job1', (e) => seen.push(e.type));
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/jobs/job1/events');
    source.emit({ type: 'job', job: jobDetail() });
    source.emit({ type: 'progress', stage: 'render', progress: 0.5 });
    expect(seen).toEqual(['job', 'progress']);
    stop?.();
    expect(source.closed).toBe(true);
  });

  it('ignores malformed messages', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const seen: unknown[] = [];
    connectJobEvents('job1', (e) => seen.push(e));
    FakeEventSource.instances[0]!.onmessage?.(new MessageEvent('message', { data: 'not json' }));
    expect(seen).toEqual([]);
  });

  it('reports that streaming is unavailable when EventSource is missing', () => {
    vi.stubGlobal('EventSource', undefined);
    expect(connectJobEvents('job1', () => {})).toBeNull();
  });
});
