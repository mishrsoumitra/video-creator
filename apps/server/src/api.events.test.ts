import { createServer, type AddressInfo } from 'node:net';
import { initialConfig, type JobEvent } from '@vc/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServer } from './test/harness';

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });

let s: TestServer;
let port: number;
beforeEach(async () => {
  port = await freePort();
  // fetch() sets Host from the URL, so the server must accept this port's Host header.
  s = await createTestServer({ allowedHosts: ['127.0.0.1:4317', `127.0.0.1:${port}`] });
});
afterEach(async () => {
  await s.close();
});

describe('live job events (server-sent events)', () => {
  it('streams the job snapshot first, then updates until review', async () => {
    await s.completeSetup();
    await s.app.listen({ host: '127.0.0.1', port });
    const id = (
      (
        await s.api.post('/api/jobs', {
          topic: 'The Apollo program',
          lengthSeconds: 30,
          config: initialConfig(),
        })
      ).body as { id: string }
    ).id;

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs/${id}/events`, {
      signal: controller.signal,
    });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: JobEvent[] = [];
    let buffer = '';
    while (!events.some((e) => e.type === 'job' && e.job.status === 'review')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop()!;
      for (const part of parts)
        if (part.startsWith('data: ')) events.push(JSON.parse(part.slice(6)) as JobEvent);
    }
    controller.abort();
    expect(events[0]).toMatchObject({ type: 'job' });
    expect(
      events.filter((e) => e.type === 'job').map((e) => (e.type === 'job' ? e.job.status : '')),
    ).toContain('preparing');
    expect(events.at(-1)).toMatchObject({ type: 'job', job: { status: 'review' } });
  });

  it('404s for an unknown job', async () => {
    expect((await s.api.get('/api/jobs/nope/events')).status).toBe(404);
  });
});
