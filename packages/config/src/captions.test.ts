import { parseSrt } from '@remotion/captions';
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_DEFAULTS,
  groupCaptions,
  layoutLines,
  toSrt,
  wordsToCaptions,
  type WordTiming,
} from './index';

const words = (spec: [string, number, number][]): WordTiming[] =>
  spec.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));

const sentence = words([
  ['The', 0, 200],
  ['Apollo', 220, 600],
  ['program', 620, 1000],
  ['landed', 1020, 1400],
  ['twelve', 1420, 1800],
  ['people', 1820, 2200],
  ['on', 2220, 2350],
  ['the', 2370, 2500],
  ['Moon.', 2520, 3000],
]);

const opts = (patch: Partial<typeof SCHEMA_DEFAULTS.captions> = {}) => ({
  ...SCHEMA_DEFAULTS.captions,
  ...patch,
});

describe('wordsToCaptions', () => {
  it('adds the leading space Remotion uses to detect word starts, except on the first word', () => {
    const captions = wordsToCaptions(sentence.slice(0, 3));
    expect(captions.map((c) => c.text)).toEqual(['The', ' Apollo', ' program']);
    expect(captions[1]).toMatchObject({ startMs: 220, endMs: 600, confidence: null });
  });

  it('sorts out-of-order words and repairs negative durations', () => {
    const captions = wordsToCaptions(
      words([
        ['b', 500, 400],
        ['a', 0, 300],
      ]),
    );
    expect(captions.map((c) => [c.text.trim(), c.startMs, c.endMs])).toEqual([
      ['a', 0, 300],
      ['b', 500, 500],
    ]);
  });

  it('drops empty and whitespace-only words', () => {
    expect(
      wordsToCaptions(
        words([
          ['  ', 0, 10],
          ['ok', 10, 20],
        ]),
      ).map((c) => c.text),
    ).toEqual(['ok']);
  });
});

