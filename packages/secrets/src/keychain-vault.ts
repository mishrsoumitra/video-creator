import { Mutex, VaultBackendError, assertValidId, type SecretVault } from './vault';

/** The subset of @napi-rs/keyring's Entry / AsyncEntry the vault uses (sync or async). */
export type KeyringEntryLike = {
  getPassword(): string | null | Promise<string | null>;
  setPassword(password: string): void | Promise<void>;
  deletePassword(): boolean | Promise<boolean>;
};

export type KeyringModule = {
  Entry: new (service: string, account: string) => KeyringEntryLike;
};

export const DEFAULT_KEYCHAIN_SERVICE = 'video-creator';
/** Account holding the JSON list of stored ids (no values), since keychains cannot list portably. */
export const INDEX_ACCOUNT = '__vc_index__';

/**
 * Keys in the OS keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux).
 * The OS guards access, so the vault is never locked and needs no passphrase.
 */
export class KeychainVault implements SecretVault {
  readonly backend = 'keychain' as const;
  private readonly keyring: KeyringModule;
  private readonly service: string;
  private readonly mutex = new Mutex();

  constructor({
    keyring,
    service = DEFAULT_KEYCHAIN_SERVICE,
  }: {
    keyring: KeyringModule;
    service?: string;
  }) {
    this.keyring = keyring;
    this.service = service;
  }

  isLocked(): boolean {
    return false;
  }

  async needsSetup(): Promise<boolean> {
    return false;
  }

  async setup(_passphrase: string): Promise<void> {}

  async unlock(_passphrase: string): Promise<void> {}

  lock(): void {}

  private entry(account: string): KeyringEntryLike {
    return new this.keyring.Entry(this.service, account);
  }

  private async read(account: string): Promise<string | null> {
    try {
      return (await this.entry(account).getPassword()) ?? null;
    } catch (error) {
      throw new VaultBackendError('read a key', error);
    }
  }

  private async write(account: string, value: string): Promise<void> {
    try {
      await this.entry(account).setPassword(value);
    } catch (error) {
      throw new VaultBackendError('store a key', error);
    }
  }

  private async remove(account: string): Promise<void> {
    try {
      await this.entry(account).deletePassword();
    } catch (error) {
      throw new VaultBackendError('delete a key', error);
    }
  }

  private async readIndex(): Promise<string[]> {
    const raw = await this.read(INDEX_ACCOUNT);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeIndex(ids: Iterable<string>): Promise<void> {
    return this.write(INDEX_ACCOUNT, JSON.stringify([...new Set(ids)].sort()));
  }

  async get(id: string): Promise<string | null> {
    assertValidId(id);
    return this.read(id);
  }

  async set(id: string, value: string): Promise<void> {
    assertValidId(id);
    return this.mutex.run(async () => {
      await this.write(id, value);
      const ids = await this.readIndex();
      if (!ids.includes(id)) await this.writeIndex([...ids, id]);
    });
  }

  async delete(id: string): Promise<void> {
    assertValidId(id);
    return this.mutex.run(async () => {
      await this.remove(id);
      const ids = await this.readIndex();
      if (ids.includes(id)) await this.writeIndex(ids.filter((x) => x !== id));
    });
  }

  async listIds(): Promise<string[]> {
    return this.mutex.run(async () => (await this.readIndex()).sort());
  }
}
