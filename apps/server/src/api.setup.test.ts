import type { CatalogProvider, RoleTestResult, SetupState } from '@vc/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACME_KEY, LABS_KEY } from './test/fakes';
import { createTestServer, type TestServer } from './test/harness';

let s: TestServer;
beforeEach(async () => {
  s = await createTestServer();
});
afterEach(async () => {
  await s.close();
});

const setup = async () => (await s.api.get('/api/setup')).body as SetupState;

describe('AI provider setup (first run)', () => {
  it('starts incomplete, listing what is missing per role', async () => {
    const state = await setup();
    expect(state.complete).toBe(false);
    expect(state.missing.map((m) => m.role)).toEqual(['text', 'search', 'voice', 'align']);
    expect(state.roles.vision.mode).toBe('off');
    expect(state.vault).toMatchObject({ backend: 'memory', locked: false });
  });

  it('lists providers per role from the registry', async () => {
    const catalog = (await s.api.get('/api/providers')).body as CatalogProvider[];
    const acme = catalog.find((p) => p.id === 'acme')!;
    expect(Object.keys(acme.roles).sort()).toEqual(['align', 'search', 'text', 'vision', 'voice']);
    expect(acme.credential).toMatchObject({ id: 'acme', optional: false });
    expect(acme.roles.text).toMatchObject({ defaultModel: 'acme-text-1' });
    expect(catalog.find((p) => p.id === 'localai')!.credential).toBeNull();
  });

  it('stores a key in the vault, shows only the last four characters, and never returns it', async () => {
    const res = await s.api.put('/api/credentials/acme', { apiKey: ACME_KEY });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'acme', masked: '••••1234' });
    expect(res.raw).not.toContain(ACME_KEY);
    expect(await s.deps.vault.get('acme')).toBe(ACME_KEY);
    const state = await setup();
    expect(state.credentials).toEqual([
      { id: 'acme', label: 'Acme API key', masked: '••••1234', updatedAt: expect.any(String) },
    ]);
    expect(JSON.stringify(state)).not.toContain(ACME_KEY);
  });

  it('never writes the key to the database', async () => {
    await s.api.put('/api/credentials/acme', { apiKey: ACME_KEY });
    const tables = s.db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      expect(JSON.stringify(s.db.raw.prepare(`SELECT * FROM ${name}`).all())).not.toContain(
        ACME_KEY,
      );
    }
  });

  it('rejects keys for unknown credentials and empty keys', async () => {
    expect((await s.api.put('/api/credentials/nope', { apiKey: 'x'.repeat(20) })).status).toBe(404);
    expect((await s.api.put('/api/credentials/acme', { apiKey: '   ' })).status).toBe(400);
  });

  it('tests a role with one tiny call and reports the model it reached', async () => {
    await s.api.put('/api/credentials/acme', { apiKey: ACME_KEY });
    await s.api.put('/api/setup/roles/text', {
      mode: 'provider',
      providerId: 'acme',
      model: 'acme-text-mini',
    });
    const test = (await s.api.post('/api/setup/roles/text/test')).body as RoleTestResult;
    expect(test).toMatchObject({ ok: true, model: 'acme-text-mini-2026-10-01' });
    expect(test.detail).toMatch(/OK/);
    expect((await setup()).roles.text.test).toMatchObject({
      status: 'passed',
      model: 'acme-text-mini-2026-10-01',
    });
  });

  it('fails the test with a wrong key, without leaking it', async () => {
    await s.api.put('/api/credentials/acme', { apiKey: 'sk-wrong-key-000000000000000' });
    await s.api.put('/api/setup/roles/text', { mode: 'provider', providerId: 'acme' });
    const res = await s.api.post('/api/setup/roles/text/test');
    expect(res.body).toMatchObject({ ok: false });
    expect((res.body as RoleTestResult).detail).toMatch(/key/i);
    expect(res.raw).not.toContain('sk-wrong-key');
    expect((await setup()).roles.text.test.status).toBe('failed');
  });

  it('cannot test a role whose provider needs a key that is not stored', async () => {
    await s.api.put('/api/setup/roles/text', { mode: 'provider', providerId: 'acme' });
    const res = await s.api.post('/api/setup/roles/text/test');
    expect(res.body).toMatchObject({ ok: false });
    expect((res.body as RoleTestResult).detail).toMatch(/Acme API key/);
  });

  it('lets one key fill several slots', async () => {
    const state = await s.completeSetup();
    expect(state.complete).toBe(true);
    expect(state.credentials).toHaveLength(1);
    for (const role of ['text', 'search', 'voice', 'align'] as const)
      expect(state.roles[role]).toMatchObject({ providerId: 'acme', test: { status: 'passed' } });
  });

  it('resets every role using a credential when its key changes', async () => {
    await s.completeSetup();
    await s.api.put('/api/credentials/acme', { apiKey: 'sk-acme-new-key-000000000009999' });
    const state = await setup();
    expect(state.complete).toBe(false);
    expect(state.roles.text.test.status).toBe('untested');
    expect(state.roles.voice.test.status).toBe('untested');
  });

  it('resets a role’s test when its provider, model or options change', async () => {
    await s.completeSetup();
    await s.api.put('/api/setup/roles/text', {
      mode: 'provider',
      providerId: 'acme',
      model: 'acme-text-mini',
    });
    expect((await setup()).roles.text.test.status).toBe('untested');
  });

  it('removing a key un-completes setup', async () => {
    await s.completeSetup();
    expect((await s.api.del('/api/credentials/acme')).status).toBe(204);
    expect(await s.deps.vault.get('acme')).toBeNull();
    expect((await setup()).complete).toBe(false);
  });

  it('allows "off" only where the spec offers it', async () => {
    expect((await s.api.put('/api/setup/roles/text', { mode: 'off' })).status).toBe(400);
    expect((await s.api.put('/api/setup/roles/search', { mode: 'off' })).status).toBe(200);
    expect((await s.api.put('/api/setup/roles/vision', { mode: 'off' })).status).toBe(200);
  });

  it('accepts "use the voice’s own timings" only for a voice that returns them', async () => {
    await s.api.put('/api/credentials/acme', { apiKey: ACME_KEY });
    await s.api.put('/api/setup/roles/voice', { mode: 'provider', providerId: 'acme' });
    expect((await s.api.put('/api/setup/roles/align', { mode: 'off' })).status).toBe(400);
    await s.api.put('/api/credentials/labs', { apiKey: LABS_KEY });
    await s.api.put('/api/setup/roles/voice', { mode: 'provider', providerId: 'labs' });
    expect((await s.api.put('/api/setup/roles/align', { mode: 'off' })).status).toBe(200);
  });

  it('completes with a local word-timing provider that needs no key', async () => {
    const state = await s.completeSetup({ align: 'localai' });
    expect(state.complete).toBe(true);
    expect(state.roles.align).toMatchObject({ providerId: 'localai', test: { status: 'passed' } });
  });

  it('completes without search when the user will paste source text', async () => {
    const state = await s.completeSetup({ search: 'off' });
    expect(state.complete).toBe(true);
  });

  it('rejects a provider that cannot fill the role, and unknown providers', async () => {
    expect(
      (await s.api.put('/api/setup/roles/text', { mode: 'provider', providerId: 'labs' })).status,
    ).toBe(400);
    expect(
      (await s.api.put('/api/setup/roles/text', { mode: 'provider', providerId: 'nope' })).status,
    ).toBe(400);
    expect((await s.api.put('/api/setup/roles/nope', { mode: 'off' })).status).toBe(404);
  });

  it('rejects a model the adapter cannot use for the role', async () => {
    await s.api.put('/api/credentials/acme', { apiKey: ACME_KEY });
    const res = await s.api.put('/api/setup/roles/align', {
      mode: 'provider',
      providerId: 'acme',
      model: 'acme-transcribe',
    });
    expect(res.status).toBe(400);
    expect(res.raw).toMatch(/word timestamps/);
  });
});
