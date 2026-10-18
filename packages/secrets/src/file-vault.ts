import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MIN_PASSPHRASE_LENGTH,
  Mutex,
  VaultCorruptError,
  VaultLockedError,
  VaultPassphraseError,
  VaultSetupError,
  WeakPassphraseError,
  assertValidId,
  type SecretVault,
} from './vault';

export type KdfParams = { N: number; r: number; p: number };

/** scrypt cost: N=2^15, r=8, p=1 (≈32 MiB, well under a second). */
export const DEFAULT_KDF: Readonly<KdfParams> = Object.freeze({ N: 2 ** 15, r: 8, p: 1 });

const VERSION = 1;
const KEY_BYTES = 64; // 32 for AES-256-GCM, 32 for the passphrase verifier HMAC
const VERIFIER_LABEL = 'video-creator vault verifier v1';
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

type Envelope = {
  version: number;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  /** HMAC of a fixed label: tells a wrong passphrase apart from a tampered file. */
  verifier: string;
  iv: string;
  tag: string;
  data: string;
};

type Unlocked = {
  encKey: Buffer;
  macKey: Buffer;
  salt: Buffer;
  kdf: KdfParams;
  values: Map<string, string>;
};

const deriveKeys = (passphrase: string, salt: Buffer, kdf: KdfParams) =>
  new Promise<{ encKey: Buffer; macKey: Buffer }>((resolve, reject) => {
    scrypt(
      passphrase.normalize('NFKC'),
      salt,
      KEY_BYTES,
      { ...kdf, maxmem: SCRYPT_MAXMEM },
      (error, key) => {
        if (error) reject(error);
        else resolve({ encKey: key.subarray(0, 32), macKey: key.subarray(32) });
      },
    );
  });

const verifierFor = (macKey: Buffer) =>
  createHmac('sha256', macKey).update(VERIFIER_LABEL).digest();

/** Header fields are authenticated with the ciphertext, so editing them is detected. */
const aadFor = (kdf: KdfParams, salt: Buffer) =>
  Buffer.from(`vc-vault|v${VERSION}|scrypt|${kdf.N}|${kdf.r}|${kdf.p}|${salt.toString('base64')}`);

const isBase64 = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value);

/** Validates the envelope shape and bounds the KDF cost, so a modified file cannot hang unlock. */
const parseEnvelope = (raw: string): { envelope: Envelope; kdf: KdfParams; salt: Buffer } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VaultCorruptError('the file is not valid JSON');
  }
  const env = parsed as Partial<Envelope> | null;
  if (!env || typeof env !== 'object') throw new VaultCorruptError('the file is not an object');
  if (env.version !== VERSION)
    throw new VaultCorruptError(`unsupported version ${String(env.version)}`);
  const kdf = env.kdf;
  if (!kdf || kdf.name !== 'scrypt') throw new VaultCorruptError('unknown key derivation');
  const { N, r, p } = kdf;
  const powerOfTwo = Number.isInteger(N) && N >= 2 ** 10 && N <= 2 ** 20 && (N & (N - 1)) === 0;
  if (
    !powerOfTwo ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > 32 ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > 16
  ) {
    throw new VaultCorruptError('key derivation parameters are out of range');
  }
  if (![kdf.salt, env.verifier, env.iv, env.tag, env.data].every(isBase64))
    throw new VaultCorruptError('a field is missing or not base64');
  const salt = Buffer.from(kdf.salt, 'base64');
  if (
    salt.length < 16 ||
    Buffer.from(env.iv!, 'base64').length !== 12 ||
    Buffer.from(env.tag!, 'base64').length !== 16
  ) {
    throw new VaultCorruptError('salt, IV or tag has the wrong length');
  }
  return { envelope: env as Envelope, kdf: { N, r, p }, salt };
};

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Write to a temp file (0600) in the same directory, fsync, then rename over the target. */
const writeFileAtomic = async (path: string, contents: string) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
};

/**
 * Keys in a local file encrypted with AES-256-GCM under a key derived from the user's passphrase
 * (scrypt). Used where no OS keychain exists. Locked until unlocked with the passphrase.
 */
