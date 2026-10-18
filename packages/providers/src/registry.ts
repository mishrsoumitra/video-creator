import { ProviderError, ROLES, type Role } from '@vc/pipeline';
import { z } from 'zod';
import { anthropicProvider } from './anthropic';
import { azureTtsProvider } from './azure-tts';
import { braveProvider } from './brave';
import { elevenlabsProvider } from './elevenlabs';
import { googleProvider } from './google';
import { googleTtsProvider } from './google-tts';
import { guardedFetch } from './guard';
import { kokoroProvider } from './kokoro';
import { openaiProvider } from './openai';
import { openaiCompatibleProvider } from './openai-compatible';
import { serpapiProvider } from './serpapi';
import type {
  AdapterLogger,
  CredentialSpec,
  MediaHelpers,
  ProviderDefinition,
  RoleAdapter,
  RoleInstanceMap,
} from './types';
import { whisperCppProvider } from './whisper-cpp';

/** Every provider. Adding one = its file plus one line here. */
export const PROVIDERS: readonly ProviderDefinition[] = Object.freeze([
  openaiProvider,
  anthropicProvider,
  googleProvider,
  elevenlabsProvider,
  googleTtsProvider,
  azureTtsProvider,
  openaiCompatibleProvider,
  braveProvider,
  serpapiProvider,
  kokoroProvider,
  whisperCppProvider,
]);

export const getProvider = (id: string): ProviderDefinition | undefined =>
  PROVIDERS.find((p) => p.id === id);

export const providersForRole = (role: Role): ProviderDefinition[] =>
  PROVIDERS.filter((p) => p.roles[role] !== undefined);

/** The credential a provider needs: null = none (local), undefined = unknown provider. */
export const credentialFor = (providerId: string): CredentialSpec | null | undefined => {
  const provider = getProvider(providerId);
  return provider === undefined ? undefined : provider.credential;
};

const adapterFor = <R extends Role>(
  provider: ProviderDefinition,
  role: R,
): RoleAdapter<R> | undefined => provider.roles[role] as RoleAdapter<R> | undefined;

export type CatalogProvider = {
  id: string;
  label: string;
  kind: 'cloud' | 'local';
  description: string;
  adapterLabel: string;
  credential: { id: string; label: string; helpUrl: string; optional: boolean } | null;
  defaultModel: string;
  suggestedModels: string[];
  /** JSON Schema of the role's options, for the setup form. */
  options: Record<string, unknown>;
};
export type CatalogEntry = { role: Role; providers: CatalogProvider[] };

/** What the setup screen shows: per role, the providers that can fill it. JSON-serialisable. */
export const catalog = (): CatalogEntry[] =>
  ROLES.map((role) => ({
    role,
    providers: providersForRole(role).map((provider) => {
      const adapter = adapterFor(provider, role)!;
      return {
        id: provider.id,
        label: provider.label,
        kind: provider.kind,
        description: provider.description,
        adapterLabel: adapter.label,
        credential: provider.credential
          ? {
              id: provider.credential.id,
              label: provider.credential.label,
              helpUrl: provider.credential.helpUrl,
              optional: provider.credential.optional ?? false,
            }
          : null,
        defaultModel: adapter.defaultModel,
        suggestedModels: [...adapter.suggestedModels],
        options: z.toJSONSchema(adapter.optionsSchema, {
          io: 'input',
          unrepresentable: 'any',
        }) as Record<string, unknown>,
      };
    }),
  }));

export type CreateRoleProviderInput<R extends Role> = {
  providerId: string;
  role: R;
  model?: string;
  options?: Record<string, unknown>;
  apiKey: string | null;
  dataDir: string;
  fetch?: typeof fetch;
  media?: MediaHelpers;
  logger?: AdapterLogger;
};

/**
 * Builds a ready role instance: validates options and model, requires a key unless the provider
 * needs none, and wraps fetch so the key can only travel to the provider's own hosts.
 */
export const createRoleProvider = <R extends Role>(
  input: CreateRoleProviderInput<R>,
): RoleInstanceMap[R] => {
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`Unknown provider "${input.providerId}".`);
  const adapter = adapterFor(provider, input.role);
  if (!adapter) {
    throw new ProviderError({
      providerId: provider.id,
      code: 'unsupported',
      message: `${provider.label} cannot fill the ${input.role} role.`,
    });
  }
  const parsed = adapter.optionsSchema.safeParse(input.options ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'options'}: ${i.message}`)
      .join('; ');
    throw new ProviderError({
      providerId: provider.id,
      code: 'bad_request',
      message: `Invalid ${provider.label} ${input.role} settings: ${detail}`,
    });
  }
  const model = input.model?.trim() || adapter.defaultModel;
  const modelError = adapter.validateModel?.(model) ?? null;
  if (modelError)
    throw new ProviderError({ providerId: provider.id, code: 'bad_request', message: modelError });
  if (provider.credential && !provider.credential.optional && !input.apiKey) {
    throw new ProviderError({
      providerId: provider.id,
      code: 'auth',
      message: `${provider.credential.label} is required.`,
    });
  }
  const fetch = guardedFetch(input.fetch ?? globalThis.fetch, {
    providerId: provider.id,
    apiKey: input.apiKey,
    allowedHosts: provider.allowedHosts(parsed.data),
    allowHttpLocalhost: provider.kind === 'local',
  });
  return adapter.create({
    apiKey: input.apiKey,
    model,
    options: parsed.data,
    fetch,
    dataDir: input.dataDir,
    ...(input.media ? { media: input.media } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });
};
