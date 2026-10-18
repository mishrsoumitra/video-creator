import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  initialConfig,
  mergeConfig,
  type JobDetail,
} from '@vc/config';
import { measureLoudness, probeMedia } from '@vc/media';
import { candidate, FakeImageSource } from '@vc/pipeline/testing';
import { createSafeDownloader } from '@vc/providers';
import { SecretScrubber } from '@vc/secrets';
import { writeSolidImage } from '@vc/media/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { googleFonts, libraryMusic } from './catalogs';
import { openDb, type Db } from './db';
import { createServerMedia } from './media';
import { createRemotionRenderer } from './renderer';
import { ACME_KEY, LockableVault, fakePageFetcher, fakeRegistry } from './test/fakes';

/*
 * The whole render path for real: ffmpeg mixing (with generated music), Remotion in headless
 * Chrome, image downloads through the SSRF-safe downloader, then mux, credits and checks. Only
 * the AI providers are fakes, so this runs without keys. Slow: `npm run test:render`.
 */

const repo = new URL('../../..', import.meta.url).pathname;
let dataDir: string;
let imageServer: Server;
let imagePort: number;
let app: FastifyInstance;
let db: Db;
let origin: string;

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null, raw: text };
};

const waitFor = async (id: string, statuses: string[], timeoutMs: number): Promise<JobDetail> => {
  const start = Date.now();
  for (;;) {
    const job = (await call('GET', `/api/jobs/${id}`)).body as JobDetail;
    if (statuses.includes(job.status)) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`stuck in ${job.status}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'vc-e2e-'));
  const images = join(dataDir, 'fixtures');
  await writeFile(join(dataDir, '.keep'), '');
  const files = new Map<string, string>();
  for (const [name, color] of [
    ['a.jpg', '#1d4ed8'],
    ['b.jpg', '#b45309'],
    ['c.jpg', '#047857'],
  ] as const) {
    const path = join(dataDir, name);
    await writeSolidImage({ path, width: 1600, height: 900, color });
    files.set(`/${name}`, path);
  }
  void images;
  imageServer = createServer((req, res) => {
    const path = files.get(req.url ?? '');
    if (!path) {
      res.writeHead(404).end();
      return;
    }
    void readFile(path).then((data) =>
      res.writeHead(200, { 'content-type': 'image/jpeg' }).end(data),
    );
  });
  await new Promise<void>((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
  imagePort = (imageServer.address() as AddressInfo).port;

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  db = openDb(join(dataDir, 'app.sqlite'));
  const names = ['a', 'b', 'c'];
  let n = 0;
  app = await buildApp({
    dataDir,
    db,
    vault: new LockableVault(),
    scrubber: new SecretScrubber(),
    registry: fakeRegistry(),
    media: createServerMedia({
      downloader: createSafeDownloader({
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        isAddressAllowed: () => true,
      }),
    }),
    renderer: createRemotionRenderer({
      bundleDir: null,
      entryPoint: join(repo, 'packages/composition/src/entry.ts'),
      publicDir: join(repo, 'packages/composition/public'),
    }),
    calibrator: null,
    imageSource: new FakeImageSource((q) => [
      candidate({
        id: `${q.query}-x`,
        title: `Apollo ${q.query}`,
        tags: ['rocket', 'launch'],
        url: `http://images.test:${imagePort}/${names[n++ % 3]}.jpg`,
        width: 1600,
        height: 900,
      }),
    ]),
    pageFetcher: fakePageFetcher(),
    fonts: googleFonts(),
    music: libraryMusic(dataDir),
    allowedHosts: [`127.0.0.1:${port}`],
    allowedOrigins: [origin],
    publicOrigin: origin,
    webDistDir: null,
    platform: process.platform,
    cpuCount: 8,
    now: () => new Date(),
    newId: () => `e2e${Date.now()}`,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port });

  await call('PUT', '/api/credentials/acme', { apiKey: ACME_KEY });
  for (const role of ['text', 'search', 'voice', 'align']) {
    await call('PUT', `/api/setup/roles/${role}`, { mode: 'provider', providerId: 'acme' });
    await call('POST', `/api/setup/roles/${role}/test`);
  }
});

afterAll(async () => {
  await app?.close();
  db?.close();
  await new Promise<void>((resolve) => imageServer?.close(() => resolve()));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('end to end: API → pipeline → Remotion render → ffmpeg stitch → checks', () => {
  it('produces a finished video with mixed, loudness-normalised audio, captions and credits', async () => {
    const config = mergeConfig(initialConfig(), {
      output: { resolution: '720p' },
      audio: {
        music: { source: 'library', trackId: 'soft-pad', volume: 0.2 },
        loudnessTargetLufs: -16,
      },
    });
    const created = await call('POST', '/api/jobs', {
      topic: 'The Apollo program',
      lengthSeconds: 30,
      config,
    });
    expect(created.status, created.raw).toBe(202);
    const id = (created.body as { id: string }).id;

    const review = await waitFor(id, ['review', 'failed'], 120_000);
    expect(review.status, JSON.stringify(review.error)).toBe('review');
    expect(review.plan!.scenes.some((s) => s.visual.type === 'image')).toBe(true);

    expect((await call('POST', `/api/jobs/${id}/render`, { config })).status).toBe(202);
    const done = await waitFor(id, ['done', 'failed'], 600_000);
    expect(done.status, JSON.stringify(done.error)).toBe('done');

    const videoPath = join(dataDir, 'jobs', id, 'video.mp4');
    const probe = await probeMedia(videoPath);
    const video = probe.streams.find((s) => s.type === 'video')!;
    expect(video).toMatchObject({ codec: 'h264', width: 1280, height: 720 });
    expect(probe.streams.some((s) => s.type === 'audio')).toBe(true);
    expect(Math.abs(probe.durationMs - done.plan!.durationMs)).toBeLessThan(150);

    const loudness = await measureLoudness(join(dataDir, 'jobs', id, 'mix.wav'));
    expect(loudness.integratedLufs).toBeGreaterThan(-17.5);
    expect(loudness.integratedLufs).toBeLessThan(-14.5);

    const byId = Object.fromEntries(done.checks.map((c) => [c.id, c.status]));
    expect(byId).toMatchObject({ duration: 'pass', visuals: 'pass', 'audio-clipping': 'pass' });
    const credits = await readFile(join(dataDir, 'jobs', id, 'credits.txt'), 'utf8');
    expect(credits).toContain('Images');
    expect(credits).toContain('Soft pad');
    expect(
      (await readFile(join(dataDir, 'jobs', id, 'captions.srt'), 'utf8')).startsWith('1\n'),
    ).toBe(true);
    expect(done.render.elapsedMs).toBeGreaterThan(0);
  });
});
