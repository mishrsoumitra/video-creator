import { rm } from 'node:fs/promises';
import {
  initialConfig,
  mergeConfig,
  type CatalogResponse,
  type JobDetail,
  type SetupState,
  type UploadResponse,
} from '@vc/config';
import { encodeTestWav } from '@vc/pipeline/testing';
import {
  VaultBackendError,
  VaultCorruptError,
  VaultSetupError,
  WeakPassphraseError,
} from '@vc/secrets';
import { afterEach, describe, expect, it } from 'vitest';
import type { Calibrator, ServerMedia } from './services';
import { ACME_KEY, LABS_KEY, LockableVault, fakeMedia, fakeRegistry } from './test/fakes';
import { HOST, ORIGIN, createTestServer, type TestServer } from './test/harness';

let s: TestServer;
const extra: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await s?.close();
  for (const cleanup of extra.splice(0)) await cleanup();
});

const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 5000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const start = async (topic = 'The Apollo program', config = initialConfig()) =>
  ((await s.api.post('/api/jobs', { topic, lengthSeconds: 30, config })).body as { id: string }).id;
const toReview = async (topic?: string, config?: ReturnType<typeof initialConfig>) => {
  const id = await start(topic, config);
  await s.waitForJob(id, ['review']);
  return id;
};
const hold = () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { gate, release };
};
const upload = async (kind: 'recording' | 'music', name: string, data: Uint8Array) => {
  const boundary = '----vc';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: audio/wav\r\n\r\n`,
    ),
    Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await s.app.inject({
    method: 'POST',
    url: `/api/uploads?kind=${kind}`,
    headers: {
      host: HOST,
      origin: ORIGIN,
      'x-vc-client': 'web',
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body) as UploadResponse;
};

describe('renders: cancel, fail, retry', () => {
  it('cancelling a running render returns the job to review, ready to render again', async () => {
    s = await createTestServer();
    await s.completeSetup();
    const id = await toReview();
    const { gate, release } = hold();
    s.renderer.gate = gate;
    await s.api.post(`/api/jobs/${id}/render`, { config: initialConfig() });
    await until(() => s.renderer.started === 1);
    expect((await s.api.post(`/api/jobs/${id}/cancel`)).status).toBe(202);
    release();
    const job = await s.waitForJob(id, ['review', 'cancelled', 'failed']);
    expect(job.status).toBe('review');
    expect(job.plan).not.toBeNull();
    expect(job.render.progress).toBeNull();
    expect(job.stages.filter((st) => st.status === 'running')).toEqual([]);

    s.renderer.gate = null;
    expect((await s.api.post(`/api/jobs/${id}/render`, { config: initialConfig() })).status).toBe(
      202,
    );
    expect((await s.waitForJob(id, ['done', 'failed'])).status).toBe('done');
  });

  it('a render cancelled while queued, then requested again, renders once with the newer config', async () => {
    s = await createTestServer();
    await s.completeSetup();
    const a = await toReview('Apollo');
    const b = await toReview('Gemini');
    const { gate, release } = hold();
    s.renderer.gate = gate;
    await s.api.post(`/api/jobs/${a}/render`, { config: initialConfig() });
    await until(() => s.renderer.started === 1);
    await s.api.post(`/api/jobs/${b}/render`, { config: initialConfig() });
    await s.api.post(`/api/jobs/${b}/cancel`);
    expect(((await s.api.get(`/api/jobs/${b}`)).body as JobDetail).status).toBe('review');
    const newer = mergeConfig(initialConfig(), { output: { fps: 24 } });
    await s.api.post(`/api/jobs/${b}/render`, { config: newer });
    release();
    await s.waitForJob(a, ['done']);
    await s.waitForJob(b, ['done']);
    expect(s.renderer.calls).toHaveLength(2);
    expect(s.renderer.calls[1]!.config.output.fps).toBe(24);
  });

  it('a failed render is reported at the render stage without leaking keys, and can be retried', async () => {
    s = await createTestServer();
    await s.completeSetup();
    const id = await toReview();
    s.renderer.failWith = new Error(`Chrome crashed while holding ${ACME_KEY}`);
    await s.api.post(`/api/jobs/${id}/render`, { config: initialConfig() });
    const failed = await s.waitForJob(id, ['failed', 'done']);
    expect(failed.status).toBe('failed');
    expect(failed.error?.stage).toBe('render');
    expect(failed.error?.message).toContain('Chrome crashed');
    expect(JSON.stringify(failed)).not.toContain(ACME_KEY);
    expect(s.logs.join('')).not.toContain(ACME_KEY);

    s.renderer.failWith = null;
    expect((await s.api.post(`/api/jobs/${id}/render`, { config: initialConfig() })).status).toBe(
      202,
    );
    const done = await s.waitForJob(id, ['done', 'failed']);
    expect(done.status).toBe('done');
    expect(done.error).toBeNull();
  });
});

describe('restart recovery', () => {
  it('fails unfinished preparations with a clear message and returns interrupted renders to review', async () => {
    const first = await createTestServer();
    s = first;
    await s.completeSetup();
    const reviewed = await toReview('Reviewed');
    const rendering = await toReview('Rendering');
    const preparing = await toReview('Preparing');
    const queued = await toReview('Queued');
    first.db.jobs.update(rendering, { status: 'rendering', progress: 0.4 });
    first.db.jobs.update(preparing, { status: 'preparing' });
    first.db.jobs.update(queued, { status: 'queued' });
    await first.app.close();

    // A new server process on the same database.
    s = await createTestServer({ db: first.db });
    extra.push(() => rm(first.dataDir, { recursive: true, force: true }));
    const get = async (id: string) => (await s.api.get(`/api/jobs/${id}`)).body as JobDetail;

    expect(await get(reviewed)).toMatchObject({ status: 'review', error: null });
    expect(await get(rendering)).toMatchObject({
      status: 'review',
      error: { stage: 'render' },
      render: { progress: null },
    });
    for (const id of [preparing, queued]) {
      const job = await get(id);
      expect(job.status).toBe('failed');
      expect(job.error?.message).toMatch(/server stopped/i);
    }
  });
});

describe('music: library, upload, none', () => {
  it('mixes and credits an uploaded track, and serves it to the review preview', async () => {
    const base = fakeMedia();
    const mixes: Array<Parameters<ServerMedia['mixAudio']>[0]> = [];
    s = await createTestServer({
      media: {
        ...base,
        mixAudio: async (args) => {
          mixes.push(args);
          return base.mixAudio(args);
        },
      },
    });
    await s.completeSetup();
    const track = await upload('music', 'bed.wav', encodeTestWav(40_000));
    const config = mergeConfig(initialConfig(), {
      audio: { music: { source: 'upload', uploadId: track.id } },
    });
    const id = await toReview('Apollo', config);
    const plan = ((await s.api.get(`/api/jobs/${id}`)).body as JobDetail).plan!;
    expect(plan.audio.musicSrc).toBe(`/api/media/uploads/${track.id}.wav`);
    expect((await s.api.get(plan.audio.musicSrc!)).status).toBe(200);

    await s.api.post(`/api/jobs/${id}/render`, { config });
    const done = await s.waitForJob(id, ['done', 'failed']);
    expect(done.status, JSON.stringify(done.error)).toBe('done');
    expect(mixes.at(-1)!.musicPath).toMatch(new RegExp(`${track.id}\\.wav$`));
    expect((await s.api.get(done.outputs.credits!)).raw).toContain('Your uploaded track');
  });

  it('keeps the stored plan in step when the music changes in review', async () => {
    s = await createTestServer();
    await s.completeSetup();
    const withMusic = mergeConfig(initialConfig(), {
      audio: { music: { source: 'library', trackId: 'soft-pad' } },
    });
    const id = await toReview('Apollo', withMusic);
    const silent = mergeConfig(withMusic, { audio: { music: { source: 'none', trackId: null } } });
    await s.api.post(`/api/jobs/${id}/render`, { config: silent });
    let job = await s.waitForJob(id, ['done']);
    expect(job.plan!.audio.musicSrc).toBeNull();
    expect((await s.api.get(`/api/jobs/${id}/files/credits.txt`)).raw).not.toContain('Soft pad');

    const pulse = mergeConfig(withMusic, {
      audio: { music: { source: 'library', trackId: 'pulse' } },
    });
    await s.api.post(`/api/jobs/${id}/render`, { config: pulse });
    job = await s.waitForJob(id, ['done']);
    expect(job.plan!.audio.musicSrc).toMatch(/^\/api\/media\/cache\/music\/pulse-\d+\.wav$/);
    expect((await s.api.get(job.plan!.audio.musicSrc!)).status).toBe(200);
  });

  it('serves only shared media, never other data files', async () => {
    s = await createTestServer();
    await s.completeSetup();
    const id = await toReview();
    for (const url of [
      '/api/media/app.sqlite',
      '/api/media/..%2Fapp.sqlite',
      '/api/media/uploads/..%2Fapp.sqlite',
      '/api/media/uploads/%2e%2e/app.sqlite',
      `/api/media/jobs/${id}/narration.wav`,
      '/api/media/uploads/a%00b',
    ]) {
      expect((await s.api.get(url)).status, url).toBe(404);
    }
    // Malformed escapes never reach the route.
    expect((await s.api.get('/api/media/cache/music/%E0%A4%A')).status).toBe(400);
  });
});

describe('render-time calibration', () => {
  it('is unavailable without a calibrator', async () => {
    s = await createTestServer();
    expect((await s.api.post('/api/calibrate')).status).toBe(501);
  });

  it('runs one calibration at a time, records benchmark samples and unlocks the transitions it timed', async () => {
    const { gate, release } = hold();
    let runs = 0;
    const calibrator: Calibrator = {
      async run(onSample) {
        runs++;
        await gate;
        onSample(
          mergeConfig(initialConfig(), { transitions: { presentations: ['ripple'] } }),
          3000,
          2,
          1234,
        );
      },
    };
    s = await createTestServer({ calibrator });
    expect((await s.api.post('/api/calibrate')).status).toBe(202);
    expect((await s.api.post('/api/calibrate')).status).toBe(202);
    expect(runs).toBe(1);
    expect((await s.api.get('/api/render-stats')).body).toMatchObject({
      calibrating: true,
      sampleCount: 0,
    });
    expect(
      ((await s.api.get('/api/catalog')).body as CatalogResponse).exposedTransitions,
    ).not.toContain('ripple');

    release();
    await until(
      async () =>
        !((await s.api.get('/api/render-stats')).body as { calibrating: boolean }).calibrating,
    );
    expect((await s.api.get('/api/render-stats')).body).toMatchObject({
      sampleCount: 1,
      timedTransitions: ['ripple'],
    });
    expect(
      ((await s.api.get('/api/catalog')).body as CatalogResponse).exposedTransitions,
    ).toContain('ripple');
  });

  it('a failed calibration is logged and can be started again', async () => {
    let runs = 0;
    const calibrator: Calibrator = {
      async run() {
        runs++;
        throw new Error('Chrome could not start');
      },
    };
    s = await createTestServer({ calibrator });
    await s.api.post('/api/calibrate');
    await until(
      async () =>
        !((await s.api.get('/api/render-stats')).body as { calibrating: boolean }).calibrating,
    );
    expect(s.logs.join('')).toContain('calibration failed');
    await s.api.post('/api/calibrate');
    await until(() => runs === 2);
  });
});

describe('setup edge cases', () => {
  it('refuses switching word timing off for a voice without timings', async () => {
    s = await createTestServer();
    await expect(s.completeSetup({ voice: 'acme', align: 'off' })).rejects.toThrow(
      /this voice returns none/,
    );
  });

  it('asks for word timing again when the voice changes to one without timings', async () => {
    s = await createTestServer();
    await s.api.put('/api/credentials/labs', { apiKey: LABS_KEY });
    expect((await s.completeSetup({ voice: 'labs', align: 'off' })).complete).toBe(true);
    expect(
      (await s.api.put('/api/setup/roles/voice', { mode: 'provider', providerId: 'acme' })).status,
    ).toBe(200);
    await s.api.post('/api/setup/roles/voice/test');
    const state = (await s.api.get('/api/setup')).body as SetupState;
    expect(state.complete).toBe(false);
    expect(state.missing).toEqual([
      {
        role: 'align',
        reason: 'This voice returns no word timings: choose a word-timing provider.',
      },
    ]);
    expect(
      (
        await s.api.post('/api/jobs', {
          topic: 'Apollo',
          lengthSeconds: 30,
          config: initialConfig(),
        })
      ).status,
    ).toBe(409);
  });

  it('does not blame the voice for missing timings when its key cannot be read', async () => {
    class FlakyKeychain extends LockableVault {
      failing = false;
      override async get(id: string): Promise<string | null> {
        if (this.failing)
          throw new VaultBackendError(
            'read the key',
            new Error('User interaction is not allowed.'),
          );
        return super.get(id);
      }
    }
    const vault = new FlakyKeychain();
    s = await createTestServer({ vault });
    await s.api.put('/api/credentials/labs', { apiKey: LABS_KEY });
    expect((await s.completeSetup({ voice: 'labs', align: 'off' })).complete).toBe(true);
    for (const lock of [() => (vault.failing = true), () => s.api.post('/api/vault/lock')]) {
      await lock();
      const state = (await s.api.get('/api/setup')).body as SetupState;
      expect(state.missing.filter((m) => m.role === 'align')).toEqual([]);
    }
  });
});

describe('presets: names that collide after slugging', () => {
  it('refuses a name whose id matches an existing or built-in preset', async () => {
    s = await createTestServer();
    expect(
      (await s.api.post('/api/presets', { name: 'My look', config: initialConfig() })).status,
    ).toBe(201);
    const similar = await s.api.post('/api/presets', { name: 'My look!', config: initialConfig() });
    expect(similar.status).toBe(409);
    expect(similar.raw).toContain('very similar name');
    expect(
      (await s.api.post('/api/presets', { name: 'Documentary!', config: initialConfig() })).status,
    ).toBe(409);
  });

  it('refuses renaming to a name that is taken, but allows changing the case of its own name', async () => {
    s = await createTestServer();
    await s.api.post('/api/presets', { name: 'Warm', config: initialConfig() });
    await s.api.post('/api/presets', { name: 'Cool', config: initialConfig() });
    expect((await s.api.put('/api/presets/cool', { name: 'warm' })).status).toBe(409);
    expect((await s.api.put('/api/presets/cool', { name: 'COOL' })).body).toMatchObject({
      name: 'COOL',
    });
  });
});

describe('error responses', () => {
  it('rejects malformed JSON as a client error', async () => {
    s = await createTestServer();
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/presets',
      headers: {
        host: HOST,
        origin: ORIGIN,
        'x-vc-client': 'web',
        'content-type': 'application/json',
      },
      payload: '{"name": ',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('hides unexpected errors behind a generic 500 and logs them scrubbed', async () => {
    const registry = fakeRegistry();
    let explode = false;
    s = await createTestServer({
      registry: {
        ...registry,
        list: () => {
          if (explode) throw new Error(`registry exploded near ${ACME_KEY}`);
          return registry.list();
        },
      },
    });
    await s.completeSetup();
    explode = true;
    const res = await s.api.get('/api/providers');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'internal', message: 'Something went wrong on the server.' },
    });
    const logs = s.logs.join('');
    expect(logs).toContain('registry exploded');
    expect(logs).not.toContain(ACME_KEY);
  });

  class ThrowingVault extends LockableVault {
    constructor(private readonly error: () => Error) {
      super();
    }
    override async setup(): Promise<void> {
      throw this.error();
    }
    override async unlock(): Promise<void> {
      throw this.error();
    }
    override async set(): Promise<void> {
      throw this.error();
    }
  }

  it.each([
    [
      'weak passphrase',
      () => new WeakPassphraseError(12),
      '/api/vault/setup',
      400,
      'weak_passphrase',
    ],
    [
      'vault already set up',
      () => new VaultSetupError('The vault is already set up.'),
      '/api/vault/setup',
      409,
      'vault_setup',
    ],
    [
      'damaged vault file',
      () => new VaultCorruptError('bad tag'),
      '/api/vault/unlock',
      500,
      'vault_corrupt',
    ],
    [
      'keychain refused',
      () => new VaultBackendError('read the key', new Error('User interaction is not allowed.')),
      '/api/vault/unlock',
      503,
      'vault_unavailable',
    ],
  ] as const)(
    'maps a %s to a clear status and message',
    async (_name, error, url, status, code) => {
      s = await createTestServer({ vault: new ThrowingVault(error) });
      const res = await s.api.post(url, { passphrase: 'correct horse battery' });
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ error: { code, message: error().message } });
    },
  );

  it('reports a keychain failure when storing a key', async () => {
    s = await createTestServer({
      vault: new ThrowingVault(() => new VaultBackendError('save the key', new Error('denied'))),
    });
    const res = await s.api.put('/api/credentials/acme', { apiKey: ACME_KEY });
    expect(res.status).toBe(503);
    expect(res.raw).not.toContain(ACME_KEY);
  });
});
