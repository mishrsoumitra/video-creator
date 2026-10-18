import Database from 'better-sqlite3';
import {
  PresetSchema,
  ROLE_IDS,
  SettingsSchema,
  VideoConfigSchema,
  type CheckView,
  type ImageDecisionView,
  type JobStatus,
  type Preset,
  type RenderEstimate,
  type RenderSample,
  type RoleId,
  type RoleSlot,
  type ScenePlan,
  type Settings,
  type StageState,
  type VideoConfig,
} from '@vc/config';
import type { AiCallRecord, CacheStore } from '@vc/pipeline';

export const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE roles (role TEXT PRIMARY KEY, slot TEXT NOT NULL);
    CREATE TABLE credentials (id TEXT PRIMARY KEY, label TEXT NOT NULL, masked TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      record TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      length_seconds INTEGER NOT NULL,
      status TEXT NOT NULL,
      stage TEXT,
      config TEXT NOT NULL,
      request TEXT NOT NULL,
      plan TEXT,
      prepared TEXT,
      result TEXT,
      error TEXT,
      estimated_usd REAL,
      render_estimate TEXT,
      renders INTEGER NOT NULL DEFAULT 0,
      progress REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE job_stages (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      started_at TEXT,
      finished_at TEXT,
      PRIMARY KEY (job_id, stage)
    );
    CREATE TABLE ai_calls (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      record TEXT NOT NULL,
      cost_usd REAL NOT NULL,
      seq INTEGER NOT NULL
    );
    CREATE INDEX ai_calls_job ON ai_calls(job_id, seq);
    CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE render_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, sample TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE uploads (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, duration_ms INTEGER NOT NULL, created_at TEXT NOT NULL);
  `,
};

export type JobRequestData = { sourceText?: string; recordingUploadId?: string };

/** What the review screen and the render need from the preparation run. */
export type PreparedData = {
  narrationPath: string;
  title: string;
  warnings: string[];
  imageDecisions: ImageDecisionView[];
  factSheetPath: string;
};

export type JobResult = {
  outputs: {
    video: string | null;
    srt: string | null;
    credits: string | null;
    contactSheet: string | null;
  };
  checks: CheckView[];
  renderElapsedMs: number | null;
};

export type JobRow = {
  id: string;
  topic: string;
  lengthSeconds: number;
  status: JobStatus;
  stage: string | null;
  config: VideoConfig;
  request: JobRequestData;
  plan: ScenePlan | null;
  prepared: PreparedData | null;
  result: JobResult | null;
  error: { stage: string | null; message: string } | null;
  estimatedUsd: number | null;
  renderEstimate: RenderEstimate | null;
  renders: number;
  progress: number | null;
  createdAt: string;
  updatedAt: string;
};

export type UploadRow = {
  id: string;
  kind: 'recording' | 'music';
  name: string;
  path: string;
  durationMs: number;
  createdAt: string;
};

const json = (value: unknown) =>
  value === null || value === undefined ? null : JSON.stringify(value);
const parse = <T>(text: string | null): T | null =>
  text === null ? null : (JSON.parse(text) as T);

const untestedSlot = (role: RoleId): RoleSlot => ({
  role,
  // Vision is optional and off by default; every other role starts unconfigured.
  mode: role === 'vision' ? 'off' : 'provider',
  providerId: null,
  model: null,
  options: {},
  test: { status: 'untested', at: null, model: null, detail: null, durationMs: null },
});

export const openDb = (path: string, { now = Date.now }: { now?: () => number } = {}) => {
  const sql = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.pragma('foreign_keys = ON');
  const current = sql.pragma('user_version', { simple: true }) as number;
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    sql.transaction(() => {
      sql.exec(MIGRATIONS[v]!);
      sql.pragma(`user_version = ${v}`);
    })();
  }
  const iso = () => new Date(now()).toISOString();

  const meta = {
    get: (key: string): string | null =>
      (
        sql.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
          { value: string } | undefined
      )?.value ?? null,
    set: (key: string, value: string) =>
      sql
        .prepare(
          'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(key, value),
  };

  const settings = {
    get: (): Settings => SettingsSchema.parse(parse<Partial<Settings>>(meta.get('settings')) ?? {}),
    put: (patch: Partial<Settings>): Settings => {
      const next = SettingsSchema.parse({ ...settings.get(), ...patch });
      meta.set('settings', JSON.stringify(next));
      return next;
    },
  };

  const roles = {
    get: (role: RoleId): RoleSlot =>
      parse<RoleSlot>(
        (
          sql.prepare('SELECT slot FROM roles WHERE role = ?').get(role) as
            { slot: string } | undefined
        )?.slot ?? null,
      ) ?? untestedSlot(role),
    all: (): RoleSlot[] => ROLE_IDS.map((r) => roles.get(r)),
    put: (slot: RoleSlot) =>
      sql
        .prepare(
          'INSERT INTO roles (role, slot) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET slot = excluded.slot',
        )
        .run(slot.role, JSON.stringify(slot)),
  };

  const credentials = {
    all: () =>
      (
        sql
          .prepare('SELECT id, label, masked, updated_at FROM credentials ORDER BY id')
          .all() as Array<{ id: string; label: string; masked: string; updated_at: string }>
      ).map((r) => ({
        id: r.id,
        label: r.label,
        masked: r.masked,
        updatedAt: r.updated_at,
      })),
    has: (id: string) =>
      sql.prepare('SELECT 1 FROM credentials WHERE id = ?').get(id) !== undefined,
    put: ({ id, label, masked }: { id: string; label: string; masked: string }) =>
      sql
        .prepare(
          'INSERT INTO credentials (id, label, masked, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label, masked = excluded.masked, updated_at = excluded.updated_at',
        )
        .run(id, label, masked, iso()),
    delete: (id: string) => sql.prepare('DELETE FROM credentials WHERE id = ?').run(id),
  };

  const presets = {
    all: (): Preset[] =>
      (
        sql.prepare('SELECT record FROM presets ORDER BY name').all() as Array<{ record: string }>
      ).map((r) => PresetSchema.parse(JSON.parse(r.record))),
    get: (id: string): Preset | undefined => {
      const row = sql.prepare('SELECT record FROM presets WHERE id = ?').get(id) as
        { record: string } | undefined;
      return row ? PresetSchema.parse(JSON.parse(row.record)) : undefined;
    },
    insert: (preset: Preset) => {
      const record = { ...preset, createdAt: iso(), updatedAt: iso() };
      sql
        .prepare('INSERT INTO presets (id, name, record) VALUES (?, ?, ?)')
        .run(preset.id, preset.name, JSON.stringify(record));
      return record;
    },
    update: (id: string, patch: Partial<Pick<Preset, 'name' | 'description' | 'config'>>) => {
      const existing = presets.get(id);
      if (!existing) return undefined;
      const next = PresetSchema.parse({ ...existing, ...patch, updatedAt: iso() });
      sql
        .prepare('UPDATE presets SET name = ?, record = ? WHERE id = ?')
        .run(next.name, JSON.stringify(next), id);
      return next;
    },
    delete: (id: string) => sql.prepare('DELETE FROM presets WHERE id = ?').run(id).changes > 0,
  };

  type JobDbRow = {
    id: string;
    topic: string;
    length_seconds: number;
    status: JobStatus;
    stage: string | null;
    config: string;
    request: string;
    plan: string | null;
    prepared: string | null;
    result: string | null;
    error: string | null;
    estimated_usd: number | null;
    render_estimate: string | null;
    renders: number;
    progress: number | null;
    created_at: string;
    updated_at: string;
  };
  const toJob = (r: JobDbRow): JobRow => ({
    id: r.id,
    topic: r.topic,
    lengthSeconds: r.length_seconds,
    status: r.status,
    stage: r.stage,
    config: VideoConfigSchema.parse(JSON.parse(r.config)),
    request: JSON.parse(r.request) as JobRequestData,
    plan: parse<ScenePlan>(r.plan),
    prepared: parse<PreparedData>(r.prepared),
    result: parse<JobResult>(r.result),
    error: parse<JobRow['error']>(r.error),
    estimatedUsd: r.estimated_usd,
    renderEstimate: parse<RenderEstimate>(r.render_estimate),
    renders: r.renders,
    progress: r.progress,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const COLUMNS: Record<string, string> = {
    status: 'status',
    stage: 'stage',
    config: 'config',
    plan: 'plan',
    prepared: 'prepared',
    result: 'result',
    error: 'error',
    estimatedUsd: 'estimated_usd',
    renderEstimate: 'render_estimate',
    renders: 'renders',
    progress: 'progress',
  };
  const JSON_FIELDS = new Set(['config', 'plan', 'prepared', 'result', 'error', 'renderEstimate']);

  const jobs = {
    insert: (job: {
      id: string;
      topic: string;
      lengthSeconds: number;
      config: VideoConfig;
      request: JobRequestData;
      estimatedUsd?: number | null;
      renderEstimate?: RenderEstimate | null;
    }) => {
      sql
        .prepare(
          'INSERT INTO jobs (id, topic, length_seconds, status, config, request, estimated_usd, render_estimate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          job.id,
          job.topic,
          job.lengthSeconds,
          'queued',
          JSON.stringify(job.config),
          JSON.stringify(job.request),
          job.estimatedUsd ?? null,
          json(job.renderEstimate ?? null),
          iso(),
          iso(),
        );
    },
    get: (id: string): JobRow | undefined => {
      const row = sql.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobDbRow | undefined;
      return row ? toJob(row) : undefined;
    },
    list: (): JobRow[] =>
      (sql.prepare('SELECT * FROM jobs ORDER BY created_at DESC, id DESC').all() as JobDbRow[]).map(
        toJob,
      ),
    update: (
      id: string,
      patch: Partial<
        Omit<JobRow, 'id' | 'topic' | 'lengthSeconds' | 'request' | 'createdAt' | 'updatedAt'>
      >,
    ) => {
      const entries = Object.entries(patch).filter(([k]) => k in COLUMNS);
      if (entries.length === 0) return;
      const sets = entries.map(([k]) => `${COLUMNS[k]} = ?`).join(', ');
      const values = entries.map(([k, v]) => (JSON_FIELDS.has(k) ? json(v) : (v as unknown)));
      sql
        .prepare(`UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ?`)
        .run(...(values as never[]), iso(), id);
    },
    delete: (id: string) => sql.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0,
    withStatus: (statuses: readonly JobStatus[]) =>
      (
        sql
          .prepare(`SELECT * FROM jobs WHERE status IN (${statuses.map(() => '?').join(',')})`)
          .all(...statuses) as JobDbRow[]
      ).map(toJob),
  };

  const stages = {
    upsert: (jobId: string, stage: string, patch: Partial<Omit<StageState, 'stage'>>) => {
      const existing = sql
        .prepare('SELECT * FROM job_stages WHERE job_id = ? AND stage = ?')
        .get(jobId, stage) as
        | {
            status: string;
            detail: string | null;
            started_at: string | null;
            finished_at: string | null;
          }
        | undefined;
      const status = patch.status ?? existing?.status ?? 'pending';
      const startedAt =
        patch.startedAt ?? existing?.started_at ?? (status === 'running' ? iso() : null);
      const finishedAt =
        patch.finishedAt ??
        (status === 'done' || status === 'failed' || status === 'skipped'
          ? iso()
          : (existing?.finished_at ?? null));
      const detail = patch.detail === undefined ? (existing?.detail ?? null) : patch.detail;
      sql
        .prepare(
          'INSERT INTO job_stages (job_id, stage, status, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, stage) DO UPDATE SET status = excluded.status, detail = excluded.detail, started_at = excluded.started_at, finished_at = excluded.finished_at',
        )
        .run(jobId, stage, status, detail, startedAt, finishedAt);
    },
    list: (jobId: string): StageState[] =>
      (
        sql
          .prepare('SELECT * FROM job_stages WHERE job_id = ? ORDER BY rowid')
          .all(jobId) as Array<{
          stage: string;
          status: StageState['status'];
          detail: string | null;
          started_at: string | null;
          finished_at: string | null;
        }>
      ).map((r) => ({
        stage: r.stage,
        status: r.status,
        detail: r.detail,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      })),
    reset: (jobId: string, names: readonly string[]) => {
      const del = sql.prepare('DELETE FROM job_stages WHERE job_id = ? AND stage = ?');
      for (const name of names) del.run(jobId, name);
    },
  };

  const aiCalls = {
    insert: (record: AiCallRecord) => {
      const seq = (
        sql.prepare('SELECT COUNT(*) AS n FROM ai_calls WHERE job_id = ?').get(record.jobId) as {
          n: number;
        }
      ).n;
      sql
        .prepare(
          'INSERT OR REPLACE INTO ai_calls (id, job_id, record, cost_usd, seq) VALUES (?, ?, ?, ?, ?)',
        )
        .run(record.id, record.jobId, JSON.stringify(record), record.costUsd, seq);
    },
    list: (jobId: string): AiCallRecord[] =>
      (
        sql
          .prepare('SELECT record FROM ai_calls WHERE job_id = ? ORDER BY seq')
          .all(jobId) as Array<{ record: string }>
      ).map((r) => JSON.parse(r.record) as AiCallRecord),
    spent: (jobId: string): number =>
      (
        sql
          .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_calls WHERE job_id = ?')
          .get(jobId) as { total: number }
      ).total,
  };

  const cache: CacheStore = {
    async get<T>(key: string) {
      const row = sql
        .prepare('SELECT value, created_at, expires_at FROM cache WHERE key = ?')
        .get(key) as { value: string; created_at: number; expires_at: number } | undefined;
      if (!row) return null;
      if (now() >= row.expires_at) {
        sql.prepare('DELETE FROM cache WHERE key = ?').run(key);
        return null;
      }
      return { value: JSON.parse(row.value) as T, createdAt: row.created_at };
    },
    async set<T>(key: string, value: T, ttlMs: number) {
      const t = now();
      sql
        .prepare(
          'INSERT INTO cache (key, value, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at',
        )
        .run(key, JSON.stringify(value), t, t + ttlMs);
    },
    async delete(key: string) {
      sql.prepare('DELETE FROM cache WHERE key = ?').run(key);
    },
  };

  const samples = {
    insert: (sample: RenderSample) =>
      sql
        .prepare('INSERT INTO render_samples (sample, created_at) VALUES (?, ?)')
        .run(JSON.stringify(sample), iso()),
    all: (): RenderSample[] =>
      (
        sql.prepare('SELECT sample FROM render_samples ORDER BY id').all() as Array<{
          sample: string;
        }>
      ).map((r) => JSON.parse(r.sample) as RenderSample),
  };

  const timedTransitions = {
    get: (): Set<string> => new Set(parse<string[]>(meta.get('timedTransitions')) ?? []),
    add: (names: readonly string[]) =>
      meta.set(
        'timedTransitions',
        JSON.stringify([...new Set([...timedTransitions.get(), ...names])].sort()),
      ),
  };

  const uploads = {
    insert: (u: UploadRow) =>
      sql
        .prepare(
          'INSERT INTO uploads (id, kind, name, path, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(u.id, u.kind, u.name, u.path, u.durationMs, u.createdAt),
    get: (id: string): UploadRow | undefined => {
      const r = sql.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as
        | {
            id: string;
            kind: UploadRow['kind'];
            name: string;
            path: string;
            duration_ms: number;
            created_at: string;
          }
        | undefined;
      return r
        ? {
            id: r.id,
            kind: r.kind,
            name: r.name,
            path: r.path,
            durationMs: r.duration_ms,
            createdAt: r.created_at,
          }
        : undefined;
    },
    ids: (kind?: UploadRow['kind']): Set<string> =>
      new Set(
        (
          sql
            .prepare(kind ? 'SELECT id FROM uploads WHERE kind = ?' : 'SELECT id FROM uploads')
            .all(...(kind ? [kind] : [])) as Array<{ id: string }>
        ).map((r) => r.id),
      ),
  };

  return {
    raw: sql,
    schemaVersion: () => sql.pragma('user_version', { simple: true }) as number,
    meta,
    settings,
    roles,
    credentials,
    presets,
    jobs,
    stages,
    aiCalls,
    cache,
    samples,
    timedTransitions,
    uploads,
    close: () => sql.close(),
  };
};

export type Db = ReturnType<typeof openDb>;
