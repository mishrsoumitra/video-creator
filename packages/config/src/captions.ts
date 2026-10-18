import { createTikTokStyleCaptions, serializeSrt, type Caption } from '@remotion/captions';
import type { CaptionsConfig } from './schema';
import type { WordTiming } from './plan';

export type CaptionToken = { text: string; fromMs: number; toMs: number };
export type CaptionPage = {
  text: string;
  startMs: number;
  durationMs: number;
  tokens: CaptionToken[];
};

const SENTENCE_END = /[.!?…]["”’)\]]*$/;
const NOT_AN_END = /^(mr|mrs|ms|dr|prof|st|vs|etc|e\.g|i\.e|u\.s|u\.k|\p{L})\.$/iu;

/** True when a word closes a sentence, so a caption page should end with it. */
const endsSentence = (word: string) => SENTENCE_END.test(word) && !NOT_AN_END.test(word);

/**
 * Word timings → Remotion captions. createTikTokStyleCaptions only starts a new page on a token
 * that begins with a space, so every word except the first gets one; a word that ends a sentence
 * gets pageBreakAfter so no page runs across two sentences.
 */
export const wordsToCaptions = (words: readonly WordTiming[]): Caption[] =>
  words
    .filter((w) => w.text.trim().length > 0)
    .map((w, order) => ({ w, order }))
    .sort((a, b) => a.w.startMs - b.w.startMs || a.order - b.order)
    .map(({ w }, i) => ({
      text: (i === 0 ? '' : ' ') + w.text.trim(),
      startMs: w.startMs,
      endMs: Math.max(w.endMs, w.startMs),
      timestampMs: null,
      confidence: w.confidence ?? null,
      ...(endsSentence(w.text.trim()) ? { pageBreakAfter: true } : {}),
    }));

const pageText = (tokens: readonly CaptionToken[]) => tokens.map((t) => t.text.trim()).join(' ');

type GroupingOptions = Pick<
  CaptionsConfig,
  | 'combineTokensWithinMilliseconds'
  | 'breakOnSilenceAfterMilliseconds'
  | 'maxCharsPerLine'
  | 'maxLines'
>;

/** Groups words into caption pages, then splits any page longer than maxCharsPerLine × maxLines. */
export const groupCaptions = (
  words: readonly WordTiming[],
  options: GroupingOptions,
): CaptionPage[] => {
  const captions = wordsToCaptions(words);
  if (captions.length === 0) return [];
  const { pages } = createTikTokStyleCaptions({
    captions,
    combineTokensWithinMilliseconds: options.combineTokensWithinMilliseconds,
    ...(options.breakOnSilenceAfterMilliseconds === null
      ? {}
      : { breakOnSilenceAfterMilliseconds: options.breakOnSilenceAfterMilliseconds }),
  });
  const cap = options.maxCharsPerLine * options.maxLines;
  const out: CaptionPage[] = [];
  for (const page of pages) {
    const pageEnd = page.startMs + page.durationMs;
    const chunks: CaptionToken[][] = [];
    let current: CaptionToken[] = [];
    for (const token of page.tokens) {
      const candidate = [...current, token];
      if (current.length > 0 && pageText(candidate).length > cap) {
        chunks.push(current);
        current = [token];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) chunks.push(current);
    chunks.forEach((chunk, i) => {
      const startMs = i === 0 ? page.startMs : chunk[0]!.fromMs;
      const endMs = i + 1 < chunks.length ? chunks[i + 1]![0]!.fromMs : pageEnd;
      out.push({
        text: pageText(chunk),
        startMs,
        durationMs: endMs - startMs,
        tokens: chunk.map((t, j) => ({ ...t, text: j === 0 ? t.text.trimStart() : t.text })),
      });
    });
  }
  return joinSentenceEndOrphans(out, options, cap);
};

/**
 * A sentence's last word that starts just outside the combine window would sit alone on screen
 * ("story."). It rejoins its sentence's page, unless a real pause came first or it would not fit.
 * Word-by-word grouping (one-word pages before it) is left as it is.
 */
const joinSentenceEndOrphans = (
  pages: readonly CaptionPage[],
  options: GroupingOptions,
  cap: number,
): CaptionPage[] => {
  const out: CaptionPage[] = [];
  for (const page of pages) {
    const prev = out.at(-1);
    const word = page.tokens.length === 1 ? page.tokens[0] : undefined;
    const before = prev && prev.tokens.length > 1 ? prev.tokens.at(-1) : undefined;
    if (
      prev &&
      word &&
      before &&
      endsSentence(word.text.trim()) &&
      !endsSentence(before.text.trim())
    ) {
      const silence = options.breakOnSilenceAfterMilliseconds;
      const paused = silence !== null && word.fromMs - before.toMs >= silence;
      const tokens = [...prev.tokens, { ...word, text: ` ${word.text.trimStart()}` }];
      if (!paused && pageText(tokens).length <= cap) {
        out[out.length - 1] = {
          ...prev,
          text: pageText(tokens),
          durationMs: page.startMs + page.durationMs - prev.startMs,
          tokens,
        };
        continue;
      }
    }
    out.push(page);
  }
  return out;
};

/** Greedy line layout of a page for display. */
export const layoutLines = (page: CaptionPage, maxCharsPerLine: number): CaptionToken[][] => {
  const lines: CaptionToken[][] = [];
  let current: CaptionToken[] = [];
  for (const token of page.tokens) {
    const candidate = [...current, token];
    if (current.length > 0 && pageText(candidate).length > maxCharsPerLine) {
      lines.push(current);
      current = [token];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
};

/** SRT text for the pages; written for every job whether or not captions are burned in. */
export const toSrt = (pages: readonly CaptionPage[]): string =>
  pages.length === 0
    ? ''
    : serializeSrt({
        lines: pages.map((page) =>
          page.tokens.map((t, i) => ({
            text: i === 0 ? t.text.trimStart() : t.text,
            startMs: t.fromMs,
            endMs: t.toMs,
            timestampMs: null,
            confidence: null,
          })),
        ),
      });
