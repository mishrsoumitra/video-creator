import type { FontInfo, MusicTrack, ScenePlan, VideoConfig } from '@vc/config';
import type {
  CaptionOverflow,
  ClippingReport,
  ImageOps,
  ImageSource,
  MediaOps,
  PageFetcher,
  Role,
  VisionImage,
} from '@vc/pipeline';
import type { MediaHelpers, ProviderDefinition, RoleInstanceMap } from '@vc/providers';
import type { SecretScrubber, SecretVault } from '@vc/secrets';
import type { Db } from './db';

/** The provider registry, injectable so tests can register fakes. */
export interface ProviderRegistry {
  list(): ProviderDefinition[];
  get(id: string): ProviderDefinition | undefined;
  create<R extends Role>(input: {
    providerId: string;
    role: R;
    model?: string;
    options?: Record<string, unknown>;
    apiKey: string | null;
    dataDir: string;
    media?: MediaHelpers;
  }): RoleInstanceMap[R];
}

export interface Renderer {
  render(args: {
    plan: ScenePlan;
    config: VideoConfig;
    outputPath: string;
    signal?: AbortSignal;
    onProgress?: (progress: number) => void;
  }): Promise<{ elapsedMs: number; captionOverflows: CaptionOverflow[] }>;
}

/** Renders short calibration clips (benchmark) and reports how long they took. */
export interface Calibrator {
  run(
    onSample: (
      config: VideoConfig,
      durationMs: number,
      sceneCount: number,
      elapsedMs: number,
    ) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ServerMedia {
  probeDurationMs(path: string): Promise<number>;
  /** Throws a user-facing Error when the file is not decodable audio. */
  assertAudio(path: string): Promise<{ durationMs: number }>;
  mixAudio(args: {
    narrationPath: string;
    musicPath: string | null;
    audio: VideoConfig['audio'];
    outputPath: string;
  }): Promise<{ integratedLufs: number; truePeakDb: number }>;
  mux(args: {
    videoPath: string;
    audioPath: string;
    outputPath: string;
    container: 'mp4' | 'webm' | 'mov';
  }): Promise<void>;
  measureClipping(path: string): Promise<ClippingReport>;
  contactSheet(videoPath: string, outputPath: string): Promise<VisionImage>;
  pipeline: MediaOps;
  /** Image download, thumbnails and deterministic analysis for one job folder. */
  imageOps(jobDir: string): ImageOps;
  /** What provider adapters (whisper.cpp, Whisper uploads) need. */
  helpers: MediaHelpers;
  /** A tiny silent wav for word-timing test calls. */
  silentWav(path: string, durationMs: number): Promise<void>;
}

export interface FontCatalog {
  families(): Promise<string[]>;
  info(family: string): Promise<FontInfo | null>;
}

export interface MusicLibrary {
  readonly tracks: readonly MusicTrack[];
  /** A cached track rendered to exactly this length. */
  pathFor(trackId: string, durationMs: number): Promise<string>;
}

export type ServerDeps = {
  dataDir: string;
  db: Db;
  vault: SecretVault;
  scrubber: SecretScrubber;
  registry: ProviderRegistry;
  media: ServerMedia;
  renderer: Renderer;
  calibrator: Calibrator | null;
  imageSource: ImageSource;
  pageFetcher: PageFetcher;
  fonts: FontCatalog;
  music: MusicLibrary;
  /** Host headers accepted (DNS-rebinding protection), e.g. 127.0.0.1:4317. */
  allowedHosts: readonly string[];
  /** Origins allowed to make mutating requests (the UI's own origin, the Vite dev server). */
  allowedOrigins: readonly string[];
  /** Absolute origin of this server, used to give the renderer absolute asset URLs. */
  publicOrigin: string;
  webDistDir: string | null;
  platform: NodeJS.Platform;
  cpuCount: number;
  now: () => Date;
  newId: () => string;
  /** Concurrent preparations (AI stages). Renders always run one at a time. */
  prepareConcurrency?: number;
  logger?: { level: string; stream?: NodeJS.WritableStream } | false;
};
