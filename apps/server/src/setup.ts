import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPTIONAL_ROLES,
  ROLE_IDS,
  type PutRoleSchema,
  type RoleId,
  type RoleSlot,
  type RoleTestResult,
  type SetupState,
} from '@vc/config';
import type { PriceLookup, ProviderSet } from '@vc/pipeline';
import type { RoleInstanceMap } from '@vc/providers';
import { maskSecret } from '@vc/secrets';
import type { z } from 'zod';
import type { Db } from './db';
import { HttpError, badRequest, notFound } from './http-error';
import { solidPng } from './png';
import type { ServerDeps } from './services';

const TEST_TIMEOUT_MS = 60_000;

const untested = (): RoleSlot['test'] => ({
  status: 'untested',
  at: null,
  model: null,
  detail: null,
  durationMs: null,
});

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer within ${ms / 1000} s.`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

/** API keys in the vault, their masked form in the database, and every key registered with the log scrubber. */
export class Credentials {
  constructor(private readonly deps: Pick<ServerDeps, 'db' | 'vault' | 'scrubber' | 'registry'>) {}

  spec(id: string) {
    return this.deps.registry.list().find((p) => p.credential?.id === id)?.credential ?? null;
  }

  async loadIntoScrubber(): Promise<void> {
    if (this.deps.vault.isLocked()) return;
    for (const { id } of this.deps.db.credentials.all()) {
      const key = await this.deps.vault.get(id);
      if (key) this.deps.scrubber.add(key);
    }
  }

  async set(id: string, apiKey: string): Promise<{ id: string; masked: string }> {
    const spec = this.spec(id);
    if (!spec) throw notFound(`Credential "${id}"`);
    await this.deps.vault.set(id, apiKey);
    this.deps.scrubber.add(apiKey);
    const masked = maskSecret(apiKey);
    this.deps.db.credentials.put({ id, label: spec.label, masked });
    this.resetRolesUsing(id);
    return { id, masked };
  }

  async remove(id: string): Promise<void> {
    if (!this.deps.db.credentials.has(id)) throw notFound(`Credential "${id}"`);
    const key = await this.deps.vault.get(id);
    await this.deps.vault.delete(id);
    if (key) this.deps.scrubber.remove(key);
    this.deps.db.credentials.delete(id);
    this.resetRolesUsing(id);
  }

  async key(id: string): Promise<string | null> {
    return this.deps.vault.get(id);
  }

  private resetRolesUsing(id: string): void {
    for (const slot of this.deps.db.roles.all()) {
      if (
        slot.mode === 'provider' &&
        slot.providerId &&
        this.deps.registry.get(slot.providerId)?.credential?.id === id
      ) {
        this.deps.db.roles.put({ ...slot, test: untested() });
      }
    }
  }
}

/**
 * The five AI roles: which provider fills each, whether its test call passed, and whether setup is
 * complete. No video job starts until it is.
 */
export class SetupService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly credentials: Credentials,
  ) {}

  private get db(): Db {
    return this.deps.db;
  }

  private modelsDir() {
    return join(this.deps.dataDir, 'models');
  }

  private async keyFor(providerId: string): Promise<string | null> {
    const credential = this.deps.registry.get(providerId)?.credential;
    if (!credential) return null;
    return this.deps.vault.isLocked() ? null : this.credentials.key(credential.id);
  }

  private async instance<R extends RoleId>(
    slot: RoleSlot & { role: R },
  ): Promise<RoleInstanceMap[R]> {
    const providerId = slot.providerId!;
    await mkdir(this.modelsDir(), { recursive: true });
    return this.deps.registry.create({
      providerId,
      role: slot.role,
      model: slot.model ?? undefined,
      options: slot.options,
      apiKey: await this.keyFor(providerId),
      dataDir: this.modelsDir(),
      media: this.deps.media.helpers,
    }) as RoleInstanceMap[R];
  }

  /** Whether the configured voice returns word timings in the same call (ElevenLabs does). */
  private async voiceReturnsTimings(voice: RoleSlot): Promise<boolean> {
    if (voice.mode !== 'provider' || !voice.providerId) return false;
    try {
      const credential = this.deps.registry.get(voice.providerId)?.credential;
      // Whether a voice returns timings never depends on its key, so a locked vault must not matter.
      const stored = await this.keyFor(voice.providerId).catch(() => null);
      const key = stored ?? (credential && !credential.optional ? 'not-yet-stored' : null);
      const instance = this.deps.registry.create({
        providerId: voice.providerId,
        role: 'voice',
        model: voice.model ?? undefined,
        options: voice.options,
        apiKey: key,
        dataDir: this.modelsDir(),
        media: this.deps.media.helpers,
      });
      return instance.returnsTimings;
    } catch {
      return false;
    }
  }

  private async missing(slots: Record<RoleId, RoleSlot>): Promise<SetupState['missing']> {
    const out: SetupState['missing'] = [];
    for (const role of ROLE_IDS) {
      const slot = slots[role];
      if (slot.mode === 'off') {
        if (role === 'align') {
          const voice = slots.voice;
          if (voice.mode === 'off')
            out.push({ role, reason: 'Uploaded recordings need a word-timing provider.' });
          else if (!(await this.voiceReturnsTimings(voice)))
            out.push({
              role,
              reason: 'This voice returns no word timings: choose a word-timing provider.',
            });
        }
        continue;
      }
      if (!slot.providerId) {
        out.push({
          role,
          reason: OPTIONAL_ROLES.includes(role)
            ? 'Choose a provider, or switch this role off.'
            : 'Choose a provider.',
        });
        continue;
      }
      const credential = this.deps.registry.get(slot.providerId)?.credential;
      if (credential && !credential.optional && !this.db.credentials.has(credential.id)) {
        out.push({ role, reason: `Add your ${credential.label}.` });
        continue;
      }
      if (slot.test.status !== 'passed')
        out.push({
          role,
          reason: slot.test.status === 'failed' ? 'The test call failed.' : 'Run the test call.',
        });
    }
    return out;
  }

  async state(): Promise<SetupState> {
    const list = this.db.roles.all();
    const slots = Object.fromEntries(list.map((s) => [s.role, s])) as Record<RoleId, RoleSlot>;
    const missing = await this.missing(slots);
    const vault = {
      backend: this.deps.vault.backend,
      locked: this.deps.vault.isLocked(),
      needsSetup: await this.deps.vault.needsSetup(),
    };
    return {
      complete: missing.length === 0 && !vault.locked,
      missing,
      roles: slots,
      credentials: this.db.credentials.all(),
      vault,
    };
  }

  async putRole(role: RoleId, body: z.output<typeof PutRoleSchema>): Promise<SetupState> {
    const previous = this.db.roles.get(role);
    if (body.mode === 'off') {
      if (!OPTIONAL_ROLES.includes(role))
        throw badRequest(`The ${role} role cannot be switched off.`);
      if (role === 'align') {
        const voice = this.db.roles.get('voice');
        if (voice.mode === 'off')
          throw badRequest('Uploaded recordings need a word-timing provider.');
        if (!(await this.voiceReturnsTimings(voice)))
          throw badRequest(
            'Word timings are needed because this voice returns none. Choose a word-timing provider.',
          );
      }
      this.db.roles.put({
        role,
        mode: 'off',
        providerId: null,
        model: null,
        options: {},
        test: untested(),
      });
      return this.state();
    }
    if (!body.providerId) throw badRequest('Choose a provider.');
    const provider = this.deps.registry.get(body.providerId);
    if (!provider) throw badRequest(`Unknown provider "${body.providerId}".`);
    const adapter = provider.roles[role];
    if (!adapter) throw badRequest(`${provider.label} cannot fill the ${role} role.`);
    const options = adapter.optionsSchema.safeParse(body.options ?? {});
    if (!options.success)
      throw badRequest(
        `Invalid ${provider.label} settings: ${options.error.issues.map((i) => i.message).join('; ')}`,
      );
    const model = body.model ?? adapter.defaultModel;
    const modelError = adapter.validateModel?.(model) ?? null;
    if (modelError) throw badRequest(modelError);
    const next: RoleSlot = {
      role,
      mode: 'provider',
      providerId: provider.id,
      model,
      options: options.data,
      test: untested(),
    };
    const unchanged =
      previous.mode === 'provider' &&
      previous.providerId === next.providerId &&
      previous.model === next.model &&
      JSON.stringify(previous.options) === JSON.stringify(next.options);
    this.db.roles.put(unchanged ? previous : next);
    return this.state();
  }

  /** One tiny call that proves the key works and shows the model it reached. */
  async testRole(role: RoleId): Promise<RoleTestResult> {
    const slot = this.db.roles.get(role);
    if (slot.mode === 'off' || !slot.providerId)
      throw new HttpError(409, 'role_off', `The ${role} role has no provider to test.`);
    const provider = this.deps.registry.get(slot.providerId);
    const started = Date.now();
    const finish = (ok: boolean, detail: string, model: string | null): RoleTestResult => {
      const durationMs = Date.now() - started;
      const clean = this.deps.scrubber.scrub(detail);
      this.db.roles.put({
        ...slot,
        test: {
          status: ok ? 'passed' : 'failed',
          at: this.deps.now().toISOString(),
          model,
          detail: clean,
          durationMs,
        },
      });
      return { ok, model, detail: clean, durationMs };
    };
    if (
      provider?.credential &&
      !provider.credential.optional &&
      !this.db.credentials.has(provider.credential.id)
    ) {
      return finish(false, `Add your ${provider.credential.label} first.`, null);
    }
    if (this.deps.vault.isLocked()) return finish(false, 'Unlock the key vault first.', null);
    try {
      const result = await withTimeout(this.runTest(slot), TEST_TIMEOUT_MS);
      return finish(true, result.detail, result.model);
    } catch (error) {
      return finish(false, error instanceof Error ? error.message : String(error), null);
    }
  }

  private async runTest(slot: RoleSlot): Promise<{ detail: string; model: string }> {
    switch (slot.role) {
      case 'text': {
        const p = await this.instance({ ...slot, role: 'text' });
        const r = await p.complete({
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
          maxOutputTokens: 16,
          temperature: 0,
        });
        return { detail: `Replied “${r.value.trim().slice(0, 40)}”.`, model: r.model };
      }
      case 'search': {
        const p = await this.instance({ ...slot, role: 'search' });
        const r = await p.search({ query: 'Apollo 11 Moon landing', maxResults: 3 });
        return {
          detail: `Found ${r.value.length} result(s)${p.usesModel ? ' through the model' : ''}.`,
          model: r.model,
        };
      }
      case 'voice': {
        const p = await this.instance({ ...slot, role: 'voice' });
        const r = await p.synthesize({ text: 'Test.' });
        return {
          detail: `${r.value.audio.length} bytes of ${r.value.format} audio${r.value.alignment ? ', with word timings' : ''}.`,
          model: r.model,
        };
      }
      case 'align': {
        const p = await this.instance({ ...slot, role: 'align' });
        const dir = await mkdtemp(join(tmpdir(), 'vc-align-test-'));
        try {
          const audioPath = join(dir, 'silence.wav');
          await this.deps.media.silentWav(audioPath, 1000);
          const r = await p.align({ audioPath, language: 'en' });
          return {
            detail: `Transcribed a one-second test clip (${r.value.length} word(s)).`,
            model: r.model,
          };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      case 'vision': {
        const p = await this.instance({ ...slot, role: 'vision' });
        const r = await p.describe({
          prompt: 'What colour is this image? Answer with one word.',
          images: [{ data: solidPng(16, 16, [220, 30, 30]), mimeType: 'image/png' }],
          maxOutputTokens: 10,
        });
        return { detail: `Replied “${r.value.trim().slice(0, 40)}”.`, model: r.model };
      }
    }
  }

  /** Live provider instances for a job. Only call when setup is complete. */
  async providerSet(): Promise<ProviderSet> {
    const slot = (role: RoleId) => this.db.roles.get(role);
    const make = async <R extends RoleId>(role: R): Promise<RoleInstanceMap[R] | null> => {
      const s = slot(role);
      return s.mode === 'provider' && s.providerId ? this.instance({ ...s, role }) : null;
    };
    const text = await make('text');
    if (!text) throw new HttpError(409, 'setup_incomplete', 'No text provider is set up.');
    return {
      text,
      search: await make('search'),
      voice: await make('voice'),
      align: await make('align'),
      vision: await make('vision'),
    };
  }

  /** What the cost estimate needs to know about each role. */
  async estimateProviders() {
    const out: {
      text: { providerId: string; model: string };
      search: { providerId: string; model: string | null; usesModel: boolean } | null;
      voice: { providerId: string; model: string; returnsTimings: boolean } | null;
      align: { providerId: string; model: string } | null;
      vision: { providerId: string; model: string } | null;
    } = {
      text: { providerId: 'none', model: 'none' },
      search: null,
      voice: null,
      align: null,
      vision: null,
    };
    const slots = this.db.roles.all();
    for (const s of slots) {
      if (s.mode !== 'provider' || !s.providerId) continue;
      const adapter = this.deps.registry.get(s.providerId)?.roles[s.role];
      const model = s.model ?? adapter?.defaultModel ?? 'unknown';
      if (s.role === 'text') out.text = { providerId: s.providerId, model };
      if (s.role === 'align') out.align = { providerId: s.providerId, model };
      if (s.role === 'vision') out.vision = { providerId: s.providerId, model };
      if (s.role === 'voice')
        out.voice = {
          providerId: s.providerId,
          model,
          returnsTimings: await this.voiceReturnsTimings(s),
        };
      if (s.role === 'search') {
        let usesModel = true;
        try {
          usesModel = (await this.instance({ ...s, role: 'search' })).usesModel;
        } catch {
          // keep the conservative assumption
        }
        out.search = { providerId: s.providerId, model, usesModel };
      }
    }
    return out;
  }
}

/** Provider prices, with per-model overrides from Settings taking precedence. */
export const priceLookupFor =
  (
    registry: ServerDeps['registry'],
    overrides: Record<string, Record<string, unknown>>,
  ): PriceLookup =>
  (providerId, model, role) => {
    const override = overrides[`${providerId}/${model}`];
    if (override) return override;
    const adapter = registry.get(providerId)?.roles[role];
    return adapter ? adapter.pricing(model) : null;
  };
