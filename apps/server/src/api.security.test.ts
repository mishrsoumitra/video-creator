import { CLIENT_HEADER } from '@vc/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOST, ORIGIN, createTestServer, type TestServer } from './test/harness';

let s: TestServer;
beforeEach(async () => {
  s = await createTestServer();
});
afterEach(async () => {
  await s.close();
});

describe('local server security', () => {
  it('answers health checks', async () => {
    const res = await s.api.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const res = await s.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example:4317' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'bad_host' } });
  });

  it('rejects mutating requests without the client header (cross-site requests cannot set it)', async () => {
    const res = await s.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'forbidden_origin' } });
  });

  it('rejects mutating requests from another origin', async () => {
    const res = await s.api.put('/api/settings', {}, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('accepts the UI’s own origin and the dev server', async () => {
    expect((await s.api.put('/api/settings', {})).status).toBe(200);
    expect((await s.api.put('/api/settings', {}, { origin: 'http://localhost:5173' })).status).toBe(
      200,
    );
  });

  it('accepts same-origin requests that send no Origin header but do send the client header', async () => {
    const res = await s.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { host: HOST, [CLIENT_HEADER]: 'web', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
  });

  it('sets defensive headers', async () => {
    const res = await s.api.get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('lets the local renderer (another localhost port) load job assets, and nobody else', async () => {
    const local = await s.api.get('/api/jobs/nope/assets/x.jpg', {
      origin: 'http://localhost:3000',
    });
    expect(local.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const foreign = await s.api.get('/api/jobs/nope/assets/x.jpg', {
      origin: 'https://evil.example',
    });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
});
