import { groupCaptions, SCHEMA_DEFAULTS } from '@vc/config';
import { describe, expect, it } from 'vitest';
import { cardEntersAfterPause, chooseCaptionLayout, LINE_HEIGHT } from './caption-layout';

/** A monospace stand-in for measureText: 0.6 em per character. */
const width100 = (text: string) => text.length * 60;

const pageOf = (text: string) =>
  groupCaptions(
    text.split(' ').map((w, i) => ({ text: w, startMs: i * 300, endMs: i * 300 + 250 })),
    {
      ...SCHEMA_DEFAULTS.captions,
      combineTokensWithinMilliseconds: 5000,
      breakOnSilenceAfterMilliseconds: null,
      maxCharsPerLine: 80,
      maxLines: 4,
    },
  )[0]!;

const box = { width: 1000, height: 300 };

describe('cardEntersAfterPause', () => {
  const pages = groupCaptions(
    [
      { text: 'One.', startMs: 0, endMs: 400 },
      { text: 'Two.', startMs: 500, endMs: 900 },
      { text: 'Three.', startMs: 2000, endMs: 2400 },
    ],
    { ...SCHEMA_DEFAULTS.captions, breakOnSilenceAfterMilliseconds: null },
  );

  it('animates the first card in', () => {
    expect(cardEntersAfterPause(pages, 0)).toBe(true);
  });

  it('swaps text without re-animating during continuous speech', () => {
    expect(cardEntersAfterPause(pages, 1)).toBe(false);
  });

  it('animates in again after a real pause', () => {
    expect(cardEntersAfterPause(pages, 2)).toBe(true);
  });
});

describe('chooseCaptionLayout: text-fit so nothing overflows', () => {
  it('uses the configured size when the text fits', () => {
    const l = chooseCaptionLayout({
      page: pageOf('short line'),
      width100,
      box,
      maxCharsPerLine: 32,
      maxLines: 2,
      fitMode: 'shrink',
      maxSize: 64,
      minSize: 30,
    });
    expect(l.fontSize).toBe(64);
    expect(l.overflowPx).toBe(0);
    expect(l.lines).toHaveLength(1);
  });

  it('shrinks to fit the widest line', () => {
    const l = chooseCaptionLayout({
      page: pageOf('a fairly long line of caption text'),
      width100,
      box,
      maxCharsPerLine: 40,
      maxLines: 2,
      fitMode: 'shrink',
      maxSize: 64,
      minSize: 20,
    });
    expect(l.fontSize).toBeLessThan(64);
    expect(
      Math.max(
        ...l.lines.map(
          (line) => width100(line.map((t) => t.text.trim()).join(' ')) * (l.fontSize / 100),
        ),
      ),
    ).toBeLessThanOrEqual(box.width + 0.5);
    expect(l.overflowPx).toBe(0);
  });

  it('respects the box height', () => {
    const l = chooseCaptionLayout({
      page: pageOf('one two three four five six seven eight'),
      width100,
      box: { width: 1000, height: 100 },
      maxCharsPerLine: 10,
      maxLines: 4,
      fitMode: 'shrink',
      maxSize: 64,
      minSize: 10,
    });
    expect(l.fontSize * LINE_HEIGHT * l.lines.length).toBeLessThanOrEqual(100 + 0.5);
  });

  it('never goes below the minimum size and reports the overflow instead', () => {
    const l = chooseCaptionLayout({
      page: pageOf('supercalifragilisticexpialidocious'),
      width100,
      box: { width: 400, height: 300 },
      maxCharsPerLine: 40,
      maxLines: 2,
      fitMode: 'shrink',
      maxSize: 64,
      minSize: 30,
    });
    expect(l.fontSize).toBe(30);
    expect(l.overflowPx).toBeGreaterThan(0);
  });

  it('wraps onto more lines in wrap mode before giving up', () => {
    const page = pageOf('this caption is long enough to need wrapping to fit nicely');
    const shrink = chooseCaptionLayout({
      page,
      width100,
      box,
      maxCharsPerLine: 60,
      maxLines: 1,
      fitMode: 'shrink',
      maxSize: 64,
      minSize: 40,
    });
    const wrap = chooseCaptionLayout({
      page,
      width100,
      box,
      maxCharsPerLine: 60,
      maxLines: 1,
      fitMode: 'wrap',
      maxSize: 64,
      minSize: 40,
    });
    expect(shrink.overflowPx).toBeGreaterThan(0);
    expect(wrap.lines.length).toBeGreaterThan(shrink.lines.length);
    expect(wrap.overflowPx).toBe(0);
  });
});
