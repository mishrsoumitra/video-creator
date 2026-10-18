export type {
  AdapterContext,
  AdapterLogger,
  CredentialSpec,
  MediaHelpers,
  ProviderDefinition,
  RoleAdapter,
  RoleInstanceMap,
} from './types';
export {
  PROVIDERS,
  catalog,
  createRoleProvider,
  credentialFor,
  getProvider,
  providersForRole,
  type CatalogEntry,
  type CatalogProvider,
  type CreateRoleProviderInput,
} from './registry';
export { anthropicProvider } from './anthropic';
export { azureTtsProvider } from './azure-tts';
export { braveProvider } from './brave';
export { elevenlabsProvider } from './elevenlabs';
export { googleProvider } from './google';
export { googleTtsProvider } from './google-tts';
export { kokoroProvider, makeKokoroProvider, type KokoroDeps } from './kokoro';
export { openaiProvider } from './openai';
export { openaiCompatibleProvider } from './openai-compatible';
export { serpapiProvider } from './serpapi';
export { makeWhisperCppProvider, whisperCppProvider, type WhisperCppDeps } from './whisper-cpp';
export { createOpenverseSource, type OpenverseOptions } from './openverse';
export {
  createPageFetcher,
  createSafeDownloader,
  htmlToReadableText,
  isBlockedAddress,
  type DnsLookup,
  type PageFetcherOptions,
  type SafeDownload,
} from './page-fetcher';
export { guardedFetch, isLoopbackHost, type GuardOptions } from './guard';
export { errorFromResponse, httpBytes, httpJson, scrub, type HttpOptions } from './http';
export { splitTextForSpeech } from './text-chunks';
export {
  concatPcm,
  decodeWav,
  durationSeconds,
  encodeWav,
  floatToPcm16,
  pcm16FromBytes,
  type Pcm16,
} from './wav';
