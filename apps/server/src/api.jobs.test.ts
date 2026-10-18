import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ScenePlanSchema,
  SCHEMA_DEFAULTS,
  estimateRenderTime,
  fitRenderModel,
  initialConfig,
  mergeConfig,
  type JobDetail,
  type JobSummary,
} from '@vc/config';
import { encodeTestWav } from '@vc/pipeline/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACME_KEY, texts } from './test/fakes';
import { createTestServer, type TestServer } from './test/harness';

let s: TestServer;
beforeEach(async () => {
  s = await createTestServer();
});
afterEach(async () => {
  await s.close();
});

const request = (patch: Record<string, unknown> = {}) => ({
  topic: 'The Apollo program',
  lengthSeconds: 30,
  config: initialConfig(),
  ...patch,
});

const start = async (patch: Record<string, unknown> = {}) => {
  const res = await s.api.post('/api/jobs', request(patch));
  expect(res.status, res.raw).toBe(202);
  return (res.body as { id: string }).id;
};

describe('job creation is gated and validated', () => {
  it('refuses to start before setup is complete', async () => {
    const res = await s.api.post('/api/jobs', request());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'setup_incomplete' } });
    expect((res.body as { error: { message: string } }).error.message).toMatch(/text/);
  });

  it('validates the request with the schema and reports field paths', async () => {
    await s.completeSetup();
    const res = await s.api.post(
      '/api/jobs',
      request({ topic: 'x', config: mergeConfig(SCHEMA_DEFAULTS, { motion: { zoomAmount: 3 } }) }),
    );
    expect(res.status).toBe(400);
    const paths = (res.body as { error: { fields: Array<{ path: string }> } }).error.fields.map(
      (f) => f.path,
    );
    expect(paths).toContain('topic');
    expect(paths).toContain('config.motion.zoomAmount');
  });

  it('accepts a preset id with overrides instead of a full config', async () => {
    await s.completeSetup();
    const res = await s.api.post('/api/jobs', {
      topic: 'The Apollo program',
      lengthSeconds: 30,
      presetId: 'cinematic',
      overrides: { output: { fps: 24 } },
    });
    expect(res.status).toBe(202);
    const job = (await s.api.get(`/api/jobs/${(res.body as { id: string }).id}`)).body as JobDetail;
    expect(job.config.output.fps).toBe(24);
    expect(job.config.basedOnPreset).toBe('cinematic');
  });

  it('checks the environment: unknown fonts and missing uploads', async () => {
    await s.completeSetup();
    const res = await s.api.post(
      '/api/jobs',
      request({ config: mergeConfig(initialConfig(), { captions: { fontFamily: 'Not A Font' } }) }),
    );
    expect(res.status).toBe(400);
    expect(res.raw).toMatch(/captions.fontFamily/);
  });

  it('needs pasted source text when web search is off', async () => {
    await s.completeSetup({ search: 'off' });
    const res = await s.api.post('/api/jobs', request());
    expect(res.status).toBe(400);
    expect(res.raw).toMatch(/paste/i);
    expect(
      (await s.api.post('/api/jobs', request({ sourceText: 'Apollo 11 landed in 1969.' }))).status,
    ).toBe(202);
  });

  it('needs an uploaded recording when the voice role is off', async () => {
    await s.completeSetup({ voice: 'off' });
    expect((await s.api.post('/api/jobs', request())).status).toBe(400);
    expect(
      (await s.api.post('/api/jobs', request({ recordingUploadId: 'upl_missing' }))).status,
    ).toBe(400);
  });

  it('refuses jobs while the vault is locked', async () => {
    await s.completeSetup();
    s.deps.vault.lock();
    const res = await s.api.post('/api/jobs', request());
    expect([409, 423]).toContain(res.status);
  });
});

