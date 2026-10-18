import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import {
  BUILT_IN_PRESETS,
  CreatePresetSchema,
  EstimateRequestSchema,
  PassphraseSchema,
  PutCredentialSchema,
  PutRoleSchema,
  PutSettingsSchema,
  UPLOAD_KINDS,
  UpdatePresetSchema,
  ValidateConfigSchema,
  VideoConfigSchema,
  createPresetRecord,
  exposedTransitions,
  formatZodIssues,
  getWarnings,
  isRoleId,
  validateForEnvironment,
  validatePresetName,
  type CatalogProvider,
  type CatalogResponse,
  type EstimateResponse,
  type JobEvent,
  type RoleId,
  type UploadKind,
  type ValidateConfigResponse,
} from '@vc/config';
import { estimateJobCost } from '@vc/pipeline';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordCalibrationSample } from './calibrate';
import { HttpError, badRequest, notFound } from './http-error';
import { jobDir, safeJoin } from './job-files';
import type { JobManager } from './jobs';
import type { ServerDeps } from './services';
import { priceLookupFor, type Credentials, type SetupService } from './setup';

const OUTPUT_FILE = /^(video\.(mp4|webm|mov)|captions\.srt|credits\.txt|contact-sheet\.png)$/;
const SHARED_MEDIA = ['cache/music/', 'uploads/'];

const parseBody = <T extends z.ZodType>(schema: T, body: unknown): z.output<T> => {
  const result = schema.safeParse(body ?? {});
  if (!result.success)
    throw badRequest('The request is invalid.', formatZodIssues(result.error.issues));
  return result.data;
};

const roleParam = (role: string): RoleId => {
  if (!isRoleId(role)) throw notFound(`Role "${role}"`);
  return role;
};

const catalogFrom = (deps: ServerDeps): CatalogProvider[] =>
  deps.registry.list().map((p) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    description: p.description,
    credential: p.credential
      ? {
          id: p.credential.id,
          label: p.credential.label,
          helpUrl: p.credential.helpUrl,
          optional: p.credential.optional ?? false,
        }
      : null,
    roles: Object.fromEntries(
      Object.entries(p.roles).map(([role, adapter]) => {
        let optionsSchema: Record<string, unknown> = {};
        try {
          optionsSchema = z.toJSONSchema(adapter.optionsSchema, {
            io: 'input',
            unrepresentable: 'any',
          }) as Record<string, unknown>;
        } catch {
          // the form falls back to no extra fields
        }
        return [
          role,
          {
            label: adapter.label,
            defaultModel: adapter.defaultModel,
            suggestedModels: [...adapter.suggestedModels],
            optionsSchema,
          },
        ];
      }),
    ),
  }));

