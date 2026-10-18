import type { Credit } from '@vc/config';
import type { FactSheet } from './research';

const LICENSE_NAMES: Record<string, string> = {
  by: 'CC BY',
  'by-sa': 'CC BY-SA',
  'by-nd': 'CC BY-ND',
  'by-nc': 'CC BY-NC',
  'by-nc-sa': 'CC BY-NC-SA',
  'by-nc-nd': 'CC BY-NC-ND',
  'sampling+': 'CC Sampling+',
  'nc-sampling+': 'CC NC-Sampling+',
};

/** One attribution line: title, author, source and licence (the TASL convention). */
export const formatImageCredit = (c: Credit): string => {
  const title = `“${c.title.trim() || 'Untitled'}”`;
  const by = c.creator?.trim() ? `by ${c.creator.trim()}` : 'by an unknown creator';
  const version = c.licenseVersion ? ` ${c.licenseVersion}` : '';
  const link = c.licenseUrl ? ` (${c.licenseUrl})` : '';
  const license = c.license.toLowerCase();
  const terms =
    license === 'cc0'
      ? `is dedicated to the public domain under CC0${version}${link}`
      : license === 'pdm'
        ? `is marked with the Public Domain Mark${version}${link}`
        : `is licensed under ${LICENSE_NAMES[license] ?? license.toUpperCase()}${version}${link}`;
  return `${title} ${by} ${terms}.${c.sourceUrl ? ` Source: ${c.sourceUrl}` : ''}`;
};

export type MusicCredit =
  { kind: 'none' } | { kind: 'upload' } | { kind: 'library'; label: string };

export type Credits = { images: string[]; sources: string[]; music: string[]; text: string };

/** Credits for the description box and credits.txt, built from stored metadata only. */
export const buildCredits = ({
  scenes,
  factSheet,
  music,
}: {
  scenes: ReadonlyArray<{
    visual: { type: 'image'; credit?: Credit | null } | { type: 'typographic' };
  }>;
  factSheet: FactSheet | null;
  music: MusicCredit;
}): Credits => {
  const images: string[] = [];
  for (const scene of scenes) {
    if (scene.visual.type !== 'image' || !scene.visual.credit) continue;
    const line = formatImageCredit(scene.visual.credit);
    if (!images.includes(line)) images.push(line);
  }
  const sources = (factSheet?.sources ?? []).map((s) =>
    s.kind === 'user' ? 'Your own source text' : `${s.title} — ${s.url}`,
  );
  const musicLines =
    music.kind === 'library'
      ? [`“${music.label}”, generated on this machine (no attribution required)`]
      : music.kind === 'upload'
        ? ['Your uploaded track']
        : [];
  const sections = [
    ['Images', images],
    ['Sources', sources],
    ['Music', musicLines],
  ] as const;
  const text = sections
    .filter(([, lines]) => lines.length > 0)
    .map(([heading, lines]) => `${heading}\n${lines.join('\n')}\n`)
    .join('\n');
  return { images, sources, music: musicLines, text };
};
