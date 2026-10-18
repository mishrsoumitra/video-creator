import { describe, expect, it } from 'vitest';
import { splitTextForSpeech } from './text-chunks';

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('splitTextForSpeech', () => {
  const story =
    'The Apollo program ran from 1961 to 1972. It landed twelve people on the Moon! ' +
    'Was it worth it? Many historians think so; others disagree, citing the cost. ' +
    'The Saturn V remains the most powerful rocket ever flown.';

  it('keeps short text as one chunk', () => {
    expect(splitTextForSpeech('Hello there.', { maxChars: 100 })).toEqual(['Hello there.']);
  });

  it('splits at sentence ends and loses nothing', () => {
    const chunks = splitTextForSpeech(story, { maxChars: 90 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toBe(normalise(story));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(90);
      expect(chunk).toBe(chunk.trim());
    }
    expect(chunks[0]).toBe(
      'The Apollo program ran from 1961 to 1972. It landed twelve people on the Moon!',
    );
  });

  it('falls back to clause and then word boundaries for one very long sentence', () => {
    const long =
      Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + ', and finally the end.';
    const chunks = splitTextForSpeech(long, { maxChars: 50 });
    expect(chunks.join(' ')).toBe(normalise(long));
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(50);
  });

  it('hard-splits a single word longer than the limit', () => {
    const chunks = splitTextForSpeech('x'.repeat(25), { maxChars: 10 });
    expect(chunks).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });

  it('respects a byte limit for multi-byte text', () => {
    const text = 'Ünïcödé façade naïve café. '.repeat(20);
    const chunks = splitTextForSpeech(text, { maxBytes: 120 });
    for (const chunk of chunks) expect(bytes(chunk)).toBeLessThanOrEqual(120);
    expect(chunks.join(' ')).toBe(normalise(text));
  });

  it('returns nothing for blank text', () => {
    expect(splitTextForSpeech('   \n ', { maxChars: 10 })).toEqual([]);
  });

  it('requires a limit', () => {
    expect(() => splitTextForSpeech('a', {})).toThrow();
  });
});