describe('groupCaptions (createTikTokStyleCaptions)', () => {
  it('puts every word on its own page when combining is 0 ms', () => {
    const pages = groupCaptions(
      sentence,
      opts({ combineTokensWithinMilliseconds: 0, breakOnSilenceAfterMilliseconds: null }),
    );
    expect(pages.map((p) => p.text)).toEqual(sentence.map((w) => w.text));
  });

  it('combines more words per page as the window grows', () => {
    const few = groupCaptions(
      sentence,
      opts({
        combineTokensWithinMilliseconds: 400,
        breakOnSilenceAfterMilliseconds: null,
        maxCharsPerLine: 80,
        maxLines: 4,
      }),
    );
    const many = groupCaptions(
      sentence,
      opts({
        combineTokensWithinMilliseconds: 2000,
        breakOnSilenceAfterMilliseconds: null,
        maxCharsPerLine: 80,
        maxLines: 4,
      }),
    );
    expect(many.length).toBeLessThan(few.length);
    for (const page of [...few, ...many]) {
      expect(page.text).not.toMatch(/^\s|\s$|\s{2}/);
    }
  });

  it('breaks a page on silence even when the combine window is large', () => {
    const withPause = words([
      ['First', 0, 300],
      ['part', 320, 600],
      ['after', 1700, 2000],
      ['pause', 2020, 2300],
    ]);
    const pages = groupCaptions(
      withPause,
      opts({
        combineTokensWithinMilliseconds: 5000,
        breakOnSilenceAfterMilliseconds: 500,
        maxCharsPerLine: 80,
      }),
    );
    expect(pages.map((p) => p.text)).toEqual(['First part', 'after pause']);
  });

  it('never lets a page exceed maxCharsPerLine × maxLines', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({
      text: `word${i}`,
      startMs: i * 100,
      endMs: i * 100 + 90,
    }));
    const pages = groupCaptions(
      long,
      opts({
        combineTokensWithinMilliseconds: 5000,
        breakOnSilenceAfterMilliseconds: null,
        maxCharsPerLine: 16,
        maxLines: 2,
      }),
    );
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.text.length).toBeLessThanOrEqual(32);
    }
    expect(pages.flatMap((p) => p.tokens.map((t) => t.text.trim()))).toEqual(
      long.map((w) => w.text),
    );
  });

  it('keeps a single word longer than the cap on a page of its own', () => {
    const pages = groupCaptions(
      words([
        ['a', 0, 100],
        ['supercalifragilisticexpialidocious', 120, 900],
        ['b', 920, 1000],
      ]),
      opts({
        combineTokensWithinMilliseconds: 5000,
        breakOnSilenceAfterMilliseconds: null,
        maxCharsPerLine: 8,
        maxLines: 1,
      }),
    );
    expect(pages.map((p) => p.text)).toEqual(['a', 'supercalifragilisticexpialidocious', 'b']);
  });

  it('gives pages contiguous timing that ends at the last word', () => {
    const pages = groupCaptions(
      sentence,
      opts({ combineTokensWithinMilliseconds: 800, breakOnSilenceAfterMilliseconds: null }),
    );
    for (let i = 0; i < pages.length - 1; i++) {
      expect(pages[i]!.startMs + pages[i]!.durationMs).toBe(pages[i + 1]!.startMs);
    }
    const last = pages.at(-1)!;
    expect(last.startMs + last.durationMs).toBe(3000);
  });

  it('never lets a page run across the end of a sentence', () => {
    const two = words([
      ['It', 0, 100],
      ['landed.', 120, 400],
      ['Crowds', 420, 700],
      ['cheered!', 720, 1000],
      ['Then?', 1020, 1300],
      ['Silence', 1320, 1600],
    ]);
    const pages = groupCaptions(
      two,
      opts({
        combineTokensWithinMilliseconds: 5000,
        breakOnSilenceAfterMilliseconds: null,
        maxCharsPerLine: 80,
        maxLines: 4,
      }),
    );
    expect(pages.map((p) => p.text)).toEqual(['It landed.', 'Crowds cheered!', 'Then?', 'Silence']);
  });

  describe('orphan words', () => {
    // At 1.2 s per page, "story." starts outside the window and would sit alone on screen.
    const story = (gapBeforeLastMs = 20) =>
      words([
        ['Scene', 0, 300],
        ['one', 320, 600],
        ['tells', 620, 900],
        ['the', 920, 1050],
        ['Apollo', 1070, 1240],
        ['story.', 1240 + gapBeforeLastMs, 1600 + gapBeforeLastMs],
      ]);
    const window = opts({
      combineTokensWithinMilliseconds: 1200,
      breakOnSilenceAfterMilliseconds: 700,
    });

    it('keeps the last word of a sentence with its sentence instead of alone on a page', () => {
      const pages = groupCaptions(story(), window);
      expect(pages.map((p) => p.text)).toEqual(['Scene one tells the Apollo story.']);
      expect(pages[0]).toMatchObject({ startMs: 0, durationMs: 1620 });
      expect(pages[0]!.tokens.map((t) => t.text)).toEqual([
        'Scene',
        ' one',
        ' tells',
        ' the',
        ' Apollo',
        ' story.',
      ]);
    });

    it('leaves the word alone after a pause long enough to start a new page', () => {
      expect(groupCaptions(story(800), window).map((p) => p.text)).toEqual([
        'Scene one tells the Apollo',
        'story.',
      ]);
    });

    it('leaves the word alone when the joined page would not fit the caption box', () => {
      const narrow = { ...window, maxCharsPerLine: 13, maxLines: 2 };
      expect(groupCaptions(story(), narrow).map((p) => p.text)).toEqual([
        'Scene one tells the Apollo',
        'story.',
      ]);
    });

    it('never pulls a one-word sentence into the sentence before it', () => {
      const pages = groupCaptions(
        words([
          ['It', 0, 100],
          ['landed.', 120, 400],
          ['Wow.', 420, 700],
        ]),
        opts({ combineTokensWithinMilliseconds: 5000, breakOnSilenceAfterMilliseconds: null }),
      );
      expect(pages.map((p) => p.text)).toEqual(['It landed.', 'Wow.']);
    });
  });

  it('returns no pages for no words', () => {
    expect(groupCaptions([], opts())).toEqual([]);
  });
});

describe('layoutLines', () => {
  it('wraps a page into lines no longer than the cap', () => {
    const [page] = groupCaptions(
      sentence,
      opts({
        combineTokensWithinMilliseconds: 5000,
        breakOnSilenceAfterMilliseconds: null,
        maxCharsPerLine: 20,
        maxLines: 3,
      }),
    );
    const lines = layoutLines(page!, 20);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.map((t) => t.text.trim()).join(' ').length).toBeLessThanOrEqual(20);
    }
  });
});

describe('toSrt (the .srt is always written)', () => {
  it('produces numbered cues with SRT timestamps that @remotion/captions can parse back', () => {
    const pages = groupCaptions(
      sentence,
      opts({ combineTokensWithinMilliseconds: 800, breakOnSilenceAfterMilliseconds: null }),
    );
    const srt = toSrt(pages);
    expect(srt.startsWith('1\n00:00:00,000 --> ')).toBe(true);
    const { captions } = parseSrt({ input: srt });
    expect(captions).toHaveLength(pages.length);
    expect(captions.map((c) => c.text.trim())).toEqual(pages.map((p) => p.text));
    expect(captions.at(-1)!.endMs).toBe(3000);
  });

  it('formats hours, minutes and milliseconds', () => {
    const srt = toSrt(groupCaptions(words([['late', 3_725_042, 3_726_500]]), opts()));
    expect(srt).toContain('01:02:05,042 --> 01:02:06,500');
  });

  it('is empty when there are no captions', () => {
    expect(toSrt([])).toBe('');
  });
});