describe('job lifecycle', () => {
  it('prepares a plan for review, logging every AI call with its reason', async () => {
    await s.completeSetup();
    const id = await start();
    const job = await s.waitForJob(id, ['review', 'failed']);
    expect(job.status, JSON.stringify(job.error)).toBe('review');
    expect(ScenePlanSchema.safeParse(job.plan).success).toBe(true);
    expect(job.stages.map((x) => [x.stage, x.status])).toEqual([
      ['research', 'done'],
      ['script', 'done'],
      ['voice', 'done'],
      ['timing', 'done'],
      ['images', 'done'],
      ['captions', 'done'],
    ]);
    expect(job.aiCalls.map((c) => `${c.stage}/${c.role}`)).toEqual([
      'research/search',
      'research/text',
      'script/text',
      'voice/voice',
      'timing/align',
    ]);
    for (const call of job.aiCalls) expect(call.reason.length).toBeGreaterThan(10);
    expect(job.cost.actualUsd).toBeGreaterThan(0);
    expect(job.cost.estimatedUsd).toBeGreaterThan(0);
    expect(job.cost.capUsd).toBe(2);
    expect(job.imageDecisions).toHaveLength(job.plan!.scenes.length);
    expect(job.plan!.audio.narrationSrc).toBe(`/api/jobs/${id}/assets/narration.wav`);
  });

  it('serves the plan assets for the browser preview', async () => {
    await s.completeSetup();
    const id = await start();
    const job = await s.waitForJob(id, ['review']);
    const res = await s.api.get(job.plan!.audio.narrationSrc);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/wav/);
  });

  it('renders the final video through the queue, then serves the outputs', async () => {
    await s.completeSetup();
    const id = await start();
    await s.waitForJob(id, ['review']);
    const config = mergeConfig(initialConfig(), { simple: { backdropKind: 'light' } });
    expect((await s.api.post(`/api/jobs/${id}/render`, { config })).status).toBe(202);
    const done = await s.waitForJob(id, ['done', 'failed']);
    expect(done.status, JSON.stringify(done.error)).toBe('done');
    expect(s.renderer.calls[0]!.config.simple.backdropKind).toBe('light');
    // The renderer gets absolute asset URLs; the stored plan keeps relative ones for the preview.
    expect(s.renderer.calls[0]!.plan.audio.narrationSrc).toBe(
      `http://127.0.0.1:4317/api/jobs/${id}/assets/narration.wav`,
    );
    expect(done.outputs.video).toBe(`/api/jobs/${id}/files/video.mp4`);
    expect(done.checks.find((c) => c.id === 'duration')?.status).toBe('pass');
    expect(done.render.elapsedMs).toBe(1500);
    for (const url of [done.outputs.video!, done.outputs.srt!, done.outputs.credits!]) {
      expect((await s.api.get(url)).status).toBe(200);
    }
    expect(
      (await s.api.get(`/api/jobs/${id}/files/video.mp4`)).headers['content-disposition'],
    ).toMatch(/attachment/);
  });

  it('re-resolves the caption font and palette when they change in review', async () => {
    await s.completeSetup();
    const id = await start();
    await s.waitForJob(id, ['review']);
    const config = mergeConfig(initialConfig(), {
      captions: { fontFamily: 'Roboto' },
      backdrop: { palette: { source: 'image' } },
    });
    await s.api.post(`/api/jobs/${id}/render`, { config });
    await s.waitForJob(id, ['done']);
    const rendered = s.renderer.calls.at(-1)!.plan;
    expect(rendered.fonts.caption).toMatchObject({ fontFamily: 'Roboto' });
    expect(rendered.palette).toEqual(['#101010', '#202020', '#E0A000', '#F0F0F0', '#3060F0']);
  });

  it('estimates the render time of a reviewed style from the actual plan', async () => {
    await s.completeSetup();
    const id = await start();
    await s.waitForJob(id, ['review']);
    await s.api.post(`/api/jobs/${id}/render`, { config: initialConfig() });
    const done = await s.waitForJob(id, ['done']);
    const plan = done.plan!;
    const blurred = mergeConfig(initialConfig(), {
      motion: { motionBlur: { enabled: true, samples: 8 } },
    });
    const res = await s.api.post(`/api/jobs/${id}/estimate`, { config: blurred });
    expect(res.status).toBe(200);
    const expected = estimateRenderTime(
      blurred,
      { durationMs: plan.durationMs, sceneCount: plan.scenes.length, cpuCount: 8 },
      fitRenderModel(s.db.samples.all()),
    );
    expect(res.body).toEqual({ render: expected });
    expect((res.body as { render: { seconds: number } }).render.seconds).toBeGreaterThan(0);

    expect((await s.api.post('/api/jobs/nope/estimate', { config: blurred })).status).toBe(404);
    expect((await s.api.post(`/api/jobs/${id}/estimate`, { config: { simple: 1 } })).status).toBe(
      400,
    );
    s.db.jobs.update(id, { plan: null });
    expect((await s.api.post(`/api/jobs/${id}/estimate`, { config: blurred })).status).toBe(409);
  });

  it("refreshes the job's render estimate once its own render has been measured", async () => {
    await s.completeSetup();
    const id = await start();
    expect((await s.waitForJob(id, ['review'])).render.estimate?.status).toBe('uncalibrated');
    await s.api.post(`/api/jobs/${id}/render`, { config: initialConfig() });
    const done = await s.waitForJob(id, ['done']);
    expect(done.render.estimate?.status).not.toBe('uncalibrated');
    expect(done.render.estimate?.seconds).toBeGreaterThan(0);
  });

  it('records each render as a sample for the render-time estimate', async () => {
    await s.completeSetup();
    const id = await start();
    await s.waitForJob(id, ['review']);
    await s.api.post(`/api/jobs/${id}/render`, { config: initialConfig() });
    await s.waitForJob(id, ['done']);
    expect(s.db.samples.all()).toHaveLength(1);
  });

  it('a rerun with only a style change touches no AI at all', async () => {
    await s.completeSetup({ vision: 'acme' });
    await s.api.put('/api/settings', { visionFinalCheck: true });
    const id = await start();
    await s.waitForJob(id, ['review']);
    await s.api.post(`/api/jobs/${id}/render`, { config: initialConfig() });
    const first = await s.waitForJob(id, ['done']);
    const calls = first.aiCalls.length;
    expect(first.aiCalls.some((c) => c.stage === 'checks')).toBe(true);
    await s.api.post(`/api/jobs/${id}/render`, {
      config: mergeConfig(initialConfig(), {
        simple: { animationKind: 'cinematic', backdropKind: 'textured' },
      }),
    });
    const second = await s.waitForJob(id, ['done']);
    expect(second.render.renders).toBe(2);
    expect(second.aiCalls.length).toBe(calls);
  });

  it('refuses to render an invalid config or a job that is not ready', async () => {
    await s.completeSetup();
    const id = await start();
    const early = await s.api.post(`/api/jobs/${id}/render`, { config: initialConfig() });
    expect([202, 409]).toContain(early.status);
    await s.waitForJob(id, ['review', 'rendering', 'done']);
    const bad = await s.api.post(`/api/jobs/${id}/render`, {
      config: mergeConfig(initialConfig(), { output: { crf: 99 } }),
    });
    expect(bad.status).toBe(400);
    expect((await s.api.post('/api/jobs/nope/render', { config: initialConfig() })).status).toBe(
      404,
    );
  });

  it('fails a job at the per-job cost cap with a clear message', async () => {
    await s.completeSetup();
    await s.api.put('/api/settings', { costCapUsd: 0 });
    const id = await start();
    const job = await s.waitForJob(id, ['failed', 'review']);
    expect(job.status).toBe('failed');
    expect(job.error?.message).toMatch(/cost cap/i);
  });

  it('can be cancelled while preparing', async () => {
    await s.completeSetup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    texts.length = 0;
    const id = await start();
    // Hold the next text call until we have cancelled.
    for (const t of texts) t.gate = gate;
    expect((await s.api.post(`/api/jobs/${id}/cancel`)).status).toBe(202);
    release();
    const job = await s.waitForJob(id, ['cancelled', 'failed', 'review']);
    expect(job.status).toBe('cancelled');
  });

  it('lists and deletes jobs, removing their files', async () => {
    await s.completeSetup();
    const id = await start();
    await s.waitForJob(id, ['review']);
    const list = (await s.api.get('/api/jobs')).body as JobSummary[];
    expect(list.map((j) => j.id)).toEqual([id]);
    expect((await s.api.del(`/api/jobs/${id}`)).status).toBe(204);
    expect((await s.api.get(`/api/jobs/${id}`)).status).toBe(404);
    expect((await readdir(join(s.dataDir, 'jobs'))).includes(id)).toBe(false);
  });

  it('keeps API keys out of job records, responses and logs', async () => {
    await s.completeSetup();
    const id = await start();
    await s.waitForJob(id, ['review']);
    await s.api.post(`/api/jobs/${id}/render`, { config: initialConfig() });
    const job = await s.waitForJob(id, ['done']);
    expect(JSON.stringify(job)).not.toContain(ACME_KEY);
    const tables = s.db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    for (const { name } of tables)
      expect(JSON.stringify(s.db.raw.prepare(`SELECT * FROM ${name}`).all())).not.toContain(
        ACME_KEY,
      );
    expect(s.logs.join('')).not.toContain(ACME_KEY);
  });

  it('refuses paths outside the job folder', async () => {
    await s.completeSetup();
    const id = await start();
    await s.waitForJob(id, ['review']);
    for (const url of [
      `/api/jobs/${id}/assets/..%2F..%2Fapp.sqlite`,
      `/api/jobs/${id}/assets/%2e%2e/%2e%2e/app.sqlite`,
      `/api/jobs/${id}/files/..%2Fapp.sqlite`,
    ]) {
      expect((await s.api.get(url)).status).toBe(404);
    }
  });

  it('accepts an uploaded recording and skips TTS for it', async () => {
    await s.completeSetup({ voice: 'off' });
    const boundary = '----vc';
    const wav = Buffer.from(encodeTestWav(6000));
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="take.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      ),
      wav,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await s.app.inject({
      method: 'POST',
      url: '/api/uploads?kind=recording',
      headers: {
        host: '127.0.0.1:4317',
        origin: 'http://127.0.0.1:4317',
        'x-vc-client': 'web',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const { id: uploadId, durationMs } = JSON.parse(upload.body) as {
      id: string;
      durationMs: number;
    };
    expect(durationMs).toBe(6000);
    const id = await start({ recordingUploadId: uploadId });
    const job = await s.waitForJob(id, ['review', 'failed']);
    expect(job.status).toBe('review');
    expect(job.aiCalls.some((c) => c.role === 'voice')).toBe(false);
    expect(job.plan!.durationMs).toBe(6000);
  });

  it('rejects an upload that is not audio', async () => {
    const boundary = '----vc';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.wav"\r\nContent-Type: audio/wav\r\n\r\nnot audio\r\n--${boundary}--\r\n`,
    );
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/uploads?kind=recording',
      headers: {
        host: '127.0.0.1:4317',
        origin: 'http://127.0.0.1:4317',
        'x-vc-client': 'web',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });
});
