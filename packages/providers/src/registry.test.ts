import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError, ROLES } from '@vc/pipeline';
import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  catalog,
  createRoleProvider,
  credentialFor,
  getProvider,
  providersForRole,
} from './registry';
import { createFakeFetch, jsonResponse } from './testing/fake-fetch';

const SAMPLE_OPTIONS: Record<string, Record<string, unknown>> = {
  'azure-tts': { region: 'eastus' },
};

describe('provider registry', () => {
  it('has unique provider ids', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every role, with at least one way to fill text, search, voice and align', () => {
    for (const role of ROLES) expect(providersForRole(role).length, role).toBeGreaterThan(0);
    expect(providersForRole('text').map((p) => p.id)).toEqual(
      expect.arrayContaining(['openai', 'anthropic', 'google', 'openai-compatible']),
    );
    expect(providersForRole('search').map((p) => p.id)).toEqual(
      expect.arrayContaining(['openai', 'anthropic', 'google', 'brave', 'serpapi']),
    );
    expect(providersForRole('voice').map((p) => p.id)).toEqual(
      expect.arrayContaining(['elevenlabs', 'openai', 'google-tts', 'azure-tts', 'kokoro']),
    );
    expect(providersForRole('align').map((p) => p.id)).toEqual(
      expect.arrayContaining(['openai', 'whisper-cpp']),
    );
    expect(providersForRole('vision').map((p) => p.id)).toEqual(
      expect.arrayContaining(['openai', 'anthropic', 'google', 'openai-compatible']),
    );
  });

  for (const provider of PROVIDERS) {
    for (const role of ROLES) {
      const adapter = provider.roles[role];
      if (!adapter) continue;
      it(`${provider.id}/${role}: default model passes its own validation and has defaults for every option`, () => {
        expect(adapter.validateModel?.(adapter.defaultModel) ?? null).toBeNull();
        expect(adapter.suggestedModels).toContain(adapter.defaultModel);
        expect(() => adapter.optionsSchema.parse(SAMPLE_OPTIONS[provider.id] ?? {})).not.toThrow();
        expect(adapter.label.length).toBeGreaterThan(3);
      });
      it(`${provider.id}/${role}: ${provider.kind === 'cloud' ? 'publishes a price' : 'is free'} for the default model`, () => {
        const price = adapter.pricing(adapter.defaultModel);
        expect(price).not.toBeNull();
        expect(price!.source?.length ?? 0).toBeGreaterThan(5);
        if (provider.kind === 'local')
          expect(Object.keys(price!).filter((k) => k !== 'source')).toEqual([]);
      });
    }
  }

  it('gives cloud providers https-only hostnames to send keys to', () => {
    for (const provider of PROVIDERS.filter((p) => p.kind === 'cloud')) {
      const hosts = provider.allowedHosts(SAMPLE_OPTIONS[provider.id] ?? {});
      expect(hosts.length, provider.id).toBeGreaterThan(0);
      for (const host of hosts) {
        expect(host, provider.id).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
        expect(new URL(`https://${host}`).hostname).toBe(host);
      }
      expect(provider.credential, provider.id).not.toBeNull();
    }
  });

  it('lets one key fill several roles', () => {
    expect(credentialFor('openai')?.id).toBe('openai');
    expect(Object.keys(getProvider('openai')!.roles).sort()).toEqual([
      'align',
      'search',
      'text',
      'vision',
      'voice',
    ]);
    expect(credentialFor('kokoro')).toBeNull();
    expect(credentialFor('nope')).toBeUndefined();
  });

  it('exposes a serialisable catalog for the setup screen', () => {
    const entries = catalog();
    expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
    const text = entries.find((e) => e.role === 'text')!;
    expect(text.providers.find((p) => p.id === 'anthropic')).toMatchObject({
      kind: 'cloud',
      defaultModel: 'claude-opus-5-5',
      credential: { id: 'anthropic' },
    });
    expect(text.providers.find((p) => p.id === 'openai-compatible')!.credential).toMatchObject({
      optional: true,
    });
  });
});

describe('createRoleProvider', () => {
  const base = { dataDir: tmpdir(), fetch: createFakeFetch(() => jsonResponse({})).fetch };

  it('requires a key unless the credential is optional or absent', () => {
    expect(() =>
      createRoleProvider({ ...base, providerId: 'openai', role: 'text', apiKey: null }),
    ).toThrow(ProviderError);
    expect(() =>
      createRoleProvider({ ...base, providerId: 'openai-compatible', role: 'text', apiKey: null }),
    ).not.toThrow();
    expect(() =>
      createRoleProvider({ ...base, providerId: 'kokoro', role: 'voice', apiKey: null }),
    ).not.toThrow();
  });

  it('refuses a role the provider cannot fill', () => {
    expect(() =>
      createRoleProvider({ ...base, providerId: 'brave', role: 'text', apiKey: 'k' }),
    ).toThrow(/cannot fill/);
  });

  it('refuses unknown providers', () => {
    expect(() =>
      createRoleProvider({ ...base, providerId: 'nope', role: 'text', apiKey: 'k' }),
    ).toThrow(/Unknown provider/);
  });

  it('validates options and models up front', () => {
    expect(() =>
      createRoleProvider({
        ...base,
        providerId: 'openai',
        role: 'voice',
        apiKey: 'sk-x',
        options: { voice: 'robot' },
      }),
    ).toThrow(ProviderError);
    expect(() =>
      createRoleProvider({
        ...base,
        providerId: 'openai',
        role: 'align',
        apiKey: 'sk-x',
        model: 'gpt-4o-transcribe',
      }),
    ).toThrow(/whisper-1/);
  });

  it('uses the default model when none is given and trims a given one', () => {
    expect(
      createRoleProvider({ ...base, providerId: 'anthropic', role: 'text', apiKey: 'sk-ant-x' })
        .model,
    ).toBe('claude-opus-5-5');
    expect(
      createRoleProvider({
        ...base,
        providerId: 'anthropic',
        role: 'text',
        apiKey: 'sk-ant-x',
        model: '  claude-sonnet-5-5 ',
      }).model,
    ).toBe('claude-sonnet-5-5');
  });

  it('wraps fetch with the key guard', async () => {
    const fake = createFakeFetch(() => jsonResponse({}));
    const provider = createRoleProvider({
      dataDir: tmpdir(),
      fetch: fake.fetch,
      providerId: 'openai-compatible',
      role: 'text',
      apiKey: 'secret-key-0123456789',
      options: { baseUrl: 'http://192.168.1.5:11434/v1' },
    });
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 5 }),
    ).rejects.toMatchObject({ code: 'key_host_mismatch' });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('architecture', () => {
  it('no provider file imports the server, the web app, or the composition', async () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const source = await readFile(join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/from ['"]@vc\/(server|web|composition)/);
      expect(source, file).not.toMatch(/from ['"]@vc\/media['"]/);
    }
  });
});
