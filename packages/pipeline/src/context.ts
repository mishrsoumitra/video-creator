import type { CacheStore } from './cache';
import type { AiLedger, Stage } from './ledger';

/** Files belonging to one job, plus the shared cache folder. Paths returned are absolute. */
export interface JobFiles {
  /** Absolute path for a file in the job folder (not created). */
  pathFor(name: string): string;
  write(name: string, data: Uint8Array | string): Promise<string>;
  read(path: string): Promise<Uint8Array>;
  /** Copies an existing file (a cache entry or an upload) into the job folder. */
  copyIn(sourcePath: string, name: string): Promise<string>;
  /** Writes a file into the persistent cache shared by all jobs. */
  writeCache(name: string, data: Uint8Array): Promise<string>;
  exists(path: string): Promise<boolean>;
}

/** ffmpeg-backed helpers, injected (implemented with @vc/media). */
export interface MediaOps {
  durationMs(path: string): Promise<number>;
  /** Decodes any input to 48 kHz wav. */
  toWav(input: string, output: string): Promise<void>;
  /** Joins audio files end to end into one wav. */
  concatAudio(inputs: readonly string[], output: string): Promise<void>;
  /** 16 kHz mono wav: what speech recognisers want, and small enough for upload limits. */
  toSpeechWav(input: string, output: string): Promise<void>;
}

export type StageEvent = { stage: Stage; message: string; data?: Record<string, unknown> };

export type StageStatus = 'running' | 'done' | 'skipped' | 'failed';

export type StageContext = {
  jobId: string;
  ledger: AiLedger;
  cache: CacheStore;
  files: JobFiles;
  signal?: AbortSignal;
  log: (event: StageEvent) => void;
  /** Progress for the job page. */
  onStage?: (stage: Stage, status: StageStatus, detail?: string) => void;
  now: () => Date;
};

/** A failure the user can act on; shown on the job page as is. */
export class PipelineError extends Error {
  readonly stage: Stage;
  constructor(stage: Stage, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PipelineError';
    this.stage = stage;
  }
}

export const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error('The job was cancelled.');
};
