import { assertValidId, type SecretVault } from './vault';

/** Process-memory vault for tests and ephemeral runs. Never locked, never persisted. */
export class MemoryVault implements SecretVault {
  readonly backend = 'memory' as const;
  private readonly values = new Map<string, string>();

  isLocked(): boolean {
    return false;
  }

  async needsSetup(): Promise<boolean> {
    return false;
  }

  async setup(_passphrase: string): Promise<void> {}

  async unlock(_passphrase: string): Promise<void> {}

  lock(): void {}

  async get(id: string): Promise<string | null> {
    assertValidId(id);
    return this.values.get(id) ?? null;
  }

  async set(id: string, value: string): Promise<void> {
    assertValidId(id);
    this.values.set(id, value);
  }

  async delete(id: string): Promise<void> {
    assertValidId(id);
    this.values.delete(id);
  }

  async listIds(): Promise<string[]> {
    return [...this.values.keys()].sort();
  }
}
