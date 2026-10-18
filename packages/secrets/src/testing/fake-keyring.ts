import type { KeyringEntryLike, KeyringModule } from '../keychain-vault';

export type FakeKeyringOptions = {
  /** Make every setPassword throw (keychain unavailable, e.g. no Secret Service on Linux). */
  failSet?: boolean;
  failGet?: boolean;
  /** Return a different value than stored (a broken backend). */
  corruptGet?: boolean;
  /** Return promises, like @napi-rs/keyring's AsyncEntry. */
  async?: boolean;
};

/** An in-memory stand-in for @napi-rs/keyring, so tests never touch the real OS keychain. */
export class FakeKeyring implements KeyringModule {
  readonly store = new Map<string, string>();
  readonly calls: Array<{ op: 'get' | 'set' | 'delete'; service: string; account: string }> = [];
  readonly Entry: KeyringModule['Entry'];

  constructor(options: FakeKeyringOptions = {}) {
    const store = this.store;
    const calls = this.calls;
    const wrap = <T>(value: () => T): T | Promise<T> =>
      options.async ? Promise.resolve().then(value) : value();
    this.Entry = class implements KeyringEntryLike {
      private readonly key: string;
      constructor(
        private readonly service: string,
        private readonly account: string,
      ) {
        this.key = `${service}\u0000${account}`;
      }
      getPassword() {
        return wrap(() => {
          calls.push({ op: 'get', service: this.service, account: this.account });
          if (options.failGet) throw new Error('keychain read failed');
          const value = store.get(this.key) ?? null;
          return options.corruptGet && value !== null ? `${value}-corrupted` : value;
        });
      }
      setPassword(password: string) {
        return wrap(() => {
          calls.push({ op: 'set', service: this.service, account: this.account });
          if (options.failSet) throw new Error('no keychain service available');
          store.set(this.key, password);
        });
      }
      deletePassword() {
        return wrap(() => {
          calls.push({ op: 'delete', service: this.service, account: this.account });
          return store.delete(this.key);
        });
      }
    };
  }
}
