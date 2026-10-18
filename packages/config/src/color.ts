import { ZodZypesInternals } from '@remotion/zod-types';

export type Rgba = { r: number; g: number; b: number; a: number };

/** Parses any CSS colour Remotion accepts (hex, rgb(), hsl(), named). Alpha is 0..1. */
export const parseCssColor = (input: string): Rgba => {
  const { r, g, b, a } = ZodZypesInternals.parseColor(input);
  return { r, g, b, a: a / 255 };
};

const channel = (value: number): number => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance (alpha ignored). */
export const relativeLuminance = (color: string): number => {
  const { r, g, b } = parseCssColor(color);
  const l = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return Math.round(l * 1e12) / 1e12;
};

/** WCAG contrast ratio between two colours, 1..21. */
export const contrastRatio = (a: string, b: string): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};
