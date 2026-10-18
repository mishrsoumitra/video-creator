import { describe, expect, it } from 'vitest';
import { CACHE_TTL_MS, MemoryCacheStore, cacheKeys, normalizeTopic } from './cache';

describe('cache keys', () => {
  it('treats the same topic with different case, spacing and punctuation as the same', () => {
    expect(normalizeTopic('  The Apollo   Program! ')).toBe(normalizeTopic('the apollo program'));
    expect(cacheKeys.research('The Apollo Program', 60)).toBe(
      cacheKeys.research('the apollo program!', 60),
    );
  });

  it('separates lengths and topics', () => {
    expect(cacheKeys.research('Apollo', 60)).not.toBe(cacheKeys.research('Apollo', 90));
    expect(cacheKeys.research('Apollo', 60)).not.toBe(cacheKeys.research('Gemini', 60));
  });

  it('keys TTS by the exact script text and the voice', () => {
    const base = { text: 'Hello there.', providerId: 'openai', model: 'tts', voiceId: 'alloy' };
    expect(cacheKeys.tts(base)).toBe(cacheKeys.tts({ ...base }));
    expect(cacheKeys.tts(base)).not.toBe(cacheKeys.tts({ ...base, text: 'Hello there!' }));
    expect(cacheKeys.tts(base)).not.toBe(cacheKeys.tts({ ...base, voiceId: 'nova' }));
  });

  it('keys image candidates by normalised query, aspect and licences (order-insensitive)', () => {
    const a = cacheKeys.images({
      query: 'Saturn V launch',
      aspect: '16:9',
      licenses: ['by', 'cc0'],
    });
    expect(a).toBe(
      cacheKeys.images({ query: 'saturn v  launch', aspect: '16:9', licenses: ['cc0', 'by'] }),
    );
    expect(a).not.toBe(
      cacheKeys.images({ query: 'Saturn V launch', aspect: '9:16', licenses: ['by', 'cc0'] }),
    );
  });

  it('never embeds raw text in keys', () => {
    expect(cacheKeys.research('secret topic', 60)).not.toContain('secret');
  });
});

describe('MemoryCacheStore', () => {
  it('returns values until they expire', async () => {
    let now = 1_000;
    const cache = new MemoryCacheStore(() => now);
    await cache.set('k', { a: 1 }, 100);
    expect(await cache.get('k')).toEqual({ value: { a: 1 }, createdAt: 1_000 });
    now = 1_099;
    expect(await cache.get('k')).not.toBeNull();
    now = 1_100;
    expect(await cache.get('k')).toBeNull();
  });

  it('returns copies so callers cannot mutate cached values', async () => {
    const cache = new MemoryCacheStore(() => 0);
    await cache.set('k', { list: [1] }, 10);
    const hit = await cache.get<{ list: number[] }>('k');
    hit!.value.list.push(2);
    expect((await cache.get<{ list: number[] }>('k'))!.value.list).toEqual([1]);
  });

  it('keeps fact sheets for a week', () => {
    expect(CACHE_TTL_MS.research).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
