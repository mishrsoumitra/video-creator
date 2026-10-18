import type { TimedWord } from './roles';

/** Scenes shorter than this flicker; they are merged into a neighbour. */
export const MIN_SCENE_MS = 500;
/** Word timestamps may run slightly past the decoded audio; anything more is an error. */
const DURATION_SLACK_MS = 250;

export type SceneSpanResult = {
  startMs: number;
  endMs: number;
  /** Script scenes shown in this span (several after a merge). */
  sceneIndexes: number[];
  /** Words [from, to) spoken in this span. */
  wordRange: [number, number];
};

/**
 * Scene boundaries from the voice, by arithmetic only: each cut sits in the middle of the pause
 * between the last word of one scene and the first word of the next. Takes no style config, so
 * nothing about animation can move a boundary.
 */
export const sceneSpans = ({
  sceneWordCounts,
  words,
  durationMs,
}: {
  sceneWordCounts: readonly number[];
  words: readonly TimedWord[];
  durationMs: number;
}): SceneSpanResult[] => {
  const total = sceneWordCounts.reduce((s, c) => s + c, 0);
  if (total !== words.length)
    throw new Error(
      `Scene word counts add up to ${total}, but there are ${words.length} timed words.`,
    );
  if (sceneWordCounts.length === 0) throw new Error('A script needs at least one scene.');
  const lastEnd = words.at(-1)?.endMs ?? 0;
  if (lastEnd > durationMs + DURATION_SLACK_MS)
    throw new Error(`Words end at ${lastEnd} ms, after the audio duration of ${durationMs} ms.`);

  // Group scenes that have words; a scene without words joins the next scene with words.
  const groups: Array<{ sceneIndexes: number[]; from: number; to: number }> = [];
  let pending: number[] = [];
  let cursor = 0;
  sceneWordCounts.forEach((count, sceneIndex) => {
    if (count === 0) {
      pending.push(sceneIndex);
      return;
    }
    groups.push({ sceneIndexes: [...pending, sceneIndex], from: cursor, to: cursor + count });
    pending = [];
    cursor += count;
  });
  if (groups.length === 0)
    return [
      { startMs: 0, endMs: Math.round(durationMs), sceneIndexes: [...pending], wordRange: [0, 0] },
    ];
  if (pending.length > 0) groups.at(-1)!.sceneIndexes.push(...pending);

  const cutBetween = (left: { to: number }, right: { from: number }) => {
    const lastWord = words[left.to - 1]!;
    const nextWord = words[right.from]!;
    return lastWord.endMs >= nextWord.startMs
      ? nextWord.startMs
      : (lastWord.endMs + nextWord.startMs) / 2;
  };

  let spans: SceneSpanResult[] = groups.map((g, i) => ({
    startMs: i === 0 ? 0 : Math.round(cutBetween(groups[i - 1]!, g)),
    endMs:
      i === groups.length - 1 ? Math.round(durationMs) : Math.round(cutBetween(g, groups[i + 1]!)),
    sceneIndexes: g.sceneIndexes,
    wordRange: [g.from, g.to],
  }));

  // Merge spans that are too short into their shorter neighbour, shortest first.
  for (;;) {
    if (spans.length < 2) break;
    let shortest = -1;
    spans.forEach((s, i) => {
      if (
        s.endMs - s.startMs < MIN_SCENE_MS &&
        (shortest === -1 || s.endMs - s.startMs < spans[shortest]!.endMs - spans[shortest]!.startMs)
      ) {
        shortest = i;
      }
    });
    if (shortest === -1) break;
    const left = spans[shortest - 1];
    const right = spans[shortest + 1];
    const into = !left
      ? shortest + 1
      : !right
        ? shortest - 1
        : left.endMs - left.startMs <= right.endMs - right.startMs
          ? shortest - 1
          : shortest + 1;
    const [a, b] =
      into < shortest ? [spans[into]!, spans[shortest]!] : [spans[shortest]!, spans[into]!];
    const merged: SceneSpanResult = {
      startMs: a.startMs,
      endMs: b.endMs,
      sceneIndexes: [...a.sceneIndexes, ...b.sceneIndexes],
      wordRange: [a.wordRange[0], b.wordRange[1]],
    };
    const lo = Math.min(into, shortest);
    spans = [...spans.slice(0, lo), merged, ...spans.slice(lo + 2)];
  }
  return spans;
};
