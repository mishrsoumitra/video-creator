import { z } from 'zod';
import type { ConfigWarning } from './warnings';
import type { FieldError } from './expert';
import type { Preset } from './presets';
import type { RenderEstimate } from './render-estimate';
import type { ScenePlan } from './plan';
import { VideoConfigSchema, type VideoConfig } from './schema';

/*
 * The HTTP contract between @vc/server and @vc/web. Request bodies are Zod schemas (validated by
 * the server, reused by the client); responses are types. Every route is under /api. Mutating
 * requests must send the CLIENT_HEADER.
 */

export const CLIENT_HEADER = 'x-vc-client';
export const CLIENT_HEADER_VALUE = 'web';

export const ROLE_IDS = ['text', 'search', 'voice', 'align', 'vision'] as const;
export type RoleId = (typeof ROLE_IDS)[number];

/** Roles that may be switched off: search (paste your own text), voice (upload recordings), align (use the voice's own timings), vision. */
export const OPTIONAL_ROLES: readonly RoleId[] = ['search', 'voice', 'align', 'vision'];

export type ApiError = { error: { code: string; message: string; fields?: FieldError[] } };

/* ------------------------------------------------------------------ setup */

export type RoleTest = {
  status: 'untested' | 'passed' | 'failed';
  at: string | null;
  /** The model the test call actually reached. */
  model: string | null;
  detail: string | null;
  durationMs: number | null;
};

export type RoleSlot = {
  role: RoleId;
  /** "off" = switched off (search, voice, align, vision only). */
  mode: 'provider' | 'off';
  providerId: string | null;
  model: string | null;
  options: Record<string, unknown>;
  test: RoleTest;
};

export type CredentialSummary = { id: string; label: string; masked: string; updatedAt: string };

export type VaultState = {
  backend: 'keychain' | 'file' | 'memory';
  locked: boolean;
  needsSetup: boolean;
};

export type SetupState = {
  /** No video job starts until this is true. */
  complete: boolean;
  missing: Array<{ role: RoleId; reason: string }>;
  roles: Record<RoleId, RoleSlot>;
  credentials: CredentialSummary[];
  vault: VaultState;
};

export const PutCredentialSchema = z.strictObject({ apiKey: z.string().trim().min(1).max(4096) });
export const PutRoleSchema = z.strictObject({
  mode: z.enum(['provider', 'off']),
  providerId: z.string().min(1).max(64).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});
export const PassphraseSchema = z.strictObject({ passphrase: z.string().min(8).max(1024) });

export type CatalogRole = {
  label: string;
  defaultModel: string;
  suggestedModels: string[];
  optionsSchema: Record<string, unknown>;
};
export type CatalogProvider = {
  id: string;
  label: string;
  kind: 'cloud' | 'local';
  description: string;
  credential: { id: string; label: string; helpUrl: string; optional: boolean } | null;
  roles: Partial<Record<RoleId, CatalogRole>>;
};

export type RoleTestResult = {
  ok: boolean;
  model: string | null;
  detail: string;
  durationMs: number;
};

/* --------------------------------------------------------------- settings */

export const UnitPricesSchema = z.strictObject({
  inputPerMTok: z.number().min(0).optional(),
  outputPerMTok: z.number().min(0).optional(),
  perSearch: z.number().min(0).optional(),
  perMChars: z.number().min(0).optional(),
  perAudioMinute: z.number().min(0).optional(),
  perImage: z.number().min(0).optional(),
  source: z.string().max(200).optional(),
});

const settingsFields = {
  /** Per-job AI spending cap in USD. */
  costCapUsd: z.number().min(0).max(1000),
  /** Vision ranks every scene's images (otherwise only below the threshold). */
  visionRankAlways: z.boolean(),
  /** Vision looks at a 12-frame contact sheet after rendering. Off by default. */
  visionFinalCheck: z.boolean(),
  /** "providerId/model" → prices that replace the built-in table. */
  pricingOverrides: z.record(z.string(), UnitPricesSchema),
  defaultPresetId: z.string().min(1).max(80),
};

export const SettingsSchema = z.strictObject({
  costCapUsd: settingsFields.costCapUsd.default(2),
  visionRankAlways: settingsFields.visionRankAlways.default(false),
  visionFinalCheck: settingsFields.visionFinalCheck.default(false),
  pricingOverrides: settingsFields.pricingOverrides.default({}),
  defaultPresetId: settingsFields.defaultPresetId.default('documentary'),
});
export type Settings = z.output<typeof SettingsSchema>;
/** Built without defaults: in Zod 4 `.partial()` keeps them, and a PUT would reset omitted keys. */
export const PutSettingsSchema = z.strictObject(settingsFields).partial();

/* ---------------------------------------------------------------- presets */

