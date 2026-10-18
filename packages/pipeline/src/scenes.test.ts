import { describe, expect, it } from 'vitest';
import type { TimedWord } from './roles';
import { MIN_SCENE_MS, sceneSpans } from './scenes';

const words = (n: number, start = 0, step = 300, len = 250): TimedWord[] =>
  Array.from({ length: n }, (_, i) => ({
    text: `w${i}`,
    startMs: start + i * step,
    endMs: start + i * step + len,
  }));

describe('sceneSpans: scene timing is pure arithmetic from word timestamps', () => {
  it('cuts in the middle of the pause between scenes and covers 0..duration', () => {
    const w = words(6); // w2 ends 850, w3 starts 900
    const spans = sceneSpans({ sceneWordCounts: [3, 3], words: w, durationMs: 2000 });
    expect(spans).toEqual([
      { startMs: 0, endMs: 875, sceneIndexes: [0], wordRange: [0, 3] },
      { startMs: 875, endMs: 2000, sceneIndexes: [1], wordRange: [3, 6] },
    ]);
  });

  it('cuts at the next word when words overlap', () => {
    const w: TimedWord[] = [
      { text: 'a', startMs: 0, endMs: 1000 },
      { text: 'b', startMs: 900, endMs: 1800 },
    ];
    const spans = sceneSpans({ sceneWordCounts: [1, 1], words: w, durationMs: 2000 });
    expect(spans[0]!.endMs).toBe(900);
  });

  it('returns whole milliseconds, contiguous and increasing', () => {
    const w: TimedWord[] = [
      { text: 'a', startMs: 0, endMs: 333.3 },
      { text: 'b', startMs: 1000.7, endMs: 1300 },
      { text: 'c', startMs: 2000.2, endMs: 2600 },
    ];
    const spans = sceneSpans({ sceneWordCounts: [1, 1, 1], words: w, durationMs: 3000 });
    spans.forEach((s, i) => {
      expect(Number.isInteger(s.startMs) && Number.isInteger(s.endMs)).toBe(true);
      expect(s.endMs).toBeGreaterThan(s.startMs);
      if (i > 0) expect(s.startMs).toBe(spans[i - 1]!.endMs);
    });
    expect(spans.at(-1)!.endMs).toBe(3000);
  });

  it('merges a scene shorter than the minimum into its shorter neighbour', () => {
    const w: TimedWord[] = [
      { text: 'a', startMs: 0, endMs: 2000 },
      { text: 'b', startMs: 2050, endMs: 2200 }, // a 0.2 s scene
      { text: 'c', startMs: 2250, endMs: 5000 },
      { text: 'd', startMs: 5050, endMs: 9000 },
    ];
    const spans = sceneSpans({ sceneWordCounts: [1, 1, 1, 1], words: w, durationMs: 9000 });
    expect(spans).toHaveLength(3);
    expect(spans.every((s) => s.endMs - s.startMs >= MIN_SCENE_MS)).toBe(true);
    expect(spans.flatMap((s) => s.sceneIndexes)).toEqual([0, 1, 2, 3]);
  });

  it('merges a scene with no words into the next one', () => {
    const spans = sceneSpans({ sceneWordCounts: [2, 0, 2], words: words(4), durationMs: 1500 });
    expect(spans.map((s) => s.sceneIndexes)).toEqual([[0], [1, 2]]);
  });

  it('keeps a single scene for a one-scene script', () => {
    expect(sceneSpans({ sceneWordCounts: [4], words: words(4), durationMs: 1200 })).toEqual([
      { startMs: 0, endMs: 1200, sceneIndexes: [0], wordRange: [0, 4] },
    ]);
  });

  it('rejects word counts that do not add up', () => {
    expect(() =>
      sceneSpans({ sceneWordCounts: [2, 2], words: words(3), durationMs: 1000 }),
    ).toThrow(/word/);
  });

  it('rejects a duration shorter than the speech', () => {
    expect(() => sceneSpans({ sceneWordCounts: [2], words: words(2), durationMs: 100 })).toThrow(
      /duration/,
    );
  });

  it('takes no style input at all, so animation speed cannot move a boundary', () => {
    expect(sceneSpans.length).toBe(1);
    const spans = sceneSpans({ sceneWordCounts: [3, 3], words: words(6), durationMs: 2000 });
    expect(Object.keys(spans[0]!).sort()).toEqual([
      'endMs',
      'sceneIndexes',
      'startMs',
      'wordRange',
    ]);
  });
});
