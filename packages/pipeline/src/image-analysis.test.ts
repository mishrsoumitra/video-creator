import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@vc/config';
import { analyzeGray, captionPlacementFor, extractPalette } from './image-analysis';

const W = 64;
const H = 36;

/** A flat grey frame with a high-contrast checker patch in the given region. */
const grayWithPatch = (x0: number, y0: number, x1: number, y1: number): Uint8Array => {
  const px = new Uint8Array(W * H).fill(128);
  for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++) {
    for (let x = Math.floor(x0 * W); x < Math.floor(x1 * W); x++)
      px[y * W + x] = (x + y) % 2 === 0 ? 0 : 255;
  }
  return px;
};

describe('analyzeGray: deterministic busyness and subject box', () => {
  it('finds a detailed subject in the top-left', () => {
    const a = analyzeGray(grayWithPatch(0.05, 0.05, 0.4, 0.45), W, H);
    expect(a.subject.x).toBeLessThan(0.15);
    expect(a.subject.y).toBeLessThan(0.15);
    expect(a.subject.x + a.subject.w).toBeLessThan(0.55);
    expect(a.busyness.top).toBeGreaterThan(a.busyness.bottom);
  });

  it('reports a centred box for a flat image', () => {
    const a = analyzeGray(new Uint8Array(W * H).fill(90), W, H);
    expect(a.busyness).toEqual({ top: 0, middle: 0, bottom: 0 });
    expect(a.subject.x + a.subject.w / 2).toBeCloseTo(0.5, 1);
  });

  it('rejects a pixel buffer of the wrong size', () => {
    expect(() => analyzeGray(new Uint8Array(10), W, H)).toThrow(/pixels/);
  });
});

describe('captionPlacementFor', () => {
  it('puts lower-third captions at the bottom always', () => {
    expect(captionPlacementFor('lower-third', analyzeGray(grayWithPatch(0, 0.6, 1, 1), W, H))).toBe(
      'bottom',
    );
  });

  it('auto picks the calmer band, preferring the bottom on a tie', () => {
    expect(captionPlacementFor('auto', analyzeGray(grayWithPatch(0, 0.6, 1, 1), W, H))).toBe('top');
    expect(captionPlacementFor('auto', analyzeGray(grayWithPatch(0, 0, 1, 0.35), W, H))).toBe(
      'bottom',
    );
    expect(captionPlacementFor('auto', analyzeGray(new Uint8Array(W * H).fill(10), W, H))).toBe(
      'bottom',
    );
  });

  it('follow-subject keeps captions off the subject', () => {
    expect(
      captionPlacementFor('follow-subject', analyzeGray(grayWithPatch(0.3, 0.05, 0.7, 0.4), W, H)),
    ).not.toBe('top');
    expect(
      captionPlacementFor('follow-subject', analyzeGray(grayWithPatch(0.3, 0.65, 0.7, 0.98), W, H)),
    ).not.toBe('bottom');
  });
});

describe('extractPalette (palette pulled from an image)', () => {
  const twoColour = (): Uint8Array => {
    const px = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const [r, g, b] = i % W < W / 2 ? [20, 30, 60] : [230, 180, 40];
      px.set([r, g, b], i * 3);
    }
    return px;
  };

  it('returns five valid hex colours with the darkest first', () => {
    const palette = extractPalette(twoColour(), W, H);
    expect(palette).toHaveLength(5);
    for (const c of palette) expect(c).toMatch(/^#[0-9A-F]{6}$/);
    expect(palette[0]).toBe('#141E3C');
  });

  it('guarantees readable text on the background colour', () => {
    const palette = extractPalette(twoColour(), W, H);
    expect(contrastRatio(palette[3]!, palette[0]!)).toBeGreaterThanOrEqual(4.5);
  });

  it('is deterministic', () => {
    expect(extractPalette(twoColour(), W, H)).toEqual(extractPalette(twoColour(), W, H));
  });
});
