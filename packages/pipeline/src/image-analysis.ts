import { contrastRatio, type CaptionPosition } from '@vc/config';

export type Box = { x: number; y: number; w: number; h: number };
export type ImageAnalysis = {
  /** Where the detail is, as fractions of the image. */
  subject: Box;
  /** Mean edge strength per horizontal band (0..1). */
  busyness: { top: number; middle: number; bottom: number };
};
export type CaptionPlacement = 'top' | 'middle' | 'bottom';

const BANDS: Record<CaptionPlacement, [number, number]> = {
  top: [0, 1 / 3],
  middle: [1 / 3, 2 / 3],
  bottom: [2 / 3, 1],
};

/** Edge-energy analysis of a small grayscale thumbnail. No AI. */
export const analyzeGray = (pixels: Uint8Array, width: number, height: number): ImageAnalysis => {
  if (pixels.length !== width * height)
    throw new Error(`Expected ${width * height} pixels, got ${pixels.length}.`);
  const energy = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const dx = x + 1 < width ? Math.abs(pixels[i + 1]! - pixels[i]!) : 0;
      const dy = y + 1 < height ? Math.abs(pixels[i + width]! - pixels[i]!) : 0;
      energy[i] = (dx + dy) / 510;
    }
  }
  const bandMean = ([from, to]: [number, number]) => {
    const y0 = Math.floor(from * height);
    const y1 = Math.max(y0 + 1, Math.floor(to * height));
    let sum = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < width; x++) sum += energy[y * width + x]!;
    return Math.round((sum / ((y1 - y0) * width)) * 1e4) / 1e4;
  };
  const busyness = {
    top: bandMean(BANDS.top),
    middle: bandMean(BANDS.middle),
    bottom: bandMean(BANDS.bottom),
  };

  // Subject: bounding box of grid cells whose energy stands out from the frame.
  const cols = 8;
  const rows = 6;
  const cells: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      let n = 0;
      for (
        let y = Math.floor((r * height) / rows);
        y < Math.floor(((r + 1) * height) / rows);
        y++
      ) {
        for (
          let x = Math.floor((c * width) / cols);
          x < Math.floor(((c + 1) * width) / cols);
          x++
        ) {
          sum += energy[y * width + x]!;
          n++;
        }
      }
      cells.push(n ? sum / n : 0);
    }
  }
  const mean = cells.reduce((s, v) => s + v, 0) / cells.length;
  const sd = Math.sqrt(cells.reduce((s, v) => s + (v - mean) ** 2, 0) / cells.length);
  if (sd < 1e-6) return { subject: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, busyness };
  let minC = cols;
  let minR = rows;
  let maxC = -1;
  let maxR = -1;
  cells.forEach((v, i) => {
    if (v < mean + 0.5 * sd) return;
    const r = Math.floor(i / cols);
    const c = i % cols;
    minC = Math.min(minC, c);
    maxC = Math.max(maxC, c);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
  });
  return {
    subject: {
      x: minC / cols,
      y: minR / rows,
      w: (maxC - minC + 1) / cols,
      h: (maxR - minR + 1) / rows,
    },
    busyness,
  };
};

const overlap = (box: Box, [from, to]: [number, number]) =>
  Math.max(0, Math.min(box.y + box.h, to) - Math.max(box.y, from)) * box.w;

/** Where captions go for one scene. "Follow subject" keeps them in the band the subject covers least. */
export const captionPlacementFor = (
  position: CaptionPosition,
  analysis: ImageAnalysis | null,
): CaptionPlacement => {
  if (position === 'lower-third' || !analysis) return 'bottom';
  if (position === 'auto')
    return analysis.busyness.top < analysis.busyness.bottom ? 'top' : 'bottom';
  const order: CaptionPlacement[] = ['bottom', 'top', 'middle'];
  return order.reduce(
    (best, band) =>
      overlap(analysis.subject, BANDS[band]) < overlap(analysis.subject, BANDS[best]) ? band : best,
    'bottom',
  );
};

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`;

const lum = ([r, g, b]: number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
const sat = ([r, g, b]: number[]) => {
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  return max === 0 ? 0 : (max - min) / max;
};

/**
 * Five colours pulled from an image (k-means, deterministic start), in the palette's roles:
 * background, second background, accent, text, extra accent. Text always reads on the background.
 */
export const extractPalette = (rgb: Uint8Array, width: number, height: number): string[] => {
  const n = width * height;
  if (rgb.length !== n * 3) throw new Error(`Expected ${n * 3} bytes of rgb24, got ${rgb.length}.`);
  const points: number[][] = [];
  for (let i = 0; i < n; i++) points.push([rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!]);
  points.sort((a, b) => lum(a) - lum(b));
  const k = 5;
  let centres = Array.from({ length: k }, (_, j) => [
    ...points[Math.min(n - 1, Math.floor(((j + 0.5) / k) * n))]!,
  ]);
  for (let iter = 0; iter < 12; iter++) {
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (const p of points) {
      let best = 0;
      let bestD = Infinity;
      centres.forEach((c, j) => {
        const d = (p[0]! - c[0]!) ** 2 + (p[1]! - c[1]!) ** 2 + (p[2]! - c[2]!) ** 2;
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      const s = sums[best]!;
      s[0]! += p[0]!;
      s[1]! += p[1]!;
      s[2]! += p[2]!;
      s[3]! += 1;
    }
    centres = sums.map((s, j) =>
      s[3] ? [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!] : centres[j]!,
    );
  }
  const byLum = [...centres].sort((a, b) => lum(a) - lum(b));
  const background = byLum[0]!;
  const text = byLum[k - 1]!;
  const middle = byLum.slice(1, k - 1).sort((a, b) => sat(b) - sat(a));
  const accent = middle[0]!;
  const rest = middle.slice(1).sort((a, b) => lum(a) - lum(b));
  const palette = [
    hex(...(background as [number, number, number])),
    hex(...(rest[0] as [number, number, number])),
    hex(...(accent as [number, number, number])),
    hex(...(text as [number, number, number])),
    hex(...(rest[1] as [number, number, number])),
  ];
  if (contrastRatio(palette[3]!, palette[0]!) < 4.5)
    palette[3] =
      contrastRatio('#FFFFFF', palette[0]!) >= contrastRatio('#111111', palette[0]!)
        ? '#FFFFFF'
        : '#111111';
  return palette;
};
