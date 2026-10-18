import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EncryptedFileVault,
  VaultCorruptError,
  VaultLockedError,
  VaultPassphraseError,
  VaultSetupError,
  WeakPassphraseError,
} from './index';

const PASS = 'correct horse battery';
const KEY = 'sk-proj-SuperSecretValue-0123456789';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vc-file-vault-'));
  path = join(dir, 'nested', 'vault.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const freshVault = async () => {
  const vault = new EncryptedFileVault({ path });
  await vault.setup(PASS);
  return vault;
};

type Envelope = {
  version: number;
  kdf: { name: string; N: number; r: number; p: number; salt: string };
  iv: string;
  tag: string;
  data: string;
  verifier: string;
};
const readEnvelope = async (): Promise<Envelope> =>
  JSON.parse(await readFile(path, 'utf8')) as Envelope;
const writeEnvelope = (env: unknown) => writeFile(path, JSON.stringify(env));
const flip = (b64: string) => {
  const bytes = Buffer.from(b64, 'base64');
  bytes[0] = bytes[0]! ^ 0xff;
  return bytes.toString('base64');
};

describe('EncryptedFileVault setup', () => {
  it('needs setup until a passphrase has been chosen', async () => {
    const vault = new EncryptedFileVault({ path });
    expect(await vault.needsSetup()).toBe(true);
    expect(vault.isLocked()).toBe(true);
    await vault.setup(PASS);
    expect(await vault.needsSetup()).toBe(false);
    expect(vault.isLocked()).toBe(false);
  });

  it('rejects passphrases shorter than eight characters', async () => {
    const vault = new EncryptedFileVault({ path });
    await expect(vault.setup('short')).rejects.toBeInstanceOf(WeakPassphraseError);
    expect(await vault.needsSetup()).toBe(true);
  });

  it('refuses to set up twice', async () => {
    await freshVault();
    await expect(new EncryptedFileVault({ path }).setup(PASS)).rejects.toBeInstanceOf(
      VaultSetupError,
    );
  });

  it('writes an AES-256-GCM envelope with scrypt parameters and a 0600 file mode', async () => {
    const vault = await freshVault();
    await vault.set('openai', KEY);
    const env = await readEnvelope();
    expect(env.version).toBe(1);
    expect(env.kdf).toMatchObject({ name: 'scrypt', N: 32768, r: 8, p: 1 });
    expect(Buffer.from(env.kdf.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(env.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(env.tag, 'base64')).toHaveLength(16);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it('never writes the key, or its base64, to disk', async () => {
    const vault = await freshVault();
    await vault.set('openai', KEY);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain(Buffer.from(KEY).toString('base64'));
    expect(raw).not.toContain('openai');
  });

  it('uses a fresh IV for every write', async () => {
    const vault = await freshVault();
    await vault.set('a-provider', 'value-one-123456');
    const first = await readEnvelope();
    await vault.set('a-provider', 'value-one-123456');
    const second = await readEnvelope();
    expect(second.iv).not.toBe(first.iv);
    expect(second.data).not.toBe(first.data);
  });

  it('leaves no temporary files behind', async () => {
    const vault = await freshVault();
    await Promise.all([
      vault.set('a-provider', 'value-1234567'),
      vault.set('b-provider', 'value-7654321'),
    ]);
    expect(await readdir(join(dir, 'nested'))).toEqual(['vault.json']);
  });
});

describe('EncryptedFileVault lock and unlock', () => {
  it('starts locked after a restart and refuses every access until unlocked', async () => {
    const first = await freshVault();
    await first.set('openai', KEY);
    const restarted = new EncryptedFileVault({ path });
    expect(restarted.isLocked()).toBe(true);
    await expect(restarted.get('openai')).rejects.toBeInstanceOf(VaultLockedError);
    await expect(restarted.set('x-provider', 'value-123456')).rejects.toBeInstanceOf(
      VaultLockedError,
    );
    await expect(restarted.listIds()).rejects.toBeInstanceOf(VaultLockedError);
    await expect(restarted.delete('openai')).rejects.toBeInstanceOf(VaultLockedError);
    await restarted.unlock(PASS);
    expect(await restarted.get('openai')).toBe(KEY);
  });

  it('rejects a wrong passphrase with VaultPassphraseError and stays locked', async () => {
    const first = await freshVault();
    await first.set('openai', KEY);
    const restarted = new EncryptedFileVault({ path });
    await expect(restarted.unlock('wrong passphrase')).rejects.toBeInstanceOf(VaultPassphraseError);
    expect(restarted.isLocked()).toBe(true);
  });

  it('lock() forgets the key until the next unlock', async () => {
    const vault = await freshVault();
    await vault.set('openai', KEY);
    vault.lock();
    expect(vault.isLocked()).toBe(true);
    await expect(vault.get('openai')).rejects.toBeInstanceOf(VaultLockedError);
    await vault.unlock(PASS);
    expect(await vault.get('openai')).toBe(KEY);
  });

  it('cannot unlock a vault that was never set up', async () => {
    await expect(new EncryptedFileVault({ path }).unlock(PASS)).rejects.toBeInstanceOf(
      VaultSetupError,
    );
  });
});

describe('EncryptedFileVault tamper detection', () => {
  const tamper = async (mutate: (env: Envelope) => void) => {
    const vault = await freshVault();
    await vault.set('openai', KEY);
    const env = await readEnvelope();
    mutate(env);
    await writeEnvelope(env);
    return new EncryptedFileVault({ path });
  };

  it('detects tampered ciphertext', async () => {
    const vault = await tamper((env) => {
      env.data = flip(env.data);
    });
    await expect(vault.unlock(PASS)).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it('detects a tampered IV', async () => {
    const vault = await tamper((env) => {
      env.iv = flip(env.iv);
    });
    await expect(vault.unlock(PASS)).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it('detects a tampered auth tag', async () => {
    const vault = await tamper((env) => {
      env.tag = flip(env.tag);
    });
    await expect(vault.unlock(PASS)).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it('treats an unreadable file as corrupt', async () => {
    await freshVault();
    await writeFile(path, '{not json');
    await expect(new EncryptedFileVault({ path }).unlock(PASS)).rejects.toBeInstanceOf(
      VaultCorruptError,
    );
  });

  it('treats an unknown version or malformed envelope as corrupt', async () => {
    const versioned = await tamper((env) => {
      env.version = 99;
    });
    await expect(versioned.unlock(PASS)).rejects.toBeInstanceOf(VaultCorruptError);
    await writeEnvelope({ version: 1 });
    await expect(new EncryptedFileVault({ path }).unlock(PASS)).rejects.toBeInstanceOf(
      VaultCorruptError,
    );
  });
});

describe('EncryptedFileVault passphrase change', () => {
  it('re-encrypts under the new passphrase with a new salt', async () => {
    const vault = await freshVault();
    await vault.set('openai', KEY);
    const before = await readEnvelope();
    await vault.changePassphrase(PASS, 'a brand new passphrase');
    const after = await readEnvelope();
    expect(after.kdf.salt).not.toBe(before.kdf.salt);
    expect(await vault.get('openai')).toBe(KEY);

    const restarted = new EncryptedFileVault({ path });
    await expect(restarted.unlock(PASS)).rejects.toBeInstanceOf(VaultPassphraseError);
    await restarted.unlock('a brand new passphrase');
    expect(await restarted.get('openai')).toBe(KEY);
  });

  it('requires the current passphrase', async () => {
    const vault = await freshVault();
    await expect(
      vault.changePassphrase('not the passphrase', 'another long one'),
    ).rejects.toBeInstanceOf(VaultPassphraseError);
  });

  it('rejects a weak new passphrase', async () => {
    const vault = await freshVault();
    await expect(vault.changePassphrase(PASS, 'tiny')).rejects.toBeInstanceOf(WeakPassphraseError);
  });
});
