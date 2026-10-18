import { describe, expect, it } from 'vitest';
import { contrastRatio, parseCssColor, relativeLuminance } from './index';

describe('colour helpers', () => {
  it('parses the CSS colour forms Remotion accepts', () => {
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('#11223380')).toMatchObject({ r: 17, g: 34, b: 51 });
    expect(parseCssColor('#11223380').a).toBeCloseTo(128 / 255, 3);
    expect(parseCssColor('red')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseCssColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
  });

  it('throws on invalid colours', () => {
    expect(() => parseCssColor('nope')).toThrow();
  });

  it('computes WCAG relative luminance and contrast', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 6);
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 6);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#abc', '#abc')).toBe(1);
  });
});
