import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EncryptedFileVault, type KdfParams } from './file-vault';
import { DEFAULT_KEYCHAIN_SERVICE, KeychainVault, type KeyringModule } from './keychain-vault';
import type { SecretVault } from './vault';

export type OpenVaultOptions = {
  dataDir: string;
  /** Try the OS keychain first (default). false = always use the encrypted file. */
  preferKeychain?: boolean;
  /** Keyring implementation; undefined = load @napi-rs/keyring, null = none available. */
  keyring?: KeyringModule | null;
  service?: string;
  fileName?: string;
  kdf?: KdfParams;
  /** Called with the reason when the encrypted file is used instead of the keychain. */
  onFallback?: (reason: string) => void;
};

const MODULE_NAME = '@napi-rs/keyring';

/** Loads the optional native keyring binding; null when it is not installed for this platform. */
export const loadNativeKeyring = async (): Promise<KeyringModule | null> => {
  try {
    const mod = (await import(MODULE_NAME)) as {
      AsyncEntry?: KeyringModule['Entry'];
      default?: { AsyncEntry?: KeyringModule['Entry'] };
    };
    const AsyncEntry = mod.AsyncEntry ?? mod.default?.AsyncEntry;
    return AsyncEntry ? { Entry: AsyncEntry } : null;
  } catch {
    return null;
  }
};

/** Stores, reads back and deletes a random value. Returns why the keychain is unusable, or null. */
const probeKeychain = async (keyring: KeyringModule, service: string): Promise<string | null> => {
  const account = `__vc_probe_${randomBytes(6).toString('hex')}`;
  const value = randomBytes(16).toString('hex');
  try {
    const entry = new keyring.Entry(service, account);
    await entry.setPassword(value);
    const read = await entry.getPassword();
    return read === value ? null : 'The OS keychain returned a different value than it stored.';
  } catch (error) {
    return `The OS keychain is not usable: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    try {
      await new keyring.Entry(service, account).deletePassword();
    } catch {
      // nothing to clean up
    }
  }
};

const fileExists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Keys live only on this machine: in the OS keychain where one works, otherwise in an encrypted
 * file unlocked by a passphrase. An existing vault file is kept so stored keys are never stranded.
 */
export const openVault = async (options: OpenVaultOptions): Promise<SecretVault> => {
  const path = join(options.dataDir, options.fileName ?? 'vault.json');
  const fileVault = () =>
    new EncryptedFileVault({ path, ...(options.kdf ? { kdf: options.kdf } : {}) });
  if (options.preferKeychain === false) return fileVault();
  const fallback = (reason: string) => {
    options.onFallback?.(reason);
    return fileVault();
  };
  if (await fileExists(path)) return fallback('An encrypted key file already exists; keeping it.');
  const keyring = options.keyring === undefined ? await loadNativeKeyring() : options.keyring;
  if (keyring === null) return fallback('No OS keychain module is available on this platform.');
  const service = options.service ?? DEFAULT_KEYCHAIN_SERVICE;
  const problem = await probeKeychain(keyring, service);
  if (problem) return fallback(problem);
  return new KeychainVault({ keyring, service });
};
