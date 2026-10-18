import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EncryptedFileVault, KeychainVault, MemoryVault, type SecretVault } from './index';
import { FakeKeyring } from './testing';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-secrets-'));
  dirs.push(dir);
  return dir;
};

const backends: Array<[string, () => Promise<SecretVault>]> = [
  ['memory', async () => new MemoryVault()],
  ['keychain (sync fake)', async () => new KeychainVault({ keyring: new FakeKeyring() })],
  [
    'keychain (async fake)',
    async () => new KeychainVault({ keyring: new FakeKeyring({ async: true }) }),
  ],
  [
    'encrypted file',
    async () => {
      const vault = new EncryptedFileVault({ path: join(await tempDir(), 'vault.json') });
      await vault.setup('correct horse battery');
      return vault;
    },
  ],
];

describe.each(backends)('SecretVault contract: %s', (_name, make) => {
  it('stores and reads back a key', async () => {
    const vault = await make();
    await vault.set('openai', 'sk-proj-abcdefghijklmnop');
    expect(await vault.get('openai')).toBe('sk-proj-abcdefghijklmnop');
  });

  it('returns null for a key that was never stored', async () => {
    const vault = await make();
    expect(await vault.get('anthropic')).toBeNull();
  });

  it('overwrites an existing key', async () => {
    const vault = await make();
    await vault.set('openai', 'first-value-123');
    await vault.set('openai', 'second-value-456');
    expect(await vault.get('openai')).toBe('second-value-456');
  });

  it('deletes keys, and deleting a missing key is not an error', async () => {
    const vault = await make();
    await vault.set('elevenlabs', 'eleven-key-123456');
    await vault.delete('elevenlabs');
    expect(await vault.get('elevenlabs')).toBeNull();
    await expect(vault.delete('elevenlabs')).resolves.toBeUndefined();
  });

  it('lists stored ids in order, never values', async () => {
    const vault = await make();
    await vault.set('serpapi', 'serp-key-123456');
    await vault.set('brave', 'brave-key-123456');
    expect(await vault.listIds()).toEqual(['brave', 'serpapi']);
  });

  it('keeps unicode values intact', async () => {
    const vault = await make();
    await vault.set('azure', 'ключ-🔑-値-123456');
    expect(await vault.get('azure')).toBe('ключ-🔑-値-123456');
  });

  it.each(['', 'has space', '../escape', 'a/b', 'x'.repeat(65)])(
    'rejects the invalid id %j',
    async (id) => {
      const vault = await make();
      await expect(vault.set(id, 'value-123456')).rejects.toThrow(/id/i);
    },
  );

  it('keeps every key when many are written at once', async () => {
    const vault = await make();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => vault.set(`provider-${i}`, `value-number-${i}`)),
    );
    expect((await vault.listIds()).length).toBe(20);
    expect(await vault.get('provider-13')).toBe('value-number-13');
  });
});
