import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KeychainVault, VaultBackendError, openVault } from './index';
import { FakeKeyring } from './testing';

const KEY = 'sk-ant-api03-VerySecretValue-0123456789';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-open-vault-'));
  dirs.push(dir);
  return dir;
};

describe('KeychainVault', () => {
  it('stores each key under the video-creator service with the id as account', async () => {
    const keyring = new FakeKeyring();
    const vault = new KeychainVault({ keyring });
    await vault.set('anthropic', KEY);
    expect(keyring.store.get('video-creator\u0000anthropic')).toBe(KEY);
  });

  it('honours a custom service name', async () => {
    const keyring = new FakeKeyring();
    await new KeychainVault({ keyring, service: 'vc-dev' }).set('anthropic', KEY);
    expect(keyring.store.has('vc-dev\u0000anthropic')).toBe(true);
  });

  it('keeps an index of ids that contains no secret values', async () => {
    const keyring = new FakeKeyring();
    const vault = new KeychainVault({ keyring });
    await vault.set('anthropic', KEY);
    await vault.set('openai', 'sk-proj-another-secret-value');
    const index = [...keyring.store.entries()].find(([k]) => k.endsWith('__vc_index__'))?.[1];
    expect(JSON.parse(index!)).toEqual(['anthropic', 'openai']);
    expect(index).not.toContain(KEY);
    await vault.delete('anthropic');
    expect(await vault.listIds()).toEqual(['openai']);
  });

  it('is never locked and needs no setup (the OS guards it)', async () => {
    const vault = new KeychainVault({ keyring: new FakeKeyring() });
    expect(vault.backend).toBe('keychain');
    expect(vault.isLocked()).toBe(false);
    expect(await vault.needsSetup()).toBe(false);
    await expect(vault.unlock('anything')).resolves.toBeUndefined();
  });

  it('reports backend failures without leaking the value', async () => {
    const vault = new KeychainVault({ keyring: new FakeKeyring({ failSet: true }) });
    const error = await vault.set('anthropic', KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultBackendError);
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it('reports read failures as backend errors', async () => {
    const vault = new KeychainVault({ keyring: new FakeKeyring({ failGet: true }) });
    await expect(vault.get('anthropic')).rejects.toBeInstanceOf(VaultBackendError);
  });
});

describe('openVault', () => {
  it('uses the keychain when it works and removes its probe entry', async () => {
    const keyring = new FakeKeyring();
    const vault = await openVault({ dataDir: await tempDir(), keyring });
    expect(vault.backend).toBe('keychain');
    expect([...keyring.store.keys()].some((k) => k.includes('probe'))).toBe(false);
  });

  it('falls back to the encrypted file when the keychain cannot store anything', async () => {
    const dataDir = await tempDir();
    const reasons: string[] = [];
    const vault = await openVault({
      dataDir,
      keyring: new FakeKeyring({ failSet: true }),
      onFallback: (r) => reasons.push(r),
    });
    expect(vault.backend).toBe('file');
    expect(await vault.needsSetup()).toBe(true);
    await vault.setup('correct horse battery');
    await vault.set('openai', KEY);
    await expect(stat(join(dataDir, 'vault.json'))).resolves.toBeTruthy();
    expect(reasons).toHaveLength(1);
  });

  it('falls back when the keychain returns something other than what was stored', async () => {
    const vault = await openVault({
      dataDir: await tempDir(),
      keyring: new FakeKeyring({ corruptGet: true }),
    });
    expect(vault.backend).toBe('file');
  });

  it('falls back when no keychain module is available', async () => {
    const vault = await openVault({ dataDir: await tempDir(), keyring: null });
    expect(vault.backend).toBe('file');
  });

  it('does not touch the keychain at all when keychains are not preferred', async () => {
    const keyring = new FakeKeyring();
    const vault = await openVault({ dataDir: await tempDir(), keyring, preferKeychain: false });
    expect(vault.backend).toBe('file');
    expect(keyring.calls).toEqual([]);
  });
});

describe.skipIf(process.env.VC_TEST_KEYCHAIN !== '1')(
  'real OS keychain (opt-in: VC_TEST_KEYCHAIN=1)',
  () => {
    it('round-trips a value through @napi-rs/keyring and cleans up', async () => {
      const service = `video-creator-test-${process.pid}-${Date.now()}`;
      const vault = await openVault({ dataDir: await tempDir(), service });
      expect(vault.backend).toBe('keychain');
      await vault.set('probe-provider', KEY);
      expect(await vault.get('probe-provider')).toBe(KEY);
      await vault.delete('probe-provider');
      expect(await vault.get('probe-provider')).toBeNull();
      expect(await vault.listIds()).toEqual([]);
    });
  },
);
