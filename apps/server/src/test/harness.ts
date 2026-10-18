import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, type JobDetail, type SetupState } from '@vc/config';
import { SecretScrubber, type SecretVault } from '@vc/secrets';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { openDb, type Db } from '../db';
import type { ServerDeps } from '../services';
import {
  ACME_KEY,
  FakeRenderer,
  LockableVault,
  fakeFonts,
  fakeImageSource,
  fakeMedia,
  fakeMusic,
  fakePageFetcher,
  fakeRegistry,
} from './fakes';

export const HOST = '127.0.0.1:4317';
export const ORIGIN = `http://${HOST}`;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type TestServer = Awaited<ReturnType<typeof createTestServer>>;

export const createTestServer = async (
  overrides: Partial<ServerDeps> & { vault?: SecretVault } = {},
) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vc-server-'));
  const db: Db = overrides.db ?? openDb(join(dataDir, 'app.sqlite'));
  const renderer = new FakeRenderer();
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, done) {
      logs.push(String(chunk));
      done();
    },
  });
  let id = 0;
  const deps: ServerDeps = {
    dataDir,
    db,
    vault: overrides.vault ?? new LockableVault(),
    scrubber: new SecretScrubber(),
    registry: fakeRegistry(),
    media: fakeMedia(),
    renderer,
    calibrator: null,
    imageSource: fakeImageSource(),
    pageFetcher: fakePageFetcher(),
    fonts: fakeFonts(),
    music: fakeMusic(dataDir),
    allowedHosts: [HOST, 'localhost:4317'],
    allowedOrigins: [ORIGIN, 'http://localhost:5173'],
    publicOrigin: ORIGIN,
    webDistDir: null,
    platform: 'darwin',
    cpuCount: 8,
    now: () => new Date(),
    newId: () => `job${String(++id).padStart(4, '0')}`,
    logger: { level: 'info', stream: logStream },
    ...overrides,
  };
  const app: FastifyInstance = await buildApp(deps);
  await app.ready();

  const call = async (
    method: Method,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url,
      headers: {
        host: HOST,
        origin: ORIGIN,
        [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    return {
      status: res.statusCode,
      body: res.body ? safeJson(res.body) : null,
      raw: res.body,
      headers: res.headers,
    };
  };

  const api = {
    get: (url: string, headers?: Record<string, string>) => call('GET', url, undefined, headers),
    post: (url: string, body: unknown = {}, headers?: Record<string, string>) =>
      call('POST', url, body, headers),
    put: (url: string, body: unknown, headers?: Record<string, string>) =>
      call('PUT', url, body, headers),
    del: (url: string, headers?: Record<string, string>) => call('DELETE', url, undefined, headers),
  };

  /** Fills every role with Acme (one key, several slots) and passes every test call. */
  const completeSetup = async (
    patch: {
      voice?: 'acme' | 'labs' | 'off';
      search?: 'acme' | 'off';
      vision?: 'acme' | 'off';
      align?: 'acme' | 'off' | 'localai';
    } = {},
  ) => {
    await api.put('/api/credentials/acme', { apiKey: ACME_KEY });
    const roles: Array<[string, string]> = [
      ['text', 'acme'],
      ['search', patch.search ?? 'acme'],
      ['voice', patch.voice ?? 'acme'],
      ['align', patch.align ?? 'acme'],
      ['vision', patch.vision ?? 'off'],
    ];
    for (const [role, provider] of roles) {
      const body =
        provider === 'off' ? { mode: 'off' } : { mode: 'provider', providerId: provider };
      const res = await api.put(`/api/setup/roles/${role}`, body);
      if (res.status !== 200) throw new Error(`PUT role ${role} failed: ${res.raw}`);
      if (provider !== 'off') {
        const test = await api.post(`/api/setup/roles/${role}/test`);
        if (!(test.body as { ok: boolean }).ok) throw new Error(`test ${role} failed: ${test.raw}`);
      }
    }
    return (await api.get('/api/setup')).body as SetupState;
  };

  const waitForJob = async (
    jobId: string,
    statuses: string[],
    timeoutMs = 10_000,
  ): Promise<JobDetail> => {
    const start = Date.now();
    for (;;) {
      const res = await api.get(`/api/jobs/${jobId}`);
      const job = res.body as JobDetail;
      if (statuses.includes(job.status)) return job;
      if (Date.now() - start > timeoutMs)
        throw new Error(`job ${jobId} stuck in ${job.status}: ${res.raw}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const close = async () => {
    await app.close();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  };

  return { app, deps, db, renderer, api, logs, dataDir, completeSetup, waitForJob, close };
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
