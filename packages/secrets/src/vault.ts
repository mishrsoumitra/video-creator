/** Local-only storage for provider API keys. Implementations: OS keychain, encrypted file, memory. */
export interface SecretVault {
  readonly backend: 'keychain' | 'file' | 'memory';
  /** True while the vault cannot be read (an encrypted file before unlock). */
  isLocked(): boolean;
  /** True when a passphrase still has to be chosen (encrypted file not created yet). */
  needsSetup(): Promise<boolean>;
  setup(passphrase: string): Promise<void>;
  unlock(passphrase: string): Promise<void>;
  lock(): void;
  get(id: string): Promise<string | null>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
  /** Stored ids (never values), sorted. */
  listIds(): Promise<string[]>;
  changePassphrase?(current: string, next: string): Promise<void>;
}

export class VaultLockedError extends Error {
  constructor() {
    super('The key vault is locked. Unlock it with your passphrase first.');
    this.name = 'VaultLockedError';
  }
}

export class VaultPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase.');
    this.name = 'VaultPassphraseError';
  }
}

export class VaultCorruptError extends Error {
  constructor(detail: string) {
    super(`The key vault file is damaged or was modified: ${detail}`);
    this.name = 'VaultCorruptError';
  }
}

export class VaultSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultSetupError';
  }
}

export class WeakPassphraseError extends Error {
  constructor(minLength: number) {
    super(`Use a passphrase of at least ${minLength} characters.`);
    this.name = 'WeakPassphraseError';
  }
}

/** A keychain call failed. The message never includes the value being stored. */
export class VaultBackendError extends Error {
  constructor(operation: string, cause: unknown) {
    super(
      `The OS keychain could not ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'VaultBackendError';
  }
}

export const MIN_PASSPHRASE_LENGTH = 8;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Ids become keychain account names and object keys: keep them plain. */
export const assertValidId = (id: string): void => {
  if (!ID_PATTERN.test(id) || id.includes('..')) {
    throw new TypeError(`Invalid secret id "${id}": use 1-64 letters, digits, ".", "_" or "-".`);
  }
};

/** Serialises async work so concurrent writes cannot lose updates. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
