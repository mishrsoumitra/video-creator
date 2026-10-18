import { EventEmitter } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import {
  JobRequestSchema,
  RenderRequestSchema,
  estimateRenderTime,
  extractRenderFeatures,
  fitRenderModel,
  formatZodIssues,
  resolveConfigInput,
  validateForEnvironment,
  type AiCallView,
  type JobDetail,
  type JobEvent,
  type JobSummary,
  type ScenePlan,
  type VideoConfig,
  type JobRenderEstimateResponse,
} from '@vc/config';
import {
  AiLedger,
  PipelineError,
  estimateJobCost,
  finalizeJob,
  prepareJob,
  type AiCallRecord,
  type FactSheet,
  type MusicCredit,
  type Stage,
  type StageContext,
} from '@vc/pipeline';
import type { Db, JobRow } from './db';
import { HttpError, badRequest, notFound, prefixFields } from './http-error';
import { jobDir, jobFiles, safeJoin } from './job-files';
import { TaskQueue } from './queue';
import type { ServerDeps } from './services';
import { priceLookupFor, type SetupService } from './setup';

const PREPARE_STAGES = ['research', 'script', 'voice', 'timing', 'images', 'captions'];
const RENDER_STAGES = ['render', 'stitch', 'credits', 'checks'];

/** Job assets are served relative to the UI; the renderer (another origin) needs absolute URLs. */
export const absolutizePlan = (plan: ScenePlan, origin: string): ScenePlan => {
  const abs = (src: string) => (src.startsWith('/') ? `${origin}${src}` : src);
  return {
    ...plan,
    scenes: plan.scenes.map((s) =>
      s.visual.type === 'image' ? { ...s, visual: { ...s.visual, src: abs(s.visual.src) } } : s,
    ),
    audio: {
      narrationSrc: abs(plan.audio.narrationSrc),
      musicSrc: plan.audio.musicSrc ? abs(plan.audio.musicSrc) : null,
    },
  };
};

