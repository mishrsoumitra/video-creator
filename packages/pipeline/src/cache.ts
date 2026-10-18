import { createHash } from 'node:crypto';
import { normalizeForMatch } from './text';

export interface CacheStore {
  get<T>(key: string): Promise<{ value: T; createdAt: number } | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

const DAY = 24 * 60 * 60 * 1000;

/** Spec: same topic + length within a week reuses the fact sheet. */
export const CACHE_TTL_MS = Object.freeze({
  research: 7 * DAY,
  tts: 90 * DAY,
  images: 30 * DAY,
  align: 90 * DAY,
});

const sha = (...parts: string[]) =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40);

export const normalizeTopic = (topic: string): string => normalizeForMatch(topic);

export const cacheKeys = {
  research: (topic: string, lengthSeconds: number) =>
    `research:v1:${sha(normalizeTopic(topic), String(lengthSeconds))}`,
  /** Same script (exact text) + same voice → same audio and timings. */
  tts: (k: { text: string; providerId: string; model: string; voiceId: string }) =>
    `tts:v1:${sha(k.text, k.providerId, k.model, k.voiceId)}`,
  align: (k: { audioSha: string; text: string; providerId: string; model: string }) =>
    `align:v1:${sha(k.audioSha, k.text, k.providerId, k.model)}`,
  /** Same image query → the same ranked candidates. */
  images: (k: { query: string; aspect: string; licenses: readonly string[] }) =>
    `images:v1:${sha(normalizeForMatch(k.query), k.aspect, [...k.licenses].sort().join(','))}`,
};

export const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<
    string,
    { value: unknown; createdAt: number; expiresAt: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  async get<T>(key: string): Promise<{ value: T; createdAt: number } | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return { value: structuredClone(entry.value) as T, createdAt: entry.createdAt };
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const now = this.now();
    this.entries.set(key, {
      value: structuredClone(value),
      createdAt: now,
      expiresAt: now + ttlMs,
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}
