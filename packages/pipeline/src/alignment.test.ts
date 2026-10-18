import { describe, expect, it } from 'vitest';
import { alignWordsToScript, charsToWords, rescaleTimings } from './alignment';
import type { CharacterAlignment, TimedWord } from './roles';

const alignmentFor = (text: string, msPerChar = 50, startMs = 0): CharacterAlignment => {
  const characters = [...text];
  return {
    characters,
    startTimesSeconds: characters.map((_, i) => (startMs + i * msPerChar) / 1000),
    endTimesSeconds: characters.map((_, i) => (startMs + (i + 1) * msPerChar) / 1000),
  };
};

describe('charsToWords (ElevenLabs character timings → word timings)', () => {
  it('groups characters between spaces into words', () => {
    const words = charsToWords(alignmentFor('Hi there.'));
    expect(words).toEqual([
      { text: 'Hi', startMs: 0, endMs: 100 },
      { text: 'there.', startMs: 150, endMs: 450 },
    ]);
  });

  it('handles repeated spaces, newlines and leading/trailing whitespace', () => {
    const words = charsToWords(alignmentFor('  One\n\ntwo   three '));
    expect(words.map((w) => w.text)).toEqual(['One', 'two', 'three']);
    expect(words[0]!.startMs).toBe(100);
  });

  it('shifts by an offset when chunks are concatenated', () => {
    expect(charsToWords(alignmentFor('Go'), 2000)[0]).toEqual({
      text: 'Go',
      startMs: 2000,
      endMs: 2100,
    });
  });

  it('returns nothing for empty input', () => {
    expect(charsToWords({ characters: [], startTimesSeconds: [], endTimesSeconds: [] })).toEqual(
      [],
    );
  });

  it('rejects mismatched arrays', () => {
    expect(() =>
      charsToWords({ characters: ['a', 'b'], startTimesSeconds: [0], endTimesSeconds: [0.1, 0.2] }),
    ).toThrow(/length/);
  });

  it('repairs non-monotonic character timings', () => {
    const a: CharacterAlignment = {
      characters: ['a', 'b', ' ', 'c'],
      startTimesSeconds: [0, 0.2, 0.3, 0.1],
      endTimesSeconds: [0.1, 0.25, 0.35, 0.15],
    };
    const words = charsToWords(a);
    expect(words[1]!.startMs).toBeGreaterThanOrEqual(words[0]!.endMs);
    expect(words[1]!.endMs).toBeGreaterThanOrEqual(words[1]!.startMs);
  });
});

const timed = (spec: [string, number, number][]): TimedWord[] =>
  spec.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));

describe('alignWordsToScript (forced-alignment transcript → the script’s own words)', () => {
  it('copies times onto identical words and keeps script punctuation', () => {
    const result = alignWordsToScript(
      'The Moon landing, 1969.',
      timed([
        ['the', 0, 100],
        ['moon', 120, 300],
        ['landing', 320, 700],
        ['1969', 720, 1500],
      ]),
      1600,
    );
    expect(result.matchRatio).toBe(1);
    expect(result.words).toEqual(
      timed([
        ['The', 0, 100],
        ['Moon', 120, 300],
        ['landing,', 320, 700],
        ['1969.', 720, 1500],
      ]),
    );
  });

  it('interpolates script words the transcript spelled differently', () => {
    const result = alignWordsToScript(
      'It was 1969 and Apollo flew.',
      timed([
        ['it', 0, 100],
        ['was', 110, 200],
        ['nineteen', 210, 500],
        ['sixty', 510, 700],
        ['nine', 710, 900],
        ['and', 910, 1000],
        ['apollo', 1010, 1400],
        ['flew', 1410, 1700],
      ]),
      1800,
    );
    const year = result.words.find((w) => w.text === '1969')!;
    expect(year.startMs).toBeGreaterThanOrEqual(200);
    expect(year.endMs).toBeLessThanOrEqual(910);
    expect(result.matchRatio).toBeCloseTo(5 / 6, 5);
  });

  it('ignores filler words the speaker added', () => {
    const result = alignWordsToScript(
      'We went to the Moon.',
      timed([
        ['we', 0, 100],
        ['um', 110, 300],
        ['went', 310, 500],
        ['to', 510, 600],
        ['uh', 610, 700],
        ['the', 710, 800],
        ['moon', 810, 1200],
      ]),
      1300,
    );
    expect(result.matchRatio).toBe(1);
    expect(result.words.map((w) => w.startMs)).toEqual([0, 310, 510, 710, 810]);
  });

  it('spreads leading and trailing unmatched words over the audio edges', () => {
    const result = alignWordsToScript(
      'Hello brave new world',
      timed([
        ['brave', 500, 800],
        ['new', 810, 1000],
      ]),
      2000,
    );
    expect(result.words[0]!.startMs).toBe(0);
    expect(result.words[0]!.endMs).toBeLessThanOrEqual(500);
    expect(result.words.at(-1)!.startMs).toBeGreaterThanOrEqual(1000);
    expect(result.words.at(-1)!.endMs).toBeLessThanOrEqual(2000);
  });

  it('falls back to spreading words over the audio by length when there is no transcript', () => {
    const result = alignWordsToScript('one two six ten', [], 4000);
    expect(result.matchRatio).toBe(0);
    expect(result.words.map((w) => w.startMs)).toEqual([0, 1000, 2000, 3000]);
    expect(result.words.at(-1)!.endMs).toBe(4000);
    const weighted = alignWordsToScript('a abcdefg', [], 800);
    expect(weighted.words[1]!.endMs - weighted.words[1]!.startMs).toBe(700);
  });

  it('always returns monotonic, non-overlapping times', () => {
    const result = alignWordsToScript(
      'a b c d e f g',
      timed([
        ['a', 0, 100],
        ['c', 90, 200],
        ['b', 150, 250],
        ['e', 400, 380],
        ['g', 600, 700],
      ]),
      800,
    );
    for (let i = 1; i < result.words.length; i++) {
      expect(result.words[i]!.startMs).toBeGreaterThanOrEqual(result.words[i - 1]!.endMs);
      expect(result.words[i]!.endMs).toBeGreaterThanOrEqual(result.words[i]!.startMs);
    }
  });
});

describe('rescaleTimings (unlocked narration rate)', () => {
  it('divides every time by the rate', () => {
    expect(rescaleTimings(timed([['a', 1000, 2000]]), 2)).toEqual(timed([['a', 500, 1000]]));
    expect(rescaleTimings(timed([['a', 1000, 2000]]), 0.5)).toEqual(timed([['a', 2000, 4000]]));
  });

  it('is a no-op at 1.0', () => {
    const w = timed([['a', 1, 2]]);
    expect(rescaleTimings(w, 1)).toEqual(w);
  });

  it('rejects a non-positive rate', () => {
    expect(() => rescaleTimings([], 0)).toThrow(RangeError);
  });
});
