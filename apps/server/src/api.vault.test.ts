import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedFileVault } from '@vc/secrets';
import type { SetupState } from '@vc/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACME_KEY } from './test/fakes';
import { createTestServer, type TestServer } from './test/harness';

let s: TestServer;
let vaultDir: string;
beforeEach(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), 'vc-vault-'));
  // A cheap KDF keeps the test fast; production uses the default scrypt cost.
  s = await createTestServer({
    vault: new EncryptedFileVault({
      path: join(vaultDir, 'vault.json'),
      kdf: { N: 1024, r: 8, p: 1 },
    }),
  });
});
afterEach(async () => {
  await s.close();
  await rm(vaultDir, { recursive: true, force: true });
});

const vault = async () => ((await s.api.get('/api/setup')).body as SetupState).vault;

describe('encrypted-file vault (no OS keychain)', () => {
  it('asks for a passphrase before any key can be stored', async () => {
    expect(await vault()).toEqual({ backend: 'file', locked: true, needsSetup: true });
    expect((await s.api.put('/api/credentials/acme', { apiKey: ACME_KEY })).status).toBe(423);
  });

  it('rejects a short passphrase', async () => {
    expect((await s.api.post('/api/vault/setup', { passphrase: 'short' })).status).toBe(400);
  });

  it('stores keys encrypted on disk', async () => {
    expect(
      (await s.api.post('/api/vault/setup', { passphrase: 'correct horse battery' })).status,
    ).toBe(200);
    expect(await vault()).toMatchObject({ locked: false, needsSetup: false });
    expect((await s.api.put('/api/credentials/acme', { apiKey: ACME_KEY })).status).toBe(200);
    const onDisk = await readFile(join(vaultDir, 'vault.json'), 'utf8');
    expect(onDisk).not.toContain(ACME_KEY);
    expect(onDisk).not.toContain('acme-test-key');
  });

  it('locks and unlocks with the passphrase', async () => {
    await s.api.post('/api/vault/setup', { passphrase: 'correct horse battery' });
    await s.api.put('/api/credentials/acme', { apiKey: ACME_KEY });
    expect((await s.api.post('/api/vault/lock')).status).toBe(200);
    expect(await vault()).toMatchObject({ locked: true });
    expect(
      (await s.api.post('/api/vault/unlock', { passphrase: 'wrong passphrase!' })).status,
    ).toBe(401);
    expect(
      (await s.api.post('/api/vault/unlock', { passphrase: 'correct horse battery' })).status,
    ).toBe(200);
    expect(await s.deps.vault.get('acme')).toBe(ACME_KEY);
  });
});
