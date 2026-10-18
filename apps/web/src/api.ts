import {
  type CalibrateResponse,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  type CatalogProvider,
  type CatalogResponse,
  type CredentialSummary,
  type EstimateResponse,
  type FieldError,
  type FontInfo,
  type JobAccepted,
  type JobDetail,
  type JobEvent,
  type JobRenderEstimateResponse,
  type JobSummary,
  type Preset,
  type RenderStats,
  type RoleId,
  type RoleTestResult,
  type Settings,
  type SetupState,
  type UploadKind,
  type UploadResponse,
  type ValidateConfigResponse,
  type VideoConfig,
} from '@vc/config';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldError[];

  constructor(status: number, code: string, message: string, fields: FieldError[] = []) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const request = async <T>(method: Method, path: string, body?: unknown): Promise<T> => {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers[CLIENT_HEADER] = CLIENT_HEADER_VALUE;
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const error = (
      data as { error?: { code?: string; message?: string; fields?: FieldError[] } } | undefined
    )?.error;
    throw new ApiRequestError(
      res.status,
      error?.code ?? `http_${res.status}`,
      error?.message ?? `Request failed (${res.status}).`,
      error?.fields ?? [],
    );
  }
  return data as T;
};

const seg = encodeURIComponent;

export type { RenderStats };
export type CreateJobBody = {
  topic: string;
  lengthSeconds: number;
  config: VideoConfig;
  sourceText?: string;
  recordingUploadId?: string;
};
export type EstimateBody = {
  lengthSeconds: number;
  config: VideoConfig;
  sourceTextProvided: boolean;
  recordingProvided: boolean;
};

export const api = {
  getSetup: () => request<SetupState>('GET', '/setup'),
  getProviders: () => request<CatalogProvider[]>('GET', '/providers'),
  putCredential: (id: string, apiKey: string) =>
    request<CredentialSummary>('PUT', `/credentials/${seg(id)}`, { apiKey }),
  deleteCredential: (id: string) => request<void>('DELETE', `/credentials/${seg(id)}`),
  putRole: (
    role: RoleId,
    body: {
      mode: 'provider' | 'off';
      providerId?: string;
      model?: string;
      options?: Record<string, unknown>;
    },
  ) => request<SetupState>('PUT', `/setup/roles/${role}`, body),
  testRole: (role: RoleId) => request<RoleTestResult>('POST', `/setup/roles/${role}/test`),
  vaultSetup: (passphrase: string) => request<SetupState>('POST', '/vault/setup', { passphrase }),
  vaultUnlock: (passphrase: string) => request<SetupState>('POST', '/vault/unlock', { passphrase }),
  vaultLock: () => request<SetupState>('POST', '/vault/lock'),
  getSettings: () => request<Settings>('GET', '/settings'),
  /** Only the keys sent change. */
  putSettings: (settings: Partial<Settings>) => request<Settings>('PUT', '/settings', settings),
  getPresets: () => request<Preset[]>('GET', '/presets'),
  createPreset: (body: { name: string; description?: string; config: VideoConfig }) =>
    request<Preset>('POST', '/presets', body),
  updatePreset: (id: string, body: { name?: string; description?: string; config?: VideoConfig }) =>
    request<Preset>('PUT', `/presets/${seg(id)}`, body),
  deletePreset: (id: string) => request<void>('DELETE', `/presets/${seg(id)}`),
  validateConfig: (config: unknown) =>
    request<ValidateConfigResponse>('POST', '/config/validate', { config }),
  getCatalog: () => request<CatalogResponse>('GET', '/catalog'),
  estimate: (body: EstimateBody) => request<EstimateResponse>('POST', '/estimate', body),
  upload: (kind: UploadKind, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<UploadResponse>('POST', `/uploads?kind=${kind}`, form);
  },
  createJob: (body: CreateJobBody) => request<JobAccepted>('POST', '/jobs', body),
  listJobs: () => request<JobSummary[]>('GET', '/jobs'),
  getJob: (id: string) => request<JobDetail>('GET', `/jobs/${seg(id)}`),
  renderJob: (id: string, config: VideoConfig) =>
    request<JobAccepted>('POST', `/jobs/${seg(id)}/render`, { config }),
  /** Render time of a style for this job's actual plan. */
  estimateJobRender: (id: string, config: VideoConfig) =>
    request<JobRenderEstimateResponse>('POST', `/jobs/${seg(id)}/estimate`, { config }),
  cancelJob: (id: string) => request<JobAccepted>('POST', `/jobs/${seg(id)}/cancel`),
  deleteJob: (id: string) => request<void>('DELETE', `/jobs/${seg(id)}`),
  getFont: (family: string) => request<FontInfo>('GET', `/fonts/${seg(family)}`),
  calibrate: () => request<CalibrateResponse>('POST', '/calibrate'),
  getRenderStats: () => request<RenderStats>('GET', '/render-stats'),
};

/** Live job updates over server-sent events; null when the browser has no EventSource. */
export const connectJobEvents = (
  id: string,
  onEvent: (event: JobEvent) => void,
  onError?: () => void,
): (() => void) | null => {
  if (typeof EventSource === 'undefined') return null;
  const source = new EventSource(`/api/jobs/${seg(id)}/events`);
  source.onmessage = (message: MessageEvent) => {
    try {
      onEvent(JSON.parse(String(message.data)) as JobEvent);
    } catch {
      // Ignore frames that are not JSON (keep-alives).
    }
  };
  source.onerror = () => onError?.();
  return () => source.close();
};

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
