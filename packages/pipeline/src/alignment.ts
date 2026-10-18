import type { CharacterAlignment, TimedWord } from './roles';
import { normalizeForMatch } from './text';

const ms = (seconds: number) => Math.round(seconds * 1000);

/** ElevenLabs character timings → words (runs of non-whitespace), with monotonic times. */
export const charsToWords = (alignment: CharacterAlignment, offsetMs = 0): TimedWord[] => {
  const { characters, startTimesSeconds, endTimesSeconds } = alignment;
  if (
    characters.length !== startTimesSeconds.length ||
    characters.length !== endTimesSeconds.length
  ) {
    throw new Error('Character alignment arrays must have the same length.');
  }
  const words: TimedWord[] = [];
  let text = '';
  let start = 0;
  let end = 0;
  const flush = () => {
    if (!text) return;
    const prevEnd = words.at(-1)?.endMs ?? 0;
    const s = Math.max(start + offsetMs, prevEnd);
    words.push({ text, startMs: s, endMs: Math.max(end + offsetMs, s) });
    text = '';
  };
  characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      flush();
      return;
    }
    const charStart = ms(startTimesSeconds[i]!);
    const charEnd = ms(endTimesSeconds[i]!);
    if (!text) {
      start = charStart;
      end = charEnd;
    } else {
      end = Math.max(end, charEnd);
    }
    text += ch;
  });
  flush();
  return words;
};

const matchKey = (token: string) => normalizeForMatch(token).replace(/ /g, '');

export type ScriptAlignment = { words: TimedWord[]; matchRatio: number };

/**
 * Forced-alignment transcripts spell things their own way ("nineteen sixty-nine", fillers). This
 * maps their timings onto the script's own words with a longest-common-subsequence alignment;
 * unmatched script words are spread over the gaps between matched ones, by length.
 */
export const alignWordsToScript = (
  scriptText: string,
  transcript: readonly TimedWord[],
  durationMs: number,
): ScriptAlignment => {
  const scriptTokens = scriptText.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
  const a = scriptTokens.map(matchKey);
  const b = transcript.map((w) => matchKey(w.text));
  const n = a.length;
  const m = b.length;

  // LCS table (n+1)×(m+1), filled from the end so we can walk forward.
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] !== '' && a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const matchedTo: Array<number | null> = new Array(n).fill(null);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] !== '' && a[i] === b[j]) {
      matchedTo[i] = j;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }

  const out: TimedWord[] = scriptTokens.map((text) => ({ text, startMs: 0, endMs: 0 }));
  matchedTo.forEach((j, i) => {
    if (j !== null)
      out[i] = {
        text: scriptTokens[i]!,
        startMs: transcript[j]!.startMs,
        endMs: transcript[j]!.endMs,
      };
  });

  // Fill runs of unmatched words between anchors (or the audio edges), proportional to length.
  let i = 0;
  while (i < n) {
    if (matchedTo[i] !== null) {
      i++;
      continue;
    }
    const runStart = i;
    while (i < n && matchedTo[i] === null) i++;
    const from = runStart === 0 ? 0 : out[runStart - 1]!.endMs;
    const to = i === n ? durationMs : out[i]!.startMs;
    const span = Math.max(0, to - from);
    const weights = scriptTokens.slice(runStart, i).map((t) => Math.max(1, t.length));
    const total = weights.reduce((s, w) => s + w, 0);
    let cursor = from;
    weights.forEach((w, k) => {
      const next = k === weights.length - 1 ? from + span : cursor + (span * w) / total;
      out[runStart + k] = {
        text: scriptTokens[runStart + k]!,
        startMs: Math.round(cursor),
        endMs: Math.round(next),
      };
      cursor = next;
    });
  }

  // Monotonic, non-overlapping.
  for (let k = 0; k < out.length; k++) {
    const prevEnd = k === 0 ? 0 : out[k - 1]!.endMs;
    const startMs = Math.max(out[k]!.startMs, prevEnd);
    out[k] = { ...out[k]!, startMs, endMs: Math.max(out[k]!.endMs, startMs) };
  }

  const matched = matchedTo.filter((j) => j !== null).length;
  return { words: out, matchRatio: n === 0 ? 0 : matched / n };
};

/** When the narration rate is unlocked, every timing scales with it so captions stay in sync. */
export const rescaleTimings = (words: readonly TimedWord[], rate: number): TimedWord[] => {
  if (!(rate > 0)) throw new RangeError('Playback rate must be positive.');
  if (rate === 1) return words.map((w) => ({ ...w }));
  return words.map((w) => ({
    ...w,
    startMs: Math.round(w.startMs / rate),
    endMs: Math.round(w.endMs / rate),
  }));
};
