/** Deterministic text helpers shared by the stages. */

/** Spoken English rate used for the word budget. */
export const WORDS_PER_MINUTE = 150;

export const wordBudget = (lengthSeconds: number): number => {
  if (!Number.isFinite(lengthSeconds) || lengthSeconds <= 0)
    throw new RangeError('Length must be positive.');
  return Math.round((lengthSeconds * WORDS_PER_MINUTE) / 60);
};

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/** Whitespace-separated tokens that contain a letter or digit. Hyphenated words and contractions count once. */
export const countWords = (text: string): number =>
  text.split(/\s+/).filter((t) => HAS_WORD_CHAR.test(t)).length;

const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'inc',
  'ltd',
  'co',
  'corp',
  'no',
  'fig',
  'approx',
  'e.g',
  'i.e',
  'u.s',
  'u.k',
  'u.n',
  'a.m',
  'p.m',
  'mt',
  'ft',
  'gen',
  'col',
  'lt',
  'sgt',
  'capt',
  'gov',
  'sen',
  'rep',
]);

const CLOSERS = '"\'”’)]»';

/** Splits prose into sentences, keeping terminal punctuation and closing quotes. */
export const splitSentences = (text: string): string[] => {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
    let end = i + 1;
    while (end < clean.length && (clean[end] === '.' || clean[end] === '!' || clean[end] === '?'))
      end++;
    while (end < clean.length && CLOSERS.includes(clean[end]!)) end++;
    if (end >= clean.length) break;
    if (clean[end] !== ' ') continue;
    const next = clean[end + 1] ?? '';
    if (!/[\p{Lu}\p{N}"“‘'([]/u.test(next)) continue;
    if (ch === '.') {
      const before = clean.slice(start, i).split(' ').at(-1) ?? '';
      const word = before.replace(/^[("“‘']+/, '').toLowerCase();
      if (ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word) || /^(\p{L}\.)+\p{L}$/u.test(word))
        continue;
    }
    sentences.push(clean.slice(start, end).trim());
    start = end + 1;
    i = end;
  }
  const rest = clean.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
};

export const normalizeForMatch = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export const tokenizeForMatch = (text: string): string[] => {
  const n = normalizeForMatch(text);
  return n ? n.split(' ') : [];
};

export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before being below between both but by ' +
    'can could did do does doing down during each few for from further had has have having he her here hers herself him himself ' +
    'his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ' +
    'ourselves out over own same she should so some such than that the their theirs them themselves then there these they this ' +
    'those through to too under until up very was we were what when where which while who whom why will with would you your ' +
    'yours yourself yourselves s t one two first new many much would like into its also may might us'
  ).split(' '),
);

/** Light suffix stripping so "rockets", "launched" and "launching" meet "rocket" and "launch". */
export const stem = (word: string): string => {
  const w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('oes') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 5) return undouble(w.slice(0, -3));
  if (w.endsWith('ed') && w.length > 4) return undouble(w.slice(0, -2));
  if (w.endsWith('ly') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('es') && /(ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is'))
    return w.slice(0, -1);
  return w;
};

const undouble = (w: string): string =>
  /([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w) ? w.slice(0, -1) : w;

/** Unique content-word stems, in order of first appearance. */
export const keywordStems = (text: string): string[] => {
  const out: string[] = [];
  for (const token of tokenizeForMatch(text)) {
    if (STOPWORDS.has(token) || token.length < 2) continue;
    const s = stem(token);
    if (!out.includes(s)) out.push(s);
  }
  return out;
};
