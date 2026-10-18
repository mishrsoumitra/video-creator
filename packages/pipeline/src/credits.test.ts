import type { Credit } from '@vc/config';
import { describe, expect, it } from 'vitest';
import { buildCredits, formatImageCredit } from './credits';
import type { FactSheet } from './research';

const credit = (patch: Partial<Credit> = {}): Credit => ({
  title: 'Apollo 11 launch',
  creator: 'NASA',
  license: 'by',
  licenseVersion: '4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  sourceUrl: 'https://example.org/apollo',
  provider: 'openverse',
  ...patch,
});

describe('formatImageCredit (title, author, source, licence)', () => {
  it('formats CC BY with version and links', () => {
    expect(formatImageCredit(credit())).toBe(
      '“Apollo 11 launch” by NASA is licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Source: https://example.org/apollo',
    );
  });

  it('names share-alike and other CC licences correctly', () => {
    expect(
      formatImageCredit(credit({ license: 'by-sa', licenseVersion: '2.0', licenseUrl: null })),
    ).toBe(
      '“Apollo 11 launch” by NASA is licensed under CC BY-SA 2.0. Source: https://example.org/apollo',
    );
    expect(
      formatImageCredit(
        credit({ license: 'by-nc-nd', licenseVersion: null, licenseUrl: null, sourceUrl: null }),
      ),
    ).toBe('“Apollo 11 launch” by NASA is licensed under CC BY-NC-ND.');
  });

  it('words CC0 and the Public Domain Mark as public domain, not as licences', () => {
    expect(
      formatImageCredit(credit({ license: 'cc0', licenseVersion: '1.0', licenseUrl: null })),
    ).toBe(
      '“Apollo 11 launch” by NASA is dedicated to the public domain under CC0 1.0. Source: https://example.org/apollo',
    );
    expect(
      formatImageCredit(
        credit({ license: 'pdm', licenseVersion: '1.0', licenseUrl: null, sourceUrl: null }),
      ),
    ).toBe('“Apollo 11 launch” by NASA is marked with the Public Domain Mark 1.0.');
  });

  it('copes with a missing title or creator', () => {
    expect(
      formatImageCredit(credit({ title: '  ', creator: null, licenseUrl: null, sourceUrl: null })),
    ).toBe('“Untitled” by an unknown creator is licensed under CC BY 4.0.');
  });
});

const sheet = (method: 'search' | 'user-text'): FactSheet => ({
  topic: 'Apollo',
  method,
  createdAt: '2026-10-18T00:00:00Z',
  facts: [],
  sources:
    method === 'search'
      ? [
          { id: 'S1', kind: 'web', title: 'Apollo program', url: 'https://a.example/apollo' },
          { id: 'S2', kind: 'web', title: 'Moon landing', url: 'https://b.example/moon' },
        ]
      : [{ id: 'U1', kind: 'user', title: 'Your source text', url: null }],
});

describe('buildCredits: generated from stored licence metadata, never AI', () => {
  const scenes = [
    { visual: { type: 'image' as const, credit: credit() } },
    { visual: { type: 'typographic' as const } },
    {
      visual: {
        type: 'image' as const,
        credit: credit({
          title: 'Lunar module',
          license: 'pdm',
          licenseVersion: '1.0',
          licenseUrl: null,
          sourceUrl: 'https://example.org/lm',
        }),
      },
    },
    { visual: { type: 'image' as const, credit: credit() } },
  ];

  it('lists each image once, in order, and skips typographic scenes', () => {
    const c = buildCredits({ scenes, factSheet: sheet('search'), music: { kind: 'none' } });
    expect(c.images).toHaveLength(2);
    expect(c.text).toContain('Images\n“Apollo 11 launch” by NASA');
    expect(c.text.indexOf('Apollo 11 launch')).toBeLessThan(c.text.indexOf('Lunar module'));
  });

  it('lists research sources', () => {
    const c = buildCredits({ scenes: [], factSheet: sheet('search'), music: { kind: 'none' } });
    expect(c.text).toBe(
      'Sources\nApollo program — https://a.example/apollo\nMoon landing — https://b.example/moon\n',
    );
  });

  it('credits the user’s own text and music, and library music', () => {
    expect(
      buildCredits({ scenes: [], factSheet: sheet('user-text'), music: { kind: 'upload' } }).text,
    ).toBe('Sources\nYour own source text\n\nMusic\nYour uploaded track\n');
    expect(
      buildCredits({ scenes: [], factSheet: null, music: { kind: 'library', label: 'Soft pad' } })
        .text,
    ).toBe('Music\n“Soft pad”, generated on this machine (no attribution required)\n');
  });

  it('is empty when there is nothing to credit', () => {
    expect(buildCredits({ scenes: [], factSheet: null, music: { kind: 'none' } }).text).toBe('');
  });
});
