import { layoutLines, type CaptionPage, type CaptionToken, type TextFitMode } from '@vc/config';

export const LINE_HEIGHT = 1.2;
/** A phrase card re-enters only after a pause at least this long. */
export const CARD_REENTER_GAP_MS = 300;

/** Phrase cards animate in on the first page and after pauses, not on every page of continuous speech. */
export const cardEntersAfterPause = (
  pages: readonly CaptionPage[],
  index: number,
  gapMs = CARD_REENTER_GAP_MS,
): boolean => {
  if (index <= 0) return true;
  const previousEnd = pages[index - 1]!.tokens.at(-1)?.toMs ?? pages[index - 1]!.startMs;
  return pages[index]!.startMs - previousEnd >= gapMs;
};
const MAX_WRAP_LINES = 4;

const lineText = (line: readonly CaptionToken[]) => line.map((t) => t.text.trim()).join(' ');

export type CaptionLayout = { lines: CaptionToken[][]; fontSize: number; overflowPx: number };

/**
 * Picks lines and a font size for a caption page. Widths scale linearly with font size, so each
 * line is measured once at 100 px. Never goes below minSize: whatever still does not fit is
 * reported as overflowPx (the final checks list it).
 */
export const chooseCaptionLayout = ({
  page,
  width100,
  box,
  maxCharsPerLine,
  maxLines,
  fitMode,
  maxSize,
  minSize,
}: {
  page: CaptionPage;
  /** Width of a string at font size 100. */
  width100: (text: string) => number;
  box: { width: number; height: number };
  maxCharsPerLine: number;
  maxLines: number;
  fitMode: TextFitMode;
  maxSize: number;
  minSize: number;
}): CaptionLayout => {
  const fit = (lines: CaptionToken[][]) => {
    const widest = Math.max(1, ...lines.map((l) => width100(lineText(l))));
    const byWidth = (box.width / widest) * 100;
    const byHeight = box.height / (lines.length * LINE_HEIGHT);
    return Math.min(maxSize, byWidth, byHeight);
  };
  let lines = layoutLines(page, maxCharsPerLine);
  let size = fit(lines);
  if (fitMode === 'wrap' && size < minSize) {
    for (
      let chars = Math.floor(maxCharsPerLine * 0.75);
      chars >= 4;
      chars = Math.floor(chars * 0.75)
    ) {
      const candidate = layoutLines(page, chars);
      if (candidate.length > Math.max(MAX_WRAP_LINES, maxLines)) break;
      const s = fit(candidate);
      if (s > size) {
        lines = candidate;
        size = s;
      }
      if (size >= minSize) break;
    }
  }
  const fontSize = Math.max(minSize, Math.min(maxSize, size));
  const widthOver = Math.max(
    0,
    ...lines.map((l) => (width100(lineText(l)) * fontSize) / 100 - box.width),
  );
  const heightOver = Math.max(0, lines.length * LINE_HEIGHT * fontSize - box.height);
  return {
    lines,
    fontSize: Math.round(fontSize * 100) / 100,
    overflowPx: Math.round(Math.max(widthOver, heightOver)),
  };
};