export const CreatePresetSchema = z.strictObject({
  name: z.string().max(200),
  description: z.string().max(200).optional(),
  config: VideoConfigSchema,
});
export const UpdatePresetSchema = z.strictObject({
  name: z.string().max(200).optional(),
  description: z.string().max(200).optional(),
  config: VideoConfigSchema.optional(),
});

/* ----------------------------------------------------------- config tools */

export const ValidateConfigSchema = z.strictObject({ config: z.unknown() });
export type ValidateConfigResponse = {
  ok: boolean;
  config: VideoConfig | null;
  errors: FieldError[];
  warnings: ConfigWarning[];
  environment: FieldError[];
};

export type MusicTrack = { id: string; label: string; mood: string };

/** A library music bed rendered to a given length (the review preview plays it). */
export const musicPreviewUrl = (trackId: string, durationMs: number) =>
  `/api/music/${encodeURIComponent(trackId)}?durationMs=${Math.round(durationMs)}`;

export type CatalogResponse = {
  /** Transitions the UI may offer (gated ones appear once timed on this machine). */
  exposedTransitions: string[];
  timedTransitions: string[];
  fonts: string[];
  musicTracks: MusicTrack[];
  platform: string;
  cpuCount: number;
};

export const EstimateRequestSchema = z.strictObject({
  lengthSeconds: z.int().min(15).max(600),
  config: VideoConfigSchema,
  sourceTextProvided: z.boolean().default(false),
  recordingProvided: z.boolean().default(false),
});

export type CostEstimateLine = {
  stage: string;
  role: RoleId;
  providerId: string;
  model: string;
  usd: number;
  maxUsd: number;
  note: string;
};
export type EstimateResponse = {
  cost: {
    totalUsd: number;
    maxUsd: number;
    lines: CostEstimateLine[];
    unpriced: string[];
    capUsd: number;
  };
  render: RenderEstimate;
};

/* ---------------------------------------------------------------- uploads */

export const UPLOAD_KINDS = ['recording', 'music'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];
export type UploadResponse = { id: string; kind: UploadKind; name: string; durationMs: number };

/* ------------------------------------------------------------------- jobs */

export const JOB_STATUSES = [
  'queued',
  'preparing',
  'review',
  'rendering',
  'done',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type StageState = {
  stage: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type AiCallView = {
  id: string;
  stage: string;
  role: RoleId;
  providerId: string;
  model: string;
  reason: string;
  ai: boolean;
  required: boolean;
  status: 'ok' | 'error' | 'skipped-cap' | 'skipped-limit';
  units: Record<string, number>;
  costUsd: number;
  priced: boolean;
  startedAt: string;
  durationMs: number;
  error?: string;
};

export type CheckView = {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  detail: string;
};

export type ImageDecisionView = {
  sceneIndex: number;
  query: string;
  method: 'deterministic' | 'vision' | 'fallback';
  bestScore: number | null;
  chosenId: string | null;
  reason: string;
};

export type JobSummary = {
  id: string;
  topic: string;
  lengthSeconds: number;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  costUsd: number;
};

export type JobDetail = JobSummary & {
  stage: string | null;
  stages: StageState[];
  config: VideoConfig;
  plan: ScenePlan | null;
  warnings: string[];
  error: { stage: string | null; message: string } | null;
  aiCalls: AiCallView[];
  cost: { estimatedUsd: number | null; actualUsd: number; capUsd: number };
  render: {
    estimate: RenderEstimate | null;
    elapsedMs: number | null;
    progress: number | null;
    renders: number;
  };
  outputs: {
    video: string | null;
    srt: string | null;
    credits: string | null;
    contactSheet: string | null;
  };
  checks: CheckView[];
  imageDecisions: ImageDecisionView[];
  hasRecording: boolean;
  sourceTextProvided: boolean;
};

export const RenderRequestSchema = z.strictObject({ config: VideoConfigSchema });

/** 202 body of POST /api/jobs, /api/jobs/:id/render and /api/jobs/:id/cancel. */
export type JobAccepted = { id: string };
/** POST /api/jobs/:id/estimate: the render time of a style for this job's actual plan. */
export type JobRenderEstimateResponse = { render: RenderEstimate };
/** GET /api/render-stats; `calibrating` stays true while a calibration runs in the background. */
export type RenderStats = { sampleCount: number; timedTransitions: string[]; calibrating: boolean };
/** 202 body of POST /api/calibrate (501 when this build cannot render). */
export type CalibrateResponse = { calibrating: boolean };

/** Server-sent event payloads on GET /api/jobs/:id/events. */
export type JobEvent =
  | { type: 'job'; job: JobDetail }
  | { type: 'progress'; stage: string; progress: number }
  | { type: 'log'; stage: string; message: string };

export type PresetsResponse = Preset[];

/** Upload id prefix etc. are server details; the client only round-trips ids. */
export const isRoleId = (value: string): value is RoleId =>
  (ROLE_IDS as readonly string[]).includes(value);