export class EncryptedFileVault implements SecretVault {
  readonly backend = 'file' as const;
  readonly path: string;
  private readonly kdf: KdfParams;
  private state: Unlocked | null = null;
  private readonly mutex = new Mutex();

  constructor({ path, kdf = DEFAULT_KDF }: { path: string; kdf?: KdfParams }) {
    this.path = path;
    this.kdf = { ...kdf };
  }

  isLocked(): boolean {
    return this.state === null;
  }

  async needsSetup(): Promise<boolean> {
    return !(await exists(this.path));
  }

  async setup(passphrase: string): Promise<void> {
    return this.mutex.run(async () => {
      if (await exists(this.path))
        throw new VaultSetupError('A key vault already exists here; unlock it instead.');
      if (passphrase.length < MIN_PASSPHRASE_LENGTH)
        throw new WeakPassphraseError(MIN_PASSPHRASE_LENGTH);
      const salt = randomBytes(16);
      const keys = await deriveKeys(passphrase, salt, this.kdf);
      this.state = { ...keys, salt, kdf: { ...this.kdf }, values: new Map() };
      await this.persist();
    });
  }

  async unlock(passphrase: string): Promise<void> {
    return this.mutex.run(async () => {
      this.state = await this.open(passphrase);
    });
  }

  lock(): void {
    if (this.state) {
      this.state.encKey.fill(0);
      this.state.macKey.fill(0);
      this.state.values.clear();
    }
    this.state = null;
  }

  async get(id: string): Promise<string | null> {
    assertValidId(id);
    return this.unlocked().values.get(id) ?? null;
  }

  async set(id: string, value: string): Promise<void> {
    assertValidId(id);
    return this.mutex.run(async () => {
      this.unlocked().values.set(id, value);
      await this.persist();
    });
  }

  async delete(id: string): Promise<void> {
    assertValidId(id);
    return this.mutex.run(async () => {
      if (this.unlocked().values.delete(id)) await this.persist();
    });
  }

  async listIds(): Promise<string[]> {
    return [...this.unlocked().values.keys()].sort();
  }

  async changePassphrase(current: string, next: string): Promise<void> {
    return this.mutex.run(async () => {
      if (next.length < MIN_PASSPHRASE_LENGTH) throw new WeakPassphraseError(MIN_PASSPHRASE_LENGTH);
      const opened = await this.open(current);
      const salt = randomBytes(16);
      const keys = await deriveKeys(next, salt, this.kdf);
      opened.encKey.fill(0);
      opened.macKey.fill(0);
      this.state = { ...keys, salt, kdf: { ...this.kdf }, values: opened.values };
      await this.persist();
    });
  }

  private unlocked(): Unlocked {
    if (!this.state) throw new VaultLockedError();
    return this.state;
  }

  /** Reads, verifies and decrypts the file with a passphrase. */
  private async open(passphrase: string): Promise<Unlocked> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      throw new VaultSetupError('No key vault exists yet; choose a passphrase first.');
    }
    const { envelope, kdf, salt } = parseEnvelope(raw);
    const keys = await deriveKeys(passphrase, salt, kdf);
    const expected = Buffer.from(envelope.verifier, 'base64');
    const actual = verifierFor(keys.macKey);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new VaultPassphraseError();
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        keys.encKey,
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAAD(aadFor(kdf, salt));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final(),
      ]);
    } catch {
      throw new VaultCorruptError('authentication failed');
    }
    let values: Map<string, string>;
    try {
      const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('not an object');
      values = new Map(
        Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
    } catch {
      throw new VaultCorruptError('the decrypted contents are not a key map');
    } finally {
      plaintext.fill(0);
    }
    return { ...keys, salt, kdf, values };
  }

  private async persist(): Promise<void> {
    const state = this.unlocked();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', state.encKey, iv);
    cipher.setAAD(aadFor(state.kdf, state.salt));
    const plaintext = Buffer.from(JSON.stringify(Object.fromEntries(state.values)), 'utf8');
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    plaintext.fill(0);
    const envelope: Envelope = {
      version: VERSION,
      kdf: { name: 'scrypt', ...state.kdf, salt: state.salt.toString('base64') },
      verifier: verifierFor(state.macKey).toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    await writeFileAtomic(this.path, `${JSON.stringify(envelope, null, 2)}\n`);
  }
}