export class JobManager {
  private readonly events = new EventEmitter();
  private readonly prepareQueue: TaskQueue;
  private readonly renderQueue = new TaskQueue(1);
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly deps: ServerDeps,
    private readonly setup: SetupService,
  ) {
    this.prepareQueue = new TaskQueue(deps.prepareConcurrency ?? 2);
    this.events.setMaxListeners(100);
  }

  private get db(): Db {
    return this.deps.db;
  }

  /* -------------------------------------------------------------- events */

  subscribe(id: string, listener: (event: JobEvent) => void): () => void {
    this.events.on(id, listener);
    return () => this.events.off(id, listener);
  }

  private emitJob(id: string): void {
    const job = this.detail(id);
    if (job) this.events.emit(id, { type: 'job', job } satisfies JobEvent);
  }

  /* ------------------------------------------------------------- reading */

  list(): JobSummary[] {
    return this.db.jobs.list().map((j) => this.summary(j));
  }

  private summary(j: JobRow): JobSummary {
    return {
      id: j.id,
      topic: j.topic,
      lengthSeconds: j.lengthSeconds,
      status: j.status,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      costUsd: this.db.aiCalls.spent(j.id),
    };
  }

  detail(id: string): JobDetail | undefined {
    const j = this.db.jobs.get(id);
    if (!j) return undefined;
    const settings = this.db.settings.get();
    return {
      ...this.summary(j),
      stage: j.stage,
      stages: this.db.stages.list(id),
      config: j.config,
      plan: j.plan,
      warnings: j.prepared?.warnings ?? [],
      error: j.error,
      aiCalls: this.db.aiCalls
        .list(id)
        .map((r): AiCallView => ({ ...r, units: r.units as Record<string, number> })),
      cost: {
        estimatedUsd: j.estimatedUsd,
        actualUsd: this.db.aiCalls.spent(id),
        capUsd: settings.costCapUsd,
      },
      render: {
        estimate: j.renderEstimate,
        elapsedMs: j.result?.renderElapsedMs ?? null,
        progress: j.progress,
        renders: j.renders,
      },
      outputs: j.result?.outputs ?? { video: null, srt: null, credits: null, contactSheet: null },
      checks: j.result?.checks ?? [],
      imageDecisions: j.prepared?.imageDecisions ?? [],
      hasRecording: Boolean(j.request.recordingUploadId),
      sourceTextProvided: Boolean(j.request.sourceText),
    };
  }

  /* ------------------------------------------------------------ creation */

  private async environment(config: VideoConfig) {
    return validateForEnvironment(config, {
      platform: this.deps.platform,
      cpuCount: this.deps.cpuCount,
      fontFamilies: new Set(await this.deps.fonts.families()),
      musicTracks: new Set(this.deps.music.tracks.map((t) => t.id)),
      uploads: this.db.uploads.ids('music'),
    });
  }

  async create(body: unknown): Promise<{ id: string }> {
    const parsed = JobRequestSchema.safeParse(body);
    if (!parsed.success)
      throw badRequest('The request is invalid.', formatZodIssues(parsed.error.issues));
    const req = parsed.data;
    const resolved = resolveConfigInput(
      { config: req.config, presetId: req.presetId, overrides: req.overrides },
      this.db.presets.all(),
    );
    if (!resolved.ok)
      throw badRequest('The config is invalid.', prefixFields('config', resolved.errors));
    const config = resolved.config;

    const setup = await this.setup.state();
    if (setup.vault.locked)
      throw new HttpError(423, 'vault_locked', 'Unlock the key vault before starting a video.');
    if (!setup.complete) {
      throw new HttpError(
        409,
        'setup_incomplete',
        `Finish AI provider setup first: ${setup.missing.map((m) => `${m.role} (${m.reason})`).join('; ')}`,
      );
    }
    const env = await this.environment(config);
    if (env.length > 0)
      throw badRequest('The config does not fit this machine.', prefixFields('config', env));
    if (setup.roles.search.mode === 'off' && !req.sourceText) {
      throw badRequest('Web search is off: paste your own source text for this video.', [
        { path: 'sourceText', message: 'Required while web search is off.' },
      ]);
    }
    if (req.recordingUploadId) {
      const upload = this.db.uploads.get(req.recordingUploadId);
      if (!upload || upload.kind !== 'recording')
        throw badRequest('That recording upload was not found.', [
          { path: 'recordingUploadId', message: 'Unknown upload.' },
        ]);
    } else if (setup.roles.voice.mode === 'off') {
      throw badRequest('The voice role is off: upload your own recording for this video.', [
        { path: 'recordingUploadId', message: 'Required while the voice role is off.' },
      ]);
    }

    const settings = this.db.settings.get();
    const cost = estimateJobCost({
      lengthSeconds: req.lengthSeconds,
      animationKind: config.simple.animationKind,
      providers: await this.setup.estimateProviders(),
      prices: priceLookupFor(this.deps.registry, settings.pricingOverrides),
      sourceTextProvided: Boolean(req.sourceText),
      recordingProvided: Boolean(req.recordingUploadId),
      visionAlways: settings.visionRankAlways,
      visionFinalCheck: settings.visionFinalCheck,
    });
    const render = this.renderEstimate(config, req.lengthSeconds * 1000, 0);
    const id = this.deps.newId();
    this.db.jobs.insert({
      id,
      topic: req.topic,
      lengthSeconds: req.lengthSeconds,
      config,
      request: {
        ...(req.sourceText ? { sourceText: req.sourceText } : {}),
        ...(req.recordingUploadId ? { recordingUploadId: req.recordingUploadId } : {}),
      },
      estimatedUsd: cost.totalUsd,
      renderEstimate: render,
    });
    for (const stage of PREPARE_STAGES) this.db.stages.upsert(id, stage, { status: 'pending' });
    this.prepareQueue.push(() => this.runPrepare(id));
    return { id };
  }

  /** Render time for a style in review, from the job's real length and scene count. */
  estimateForJob(id: string, body: unknown): JobRenderEstimateResponse {
    const job = this.db.jobs.get(id);
    if (!job) throw notFound('Job');
    const parsed = RenderRequestSchema.safeParse(body);
    if (!parsed.success)
      throw badRequest('The config is invalid.', formatZodIssues(parsed.error.issues));
    if (!job.plan) throw new HttpError(409, 'not_ready', 'This job has no plan yet.');
    return {
      render: this.renderEstimate(parsed.data.config, job.plan.durationMs, job.plan.scenes.length),
    };
  }

  renderEstimate(config: VideoConfig, durationMs: number, sceneCount: number) {
    const samples = this.db.samples.all();
    const scenes = sceneCount || Math.max(1, Math.round(durationMs / 6000));
    return estimateRenderTime(
      config,
      { durationMs, sceneCount: scenes, cpuCount: this.deps.cpuCount },
      samples.length ? fitRenderModel(samples) : null,
    );
  }

  /* --------------------------------------------------------------- stages */

  private context(id: string, signal: AbortSignal): StageContext {
    const settings = this.db.settings.get();
    let seq = this.db.aiCalls.list(id).length;
    const ledger = new AiLedger({
      jobId: id,
      capUsd: settings.costCapUsd,
      initialSpentUsd: this.db.aiCalls.spent(id),
      prices: priceLookupFor(this.deps.registry, settings.pricingOverrides),
      now: this.deps.now,
      onRecord: (record: AiCallRecord) => {
        seq += 1;
        this.db.aiCalls.insert({
          ...record,
          id: `${id}-c${seq}`,
          ...(record.error ? { error: this.deps.scrubber.scrub(record.error) } : {}),
        });
        this.emitJob(id);
      },
    });
    return {
      jobId: id,
      ledger,
      cache: this.db.cache,
      files: jobFiles(this.deps.dataDir, id),
      signal,
      now: this.deps.now,
      log: (event) =>
        this.events.emit(id, {
          type: 'log',
          stage: event.stage,
          message: event.message,
        } satisfies JobEvent),
      onStage: (stage: Stage, status, detail) => {
        this.db.stages.upsert(id, stage, {
          status,
          ...(detail ? { detail: this.deps.scrubber.scrub(detail) } : {}),
        });
        this.db.jobs.update(id, { stage });
        this.emitJob(id);
      },
    };
  }

  /** URL for a file the plan references: job assets, or shared media (library music, uploads). */
  private assetUrl(id: string, path: string): string {
    const encode = (rel: string) => rel.split(sep).map(encodeURIComponent).join('/');
    const inJob = relative(jobDir(this.deps.dataDir, id), path);
    if (!inJob.startsWith('..')) return `/api/jobs/${id}/assets/${encode(inJob)}`;
    const media = relative(this.deps.dataDir, path);
    if (!media.startsWith('..')) return `/api/media/${encode(media)}`;
    throw new Error(`Cannot serve ${path}`);
  }

  private async musicPath(config: VideoConfig, durationMs: number): Promise<string | null> {
    const { music } = config.audio;
    if (music.source === 'library' && music.trackId)
      return this.deps.music.pathFor(music.trackId, Math.ceil(durationMs));
    if (music.source === 'upload' && music.uploadId)
      return this.db.uploads.get(music.uploadId)?.path ?? null;
    return null;
  }

  private musicCredit(config: VideoConfig): MusicCredit {
    const { music } = config.audio;
    if (music.source === 'library')
      return {
        kind: 'library',
        label: this.deps.music.tracks.find((t) => t.id === music.trackId)?.label ?? 'Library track',
      };
    if (music.source === 'upload') return { kind: 'upload' };
    return { kind: 'none' };
  }

  private fail(
    id: string,
    error: unknown,
    signal: AbortSignal,
    fallbackStage: string | null,
  ): void {
    if (signal.aborted) {
      this.db.jobs.update(id, { status: 'cancelled', progress: null });
    } else {
      const message = this.deps.scrubber.scrub(
        error instanceof Error ? error.message : String(error),
      );
      const stage =
        error instanceof PipelineError
          ? error.stage
          : (this.db.jobs.get(id)?.stage ?? fallbackStage);
      this.db.jobs.update(id, { status: 'failed', error: { stage, message }, progress: null });
    }
    this.emitJob(id);
  }

  private async runPrepare(id: string): Promise<void> {
    const job = this.db.jobs.get(id);
    if (!job || job.status !== 'queued') return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.db.jobs.update(id, { status: 'preparing', error: null });
    this.emitJob(id);
    try {
      const ctx = this.context(id, controller.signal);
      const providers = await this.setup.providerSet();
      const recordingPath = job.request.recordingUploadId
        ? this.db.uploads.get(job.request.recordingUploadId)?.path
        : undefined;
      const files = jobFiles(this.deps.dataDir, id);
      const result = await prepareJob(
        ctx,
        {
          topic: job.topic,
          lengthSeconds: job.lengthSeconds,
          config: job.config,
          sourceText: job.request.sourceText,
          recordingPath,
        },
        {
          providers,
          fetcher: this.deps.pageFetcher,
          imageSource: this.deps.imageSource,
          imageOps: this.deps.media.imageOps(files.dir),
          media: this.deps.media.pipeline,
          visionAlways: this.db.settings.get().visionRankAlways,
          assetUrl: (path) => this.assetUrl(id, path),
          fontInfo: (family) => this.deps.fonts.info(family),
          musicPath: (config, durationMs) => this.musicPath(config, durationMs),
        },
      );
      if (controller.signal.aborted) throw controller.signal.reason;
      this.db.jobs.update(id, {
        status: 'review',
        stage: null,
        plan: result.plan,
        prepared: {
          narrationPath: result.voice.audioPath,
          title: result.script.title,
          warnings: result.warnings,
          imageDecisions: result.images.map(
            ({ sceneIndex, query, method, bestScore, chosenId, reason }) => ({
              sceneIndex,
              query,
              method,
              bestScore,
              chosenId,
              reason,
            }),
          ),
          factSheetPath: files.pathFor('factsheet.json'),
        },
        renderEstimate: this.renderEstimate(
          job.config,
          result.plan.durationMs,
          result.plan.scenes.length,
        ),
      });
      this.emitJob(id);
    } catch (error) {
      this.fail(id, error, controller.signal, 'research');
    } finally {
      this.controllers.delete(id);
    }
  }

  async render(id: string, body: unknown): Promise<void> {
    const job = this.db.jobs.get(id);
    if (!job) throw notFound('Job');
    const parsed = RenderRequestSchema.safeParse(body);
    if (!parsed.success)
      throw badRequest('The config is invalid.', formatZodIssues(parsed.error.issues));
    const config = parsed.data.config;
    const env = await this.environment(config);
    if (env.length > 0)
      throw badRequest('The config does not fit this machine.', prefixFields('config', env));
    if (!job.plan || !['review', 'done', 'failed'].includes(job.status)) {
      throw new HttpError(409, 'not_ready', 'This job has no plan to render yet.');
    }
    const isStyleRerun = job.renders > 0;
    const plan = await this.planForConfig(id, job.plan, config);
    this.db.jobs.update(id, {
      status: 'rendering',
      config,
      plan,
      error: null,
      progress: 0,
      renderEstimate: this.renderEstimate(config, job.plan.durationMs, job.plan.scenes.length),
    });
    this.db.stages.reset(id, RENDER_STAGES);
    for (const stage of RENDER_STAGES) this.db.stages.upsert(id, stage, { status: 'pending' });
    this.emitJob(id);
    this.renderQueue.push(() => this.runRender(id, isStyleRerun));
  }

  /**
   * Review can change things the plan carries: the caption font (FontInfo), a palette pulled from
   * the first image, and the music bed. Re-resolve them so the stored plan matches the render.
   */
  private async planForConfig(
    id: string,
    plan: ScenePlan,
    config: VideoConfig,
  ): Promise<ScenePlan> {
    let next = plan;
    const music = await this.musicPath(config, plan.durationMs);
    const musicSrc = music ? this.assetUrl(id, music) : null;
    if (musicSrc !== next.audio.musicSrc) next = { ...next, audio: { ...next.audio, musicSrc } };
    const family = (plan.fonts.caption as { fontFamily?: string } | null)?.fontFamily;
    if (family !== config.captions.fontFamily) {
      next = {
        ...next,
        fonts: { caption: await this.deps.fonts.info(config.captions.fontFamily) },
      };
    }
    if (config.backdrop.palette.source === 'image' && !next.palette) {
      const prefix = `/api/jobs/${id}/assets/`;
      const first = next.scenes.find(
        (s) => s.visual.type === 'image' && s.visual.src.startsWith(prefix),
      );
      if (first?.visual.type === 'image') {
        const path = safeJoin(jobDir(this.deps.dataDir, id), first.visual.src.slice(prefix.length));
        const palette = path
          ? await this.deps.media
              .imageOps(jobDir(this.deps.dataDir, id))
              .palette(path)
              .catch(() => null)
          : null;
        if (palette) next = { ...next, palette };
      }
    }
    return next;
  }

  private async runRender(id: string, isStyleRerun: boolean): Promise<void> {
    const job = this.db.jobs.get(id);
    if (!job || job.status !== 'rendering' || !job.plan || !job.prepared) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      const ctx = this.context(id, controller.signal);
      const settings = this.db.settings.get();
      const factSheet = await readFile(job.prepared.factSheetPath, 'utf8')
        .then((t) => JSON.parse(t) as FactSheet)
        .catch(() => null);
      const vision =
        settings.visionFinalCheck && !isStyleRerun
          ? await this.setup
              .providerSet()
              .then((p) => p.vision)
              .catch(() => null)
          : null;
      const musicPath = await this.musicPath(job.config, job.plan.durationMs);
      const result = await finalizeJob(
        ctx,
        {
          plan: absolutizePlan(job.plan, this.deps.publicOrigin),
          config: job.config,
          requestedLengthSeconds: job.lengthSeconds,
          factSheet,
          isStyleRerun,
          narrationPath: job.prepared.narrationPath,
          musicPath,
          music: this.musicCredit(job.config),
        },
        {
          render: (args) =>
            this.deps.renderer.render({
              ...args,
              onProgress: (progress) => {
                this.db.jobs.update(id, { progress });
                this.events.emit(id, {
                  type: 'progress',
                  stage: 'render',
                  progress,
                } satisfies JobEvent);
              },
            }),
          mixAudio: (args) => this.deps.media.mixAudio(args),
          mux: (args) => this.deps.media.mux(args),
          probeDurationMs: (path) => this.deps.media.probeDurationMs(path),
          measureClipping: (path) => this.deps.media.measureClipping(path),
          contactSheet: (videoPath, outputPath) =>
            this.deps.media.contactSheet(videoPath, outputPath),
          vision,
          visionFinalCheck: settings.visionFinalCheck,
        },
      );
      const sheet = ctx.files.pathFor('contact-sheet.png');
      const url = (path: string) => `/api/jobs/${id}/files/${encodeURIComponent(basename(path))}`;
      this.db.jobs.update(id, {
        status: 'done',
        stage: null,
        progress: 1,
        renders: job.renders + 1,
        result: {
          outputs: {
            video: url(result.videoPath),
            srt: url(result.srtPath),
            credits: url(result.creditsPath),
            contactSheet: (await ctx.files.exists(sheet)) ? url(sheet) : null,
          },
          checks: result.checks,
          renderElapsedMs: result.renderElapsedMs,
        },
      });
      const features = extractRenderFeatures(job.config, {
        durationMs: job.plan.durationMs,
        sceneCount: job.plan.scenes.length,
        cpuCount: this.deps.cpuCount,
      });
      this.db.samples.insert({ features, elapsedMs: result.renderElapsedMs, source: 'render' });
      this.db.timedTransitions.add(features.transitions);
      // "Render again" should quote the model that now includes this render.
      this.db.jobs.update(id, {
        renderEstimate: this.renderEstimate(
          job.config,
          job.plan.durationMs,
          job.plan.scenes.length,
        ),
      });
      this.emitJob(id);
    } catch (error) {
      if (!controller.signal.aborted) this.fail(id, error, controller.signal, 'render');
      else if (this.db.jobs.get(id)) {
        // Cancelled: the reviewed plan is intact, so the job goes back to review.
        this.db.jobs.update(id, { status: 'review', progress: null });
        this.db.stages.reset(id, RENDER_STAGES);
        this.emitJob(id);
      }
    } finally {
      this.controllers.delete(id);
    }
  }

  cancel(id: string): void {
    const job = this.db.jobs.get(id);
    if (!job) throw notFound('Job');
    const controller = this.controllers.get(id);
    if (controller) controller.abort(new Error('Cancelled by the user.'));
    if (job.status === 'queued' || (job.status === 'rendering' && !controller)) {
      this.db.jobs.update(id, {
        status: job.status === 'queued' ? 'cancelled' : 'review',
        progress: null,
      });
      if (job.status === 'rendering') this.db.stages.reset(id, RENDER_STAGES);
    }
    this.emitJob(id);
  }

  async delete(id: string): Promise<void> {
    if (!this.db.jobs.get(id)) throw notFound('Job');
    this.controllers.get(id)?.abort(new Error('Deleted.'));
    this.db.jobs.delete(id);
    await rm(jobDir(this.deps.dataDir, id), { recursive: true, force: true });
  }

  /** After a restart: nothing is running any more. */
  recover(): void {
    for (const job of this.db.jobs.withStatus(['queued', 'preparing'])) {
      this.db.jobs.update(job.id, {
        status: 'failed',
        error: {
          stage: job.stage,
          message: 'The server stopped before this video was prepared. Start it again.',
        },
      });
    }
    for (const job of this.db.jobs.withStatus(['rendering'])) {
      this.db.jobs.update(job.id, {
        status: job.plan ? 'review' : 'failed',
        error: {
          stage: 'render',
          message: 'The server stopped during the render. Render it again.',
        },
        progress: null,
      });
    }
  }

  /** For tests and graceful shutdown. */
  async idle(): Promise<void> {
    await Promise.all([this.prepareQueue.idle(), this.renderQueue.idle()]);
  }
}
