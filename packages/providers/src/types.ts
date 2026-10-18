import type {
  AlignProvider,
  Role,
  SearchProvider,
  TextProvider,
  UnitPrices,
  VisionProvider,
  VoiceProvider,
} from '@vc/pipeline';
import type { z } from 'zod';

/*
 * The provider registry contract. Adding a provider = one file exporting a ProviderDefinition and
 * one line in registry.ts. The pipeline never sees these types, only the role interfaces.
 */

export type RoleInstanceMap = {
  text: TextProvider;
  search: SearchProvider;
  voice: VoiceProvider;
  align: AlignProvider;
  vision: VisionProvider;
};

export type CredentialSpec = {
  /** Vault id. One credential can fill several roles ("one key can fill several slots"). */
  id: string;
  label: string;
  helpUrl: string;
  /** Loose format hint shown when a pasted key looks wrong. Never enforced. */
  hint?: RegExp;
  /** Local servers (Ollama, LM Studio) work without a key. */
  optional?: boolean;
};

export type AdapterLogger = {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
};

/** ffmpeg-backed helpers the server injects (from @vc/media); providers never spawn ffmpeg themselves. */
export type MediaHelpers = {
  /** Converts any audio file ffmpeg can read to 16 kHz mono 16-bit PCM WAV. */
  toWav16kMono(inputPath: string, outputPath: string): Promise<void>;
  /** Duration of an audio file in milliseconds. */
  durationMs(path: string): Promise<number>;
};

export type AdapterContext = {
  apiKey: string | null;
  model: string;
  /** Validated against the role's optionsSchema. */
  options: Record<string, unknown>;
  /** A fetch that refuses to send the key to any host outside the provider's allowlist. */
  fetch: typeof fetch;
  /** Where local models and binaries live (whisper.cpp, Kokoro). */
  dataDir: string;
  media?: MediaHelpers;
  logger?: AdapterLogger;
};

export type RoleAdapter<R extends Role> = {
  role: R;
  /** e.g. "OpenAI web_search tool (Responses API)". */
  label: string;
  defaultModel: string;
  suggestedModels: readonly string[];
  optionsSchema: z.ZodType<Record<string, unknown>>;
  /** Rejects models that cannot do this job, e.g. gpt-4o-transcribe has no word timestamps. */
  validateModel?: (model: string) => string | null;
  /**
   * Published prices for a model on a date (null = unknown; local adapters return {}). Some vendors
   * announce dated price changes, hence `at`. Editable in Settings.
   */
  pricing(model: string, at?: Date): UnitPrices | null;
  create(ctx: AdapterContext): RoleInstanceMap[R];
};

export type ProviderDefinition = {
  id: string;
  label: string;
  kind: 'cloud' | 'local';
  /** One line for the setup screen. */
  description: string;
  credential: CredentialSpec | null;
  /** Hosts the key may be sent to. A function because some depend on options (Azure region, Ollama URL). */
  allowedHosts(options: Record<string, unknown>): string[];
  roles: { [R in Role]?: RoleAdapter<R> };
};
