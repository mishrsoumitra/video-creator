import { describe, expect, it } from 'vitest';
import {
  countWords,
  keywordStems,
  normalizeForMatch,
  splitSentences,
  stem,
  tokenizeForMatch,
  wordBudget,
} from './text';

describe('countWords (the hard word budget is counted by code)', () => {
  it.each([
    ['', 0],
    ['   ', 0],
    ['One.', 1],
    ['The Apollo program landed twelve people on the Moon.', 9],
    ["Don't count contractions twice.", 4],
    ['A twenty-one gun salute', 4],
    ['In 1969, 600 million people watched.', 6],
    ['Wait — what?', 2],
    ['Line one.\nLine two.', 4],
    ['“Quoted” words… and ellipses...', 4],
  ])('%j has %i words', (text, n) => {
    expect(countWords(text)).toBe(n);
  });
});

describe('splitSentences', () => {
  it('splits on terminal punctuation and keeps it', () => {
    expect(splitSentences('First one. Second one! Third one? Fourth')).toEqual([
      'First one.',
      'Second one!',
      'Third one?',
      'Fourth',
    ]);
  });

  it('does not split on abbreviations, initials or decimals', () => {
    expect(
      splitSentences(
        'Dr. Smith met Mr. Jones in the U.S. in 1969. It cost 3.5 million dollars, e.g. a lot.',
      ),
    ).toEqual([
      'Dr. Smith met Mr. Jones in the U.S. in 1969.',
      'It cost 3.5 million dollars, e.g. a lot.',
    ]);
  });

  it('keeps initials inside names together', () => {
    expect(splitSentences('John F. Kennedy spoke. Crowds cheered.')).toEqual([
      'John F. Kennedy spoke.',
      'Crowds cheered.',
    ]);
  });

  it('handles closing quotes and ellipses', () => {
    expect(splitSentences('He said “go.” Then silence… Then a roar.')).toEqual([
      'He said “go.”',
      'Then silence…',
      'Then a roar.',
    ]);
  });

  it('collapses whitespace and ignores empty input', () => {
    expect(splitSentences('  One.   Two.  ')).toEqual(['One.', 'Two.']);
    expect(splitSentences('')).toEqual([]);
  });
});

describe('matching helpers', () => {
  it('normalises case, accents and punctuation', () => {
    expect(normalizeForMatch('  Café  “Déjà-vu”, OK! ')).toBe('cafe deja vu ok');
  });

  it('tokenises for matching', () => {
    expect(tokenizeForMatch("Neil Armstrong's first step")).toEqual([
      'neil',
      'armstrong',
      's',
      'first',
      'step',
    ]);
  });

  it('stems common English suffixes', () => {
    expect(stem('rockets')).toBe(stem('rocket'));
    expect(stem('launching')).toBe(stem('launch'));
    expect(stem('launched')).toBe(stem('launch'));
    expect(stem('volcanoes')).toBe(stem('volcano'));
    expect(stem('studies')).toBe(stem('study'));
    expect(stem('is')).toBe('is');
  });

  it('extracts unique keyword stems without stopwords', () => {
    expect(keywordStems('The rockets were launched from the launch pad')).toEqual([
      'rocket',
      'launch',
      'pad',
    ]);
  });
});

describe('wordBudget', () => {
  it('allows 150 spoken words per minute', () => {
    expect(wordBudget(60)).toBe(150);
    expect(wordBudget(30)).toBe(75);
    expect(wordBudget(90)).toBe(225);
  });

  it('rejects a non-positive length', () => {
    expect(() => wordBudget(0)).toThrow(RangeError);
  });
});