export const registerRoutes = (
  app: FastifyInstance,
  {
    deps,
    setup,
    credentials,
    jobs,
  }: { deps: ServerDeps; setup: SetupService; credentials: Credentials; jobs: JobManager },
) => {
  const { db } = deps;
  let calibrating = false;

  app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }));

  /* --------------------------------------------------------------- setup */

  app.get('/api/setup', async () => setup.state());
  app.get('/api/providers', async () => catalogFrom(deps));
  app.put<{ Params: { id: string } }>('/api/credentials/:id', async (request) => {
    const { apiKey } = parseBody(PutCredentialSchema, request.body);
    return credentials.set(request.params.id, apiKey);
  });
  app.delete<{ Params: { id: string } }>('/api/credentials/:id', async (request, reply) => {
    await credentials.remove(request.params.id);
    return reply.code(204).send();
  });
  app.put<{ Params: { role: string } }>('/api/setup/roles/:role', async (request) =>
    setup.putRole(roleParam(request.params.role), parseBody(PutRoleSchema, request.body)),
  );
  app.post<{ Params: { role: string } }>('/api/setup/roles/:role/test', async (request) =>
    setup.testRole(roleParam(request.params.role)),
  );

  /* --------------------------------------------------------------- vault */

  app.post('/api/vault/setup', async (request) => {
    const { passphrase } = parseBody(PassphraseSchema, request.body);
    await deps.vault.setup(passphrase);
    await credentials.loadIntoScrubber();
    return setup.state();
  });
  app.post('/api/vault/unlock', async (request) => {
    const { passphrase } = parseBody(PassphraseSchema, request.body);
    await deps.vault.unlock(passphrase);
    await credentials.loadIntoScrubber();
    return setup.state();
  });
  app.post('/api/vault/lock', async () => {
    deps.vault.lock();
    return setup.state();
  });

  /* ------------------------------------------------------------ settings */

  app.get('/api/settings', async () => db.settings.get());
  app.put('/api/settings', async (request) =>
    db.settings.put(parseBody(PutSettingsSchema, request.body)),
  );

  /* ------------------------------------------------------------- presets */

  app.get('/api/presets', async () => [...BUILT_IN_PRESETS, ...db.presets.all()]);
  app.post('/api/presets', async (request, reply) => {
    const body = parseBody(CreatePresetSchema, request.body);
    const existing = db.presets.all();
    const nameError = validatePresetName(
      body.name,
      existing.map((p) => p.name),
    );
    if (nameError)
      throw new HttpError(
        /exists|built-in/.test(nameError) ? 409 : 400,
        'invalid_name',
        nameError,
        [{ path: 'name', message: nameError }],
      );
    const record = createPresetRecord(
      {
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
        config: body.config,
      },
      existing.map((p) => p.name),
    );
    if (BUILT_IN_PRESETS.some((p) => p.id === record.id) || db.presets.get(record.id)) {
      throw new HttpError(
        409,
        'invalid_name',
        'A preset with a very similar name already exists.',
        [{ path: 'name', message: 'Choose a different name.' }],
      );
    }
    return reply.code(201).send(db.presets.insert(record));
  });
  app.put<{ Params: { id: string } }>('/api/presets/:id', async (request) => {
    const { id } = request.params;
    if (BUILT_IN_PRESETS.some((p) => p.id === id))
      throw new HttpError(
        403,
        'built_in',
        'Built-in presets cannot be changed. Save a copy instead.',
      );
    const current = db.presets.get(id);
    if (!current) throw notFound('Preset');
    const body = parseBody(UpdatePresetSchema, request.body);
    if (body.name !== undefined && body.name.trim().toLowerCase() !== current.name.toLowerCase()) {
      const error = validatePresetName(
        body.name,
        db.presets
          .all()
          .filter((p) => p.id !== id)
          .map((p) => p.name),
      );
      if (error)
        throw new HttpError(409, 'invalid_name', error, [{ path: 'name', message: error }]);
    }
    return db.presets.update(id, {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.config ? { config: body.config } : {}),
    });
  });
  app.delete<{ Params: { id: string } }>('/api/presets/:id', async (request, reply) => {
    const { id } = request.params;
    if (BUILT_IN_PRESETS.some((p) => p.id === id))
      throw new HttpError(403, 'built_in', 'Built-in presets cannot be deleted.');
    if (!db.presets.delete(id)) throw notFound('Preset');
    return reply.code(204).send();
  });

  /* -------------------------------------------------------- config tools */

  const environment = async (config: z.output<typeof VideoConfigSchema>) =>
    validateForEnvironment(config, {
      platform: deps.platform,
      cpuCount: deps.cpuCount,
      fontFamilies: new Set(await deps.fonts.families()),
      musicTracks: new Set(deps.music.tracks.map((t) => t.id)),
      uploads: db.uploads.ids('music'),
    });

  app.post('/api/config/validate', async (request): Promise<ValidateConfigResponse> => {
    const { config } = parseBody(ValidateConfigSchema, request.body);
    const parsed = VideoConfigSchema.safeParse(config);
    if (!parsed.success)
      return {
        ok: false,
        config: null,
        errors: formatZodIssues(parsed.error.issues),
        warnings: [],
        environment: [],
      };
    const env = await environment(parsed.data);
    return {
      ok: env.length === 0,
      config: parsed.data,
      errors: [],
      warnings: getWarnings(parsed.data, { timedTransitions: db.timedTransitions.get() }),
      environment: env,
    };
  });

  app.get('/api/catalog', async (): Promise<CatalogResponse> => {
    const timed = db.timedTransitions.get();
    return {
      exposedTransitions: exposedTransitions(timed),
      timedTransitions: [...timed].sort(),
      fonts: await deps.fonts.families(),
      musicTracks: [...deps.music.tracks],
      platform: deps.platform,
      cpuCount: deps.cpuCount,
    };
  });

  app.post('/api/estimate', async (request): Promise<EstimateResponse> => {
    const body = parseBody(EstimateRequestSchema, request.body);
    const settings = db.settings.get();
    const cost = estimateJobCost({
      lengthSeconds: body.lengthSeconds,
      animationKind: body.config.simple.animationKind,
      providers: await setup.estimateProviders(),
      prices: priceLookupFor(deps.registry, settings.pricingOverrides),
      sourceTextProvided: body.sourceTextProvided,
      recordingProvided: body.recordingProvided,
      visionAlways: settings.visionRankAlways,
      visionFinalCheck: settings.visionFinalCheck,
    });
    return {
      cost: { ...cost, capUsd: settings.costCapUsd },
      render: jobs.renderEstimate(body.config, body.lengthSeconds * 1000, 0),
    };
  });

  app.get<{ Params: { family: string } }>('/api/fonts/:family', async (request) => {
    const info = await deps.fonts.info(request.params.family);
    if (!info) throw notFound('Font');
    return info;
  });

  app.get<{ Params: { trackId: string }; Querystring: { durationMs?: string } }>(
    '/api/music/:trackId',
    async (request, reply) => {
      const durationMs = Number(request.query.durationMs);
      if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 2 * 60 * 60 * 1000)
        throw badRequest('durationMs must be a whole number of milliseconds.');
      if (!deps.music.tracks.some((t) => t.id === request.params.trackId))
        throw notFound('Music track');
      const path = await deps.music.pathFor(request.params.trackId, durationMs);
      return reply.sendFile(relative(deps.dataDir, path), deps.dataDir);
    },
  );

  app.get('/api/render-stats', async () => ({
    sampleCount: db.samples.all().length,
    timedTransitions: [...db.timedTransitions.get()].sort(),
    calibrating,
  }));
  app.post('/api/calibrate', async (_request, reply) => {
    if (!deps.calibrator)
      throw new HttpError(501, 'unavailable', 'Calibration is not available in this build.');
    if (!calibrating) {
      calibrating = true;
      void deps.calibrator
        .run(recordCalibrationSample(db, deps.cpuCount))
        .catch((error: unknown) => app.log.error({ err: error }, 'calibration failed'))
        .finally(() => {
          calibrating = false;
        });
    }
    return reply.code(202).send({ calibrating: true });
  });

  /* ------------------------------------------------------------- uploads */

  app.post<{ Querystring: { kind?: string } }>('/api/uploads', async (request, reply) => {
    const kind = request.query.kind as UploadKind;
    if (!(UPLOAD_KINDS as readonly string[]).includes(kind))
      throw badRequest('Upload kind must be "recording" or "music".');
    const file = await request.file();
    if (!file) throw badRequest('Attach a file.');
    const id = `upl_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const ext =
      extname(file.filename)
        .toLowerCase()
        .replace(/[^.a-z0-9]/g, '')
        .slice(0, 8) || '.bin';
    const dir = join(deps.dataDir, 'uploads');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}${ext}`);
    await pipeline(file.file, createWriteStream(path));
    if (file.file.truncated) {
      await rm(path, { force: true });
      throw new HttpError(413, 'too_large', 'That file is too large.');
    }
    let durationMs: number;
    try {
      ({ durationMs } = await deps.media.assertAudio(path));
    } catch (error) {
      await rm(path, { force: true });
      throw badRequest(error instanceof Error ? error.message : 'That file is not audio.');
    }
    db.uploads.insert({
      id,
      kind,
      name: file.filename,
      path,
      durationMs,
      createdAt: deps.now().toISOString(),
    });
    return reply.code(201).send({ id, kind, name: file.filename, durationMs });
  });

  /* ---------------------------------------------------------------- jobs */

  app.post('/api/jobs', async (request, reply) =>
    reply.code(202).send(await jobs.create(request.body)),
  );
  app.get('/api/jobs', async () => jobs.list());
  app.get<{ Params: { id: string } }>(
    '/api/jobs/:id',
    async (request) => jobs.detail(request.params.id) ?? Promise.reject(notFound('Job')),
  );
  app.post<{ Params: { id: string } }>('/api/jobs/:id/render', async (request, reply) => {
    await jobs.render(request.params.id, request.body);
    return reply.code(202).send({ id: request.params.id });
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/estimate', async (request) =>
    jobs.estimateForJob(request.params.id, request.body),
  );
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (request, reply) => {
    jobs.cancel(request.params.id);
    return reply.code(202).send({ id: request.params.id });
  });
  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    await jobs.delete(request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>(
    '/api/jobs/:id/events',
    (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const job = jobs.detail(request.params.id);
      if (!job)
        return reply.code(404).send({ error: { code: 'not_found', message: 'Job not found.' } });
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
      });
      const send = (event: JobEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ type: 'job', job });
      const unsubscribe = jobs.subscribe(request.params.id, send);
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return undefined;
    },
  );

  const sendFrom = (reply: FastifyReply, root: string, untrusted: string, download: boolean) => {
    const path = safeJoin(root, untrusted);
    if (!path)
      return reply.code(404).send({ error: { code: 'not_found', message: 'File not found.' } });
    if (download)
      reply.header(
        'content-disposition',
        `attachment; filename="${relative(root, path).split(sep).pop()}"`,
      );
    return reply.sendFile(relative(deps.dataDir, path), deps.dataDir);
  };

  app.get<{ Params: { id: string; '*': string } }>(
    '/api/jobs/:id/assets/*',
    async (request, reply) => {
      if (!db.jobs.get(request.params.id))
        return reply.code(404).send({ error: { code: 'not_found', message: 'Job not found.' } });
      return sendFrom(reply, jobDir(deps.dataDir, request.params.id), request.params['*'], false);
    },
  );

  app.get<{ Params: { id: string; name: string } }>(
    '/api/jobs/:id/files/:name',
    async (request, reply) => {
      const name = request.params.name;
      if (!db.jobs.get(request.params.id) || !OUTPUT_FILE.test(name))
        return reply.code(404).send({ error: { code: 'not_found', message: 'File not found.' } });
      return sendFrom(reply, jobDir(deps.dataDir, request.params.id), name, true);
    },
  );

  app.get<{ Params: { '*': string } }>('/api/media/*', async (request, reply) => {
    const rest = request.params['*'];
    const path = safeJoin(deps.dataDir, rest);
    const rel = path ? relative(deps.dataDir, path).split(sep).join('/') : '';
    if (!path || !SHARED_MEDIA.some((prefix) => rel.startsWith(prefix)))
      return reply.code(404).send({ error: { code: 'not_found', message: 'File not found.' } });
    return reply.sendFile(rel, deps.dataDir);
  });
};
