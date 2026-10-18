/*
 * The five AI roles and their adapter interfaces. The pipeline only ever talks to these; every
 * vendor lives in @vc/providers as one file implementing one or more of them.
 */

export const ROLES = ['text', 'search', 'voice', 'align', 'vision'] as const;
export type Role = (typeof ROLES)[number];

/** What a single provider call consumed. Adapters fill what the API reports. */
export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  /** Characters sent to a TTS engine. */
  characters?: number;
  /** Searches performed (model search-tool calls, or plain search API requests). */
  searches?: number;
  /** Seconds of audio transcribed, or produced by a TTS engine priced per minute. */
  audioSeconds?: number;
  /** Images sent to a vision model. */
  images?: number;
};

/** USD prices per unit for one provider/model. Unset = that unit is free (local) or not used. */
export type UnitPrices = {
  inputPerMTok?: number;
  outputPerMTok?: number;
  perSearch?: number;
  perMChars?: number;
  perAudioMinute?: number;
  perImage?: number;
  /** Where the number comes from and when it was checked, shown in Settings. */
  source?: string;
};

export type ProviderCallResult<T> = {
  value: T;
  usage: Usage;
  /** The model that actually answered (as reported by the API when it says). */
  model: string;
};

export type CallOptions = { signal?: AbortSignal };

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type TextRequest = {
  system?: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
  /** Ask for a single JSON object; adapters use the provider's JSON mode where it exists. */
  json?: boolean;
};

export interface TextProvider {
  readonly providerId: string;
  readonly model: string;
  complete(request: TextRequest, options?: CallOptions): Promise<ProviderCallResult<string>>;
}

export type SearchResult = { url: string; title: string; snippet?: string };

export interface SearchProvider {
  readonly providerId: string;
  /** null for plain search APIs (Brave, SerpAPI) that involve no model. */
  readonly model: string | null;
  /** True when a model performs the search (OpenAI web_search, Claude web_search, Gemini grounding): counts as AI. */
  readonly usesModel: boolean;
  search(
    request: { query: string; maxResults: number },
    options?: CallOptions,
  ): Promise<ProviderCallResult<SearchResult[]>>;
}

/** Character-level timings as ElevenLabs returns them with the audio. */
export type CharacterAlignment = {
  characters: string[];
  startTimesSeconds: number[];
  endTimesSeconds: number[];
};

export type SynthesizedSpeech = {
  audio: Uint8Array;
  format: 'mp3' | 'wav';
  /** Present only when the engine returns timings in the same call. */
  alignment: CharacterAlignment | null;
};

export interface VoiceProvider {
  readonly providerId: string;
  readonly model: string;
  readonly voiceId: string;
  /** True when synthesize() returns character timings (ElevenLabs). */
  readonly returnsTimings: boolean;
  synthesize(
    request: { text: string },
    options?: CallOptions,
  ): Promise<ProviderCallResult<SynthesizedSpeech>>;
}

export type TimedWord = {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number | null;
};

export interface AlignProvider {
  readonly providerId: string;
  readonly model: string;
  /** Word-level timestamps for a local audio file (wav/mp3). */
  align(
    request: { audioPath: string; language?: string; prompt?: string },
    options?: CallOptions,
  ): Promise<ProviderCallResult<TimedWord[]>>;
}

export type VisionImage = { data: Uint8Array; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' };

export interface VisionProvider {
  readonly providerId: string;
  readonly model: string;
  describe(
    request: { prompt: string; images: VisionImage[]; maxOutputTokens: number; json?: boolean },
    options?: CallOptions,
  ): Promise<ProviderCallResult<string>>;
}

/** The configured providers for a job. null = role switched off / not configured. */
export type ProviderSet = {
  text: TextProvider;
  search: SearchProvider | null;
  voice: VoiceProvider | null;
  align: AlignProvider | null;
  vision: VisionProvider | null;
};

export type ProviderErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'bad_request'
  | 'not_found'
  | 'server'
  | 'network'
  | 'timeout'
  | 'unsupported'
  | 'invalid_response'
  | 'key_host_mismatch';

/** Errors adapters throw. Messages must never contain a key (the HTTP layer scrubs them). */
export class ProviderError extends Error {
  readonly providerId: string;
  readonly code: ProviderErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(init: {
    providerId: string;
    code: ProviderErrorCode;
    message: string;
    status?: number | null;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ProviderError';
    this.providerId = init.providerId;
    this.code = init.code;
    this.status = init.status ?? null;
    this.retryable =
      init.retryable ??
      (init.code === 'rate_limit' ||
        init.code === 'server' ||
        init.code === 'network' ||
        init.code === 'timeout');
  }
}
