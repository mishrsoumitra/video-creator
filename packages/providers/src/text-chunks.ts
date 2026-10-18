/*
 * TTS engines cap the text per request (OpenAI 4,096 characters, Google 5,000 bytes, ElevenLabs
 * 5,000-40,000 characters by model). Long scripts are split at the most natural boundary that fits:
 * sentence, then clause, then word, then a hard cut.
 */

export type ChunkLimit = { maxChars?: number; maxBytes?: number };

const encoder = new TextEncoder();

const fits = (text: string, limit: ChunkLimit) =>
  (limit.maxChars === undefined || text.length <= limit.maxChars) &&
  (limit.maxBytes === undefined || encoder.encode(text).length <= limit.maxBytes);

const SENTENCE_END = /(?<=[.!?…]["')\]]*)\s+/;
const CLAUSE_END = /(?<=[,;:—–])\s+/;

/** Greedily packs pieces (already free of surrounding whitespace) into chunks that fit. */
const pack = (pieces: string[], limit: ChunkLimit): string[] => {
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    const candidate = current ? `${current} ${piece}` : piece;
    if (fits(candidate, limit)) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = piece;
  }
  if (current) chunks.push(current);
  return chunks;
};

const hardSplit = (word: string, limit: ChunkLimit): string[] => {
  const out: string[] = [];
  let current = '';
  for (const char of word) {
    if (current && !fits(current + char, limit)) {
      out.push(current);
      current = '';
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
};

const refine = (piece: string, limit: ChunkLimit, level: 0 | 1 | 2): string[] => {
  if (fits(piece, limit)) return [piece];
  if (level === 0)
    return pack(
      piece.split(CLAUSE_END).flatMap((p) => refine(p, limit, 1)),
      limit,
    );
  if (level === 1)
    return pack(
      piece.split(' ').flatMap((p) => refine(p, limit, 2)),
      limit,
    );
  return hardSplit(piece, limit);
};

/** Splits text into chunks within the limit. Joining the chunks with spaces gives the whitespace-normalised text. */
export const splitTextForSpeech = (text: string, limit: ChunkLimit): string[] => {
  if (limit.maxChars === undefined && limit.maxBytes === undefined)
    throw new Error('A character or byte limit is required.');
  const normalised = text.replace(/\s+/g, ' ').trim();
  if (!normalised) return [];
  const sentences = normalised.split(SENTENCE_END).filter(Boolean);
  return pack(
    sentences.flatMap((s) => refine(s, limit, 0)),
    limit,
  );
};
