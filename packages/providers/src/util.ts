import { extname } from 'node:path';
import type { UnitPrices } from '@vc/pipeline';

/**
 * Pulls a single JSON object out of model output that may wrap it in prose or a code fence.
 * Returns the input unchanged when there is no object; the pipeline validates and retries.
 */
export const extractJsonText = (text: string): string => {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced ? fenced[1]! : trimmed).trim();
  if (body.startsWith('{') && body.endsWith('}')) return body;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start !== -1 && end > start ? body.slice(start, end + 1) : trimmed;
};

/** Exact model id, else the longest table key the id extends with "-…" (dated snapshots, ":tags"). */
export const lookupByModel = <T>(
  table: Readonly<Record<string, T>>,
  model: string,
): T | undefined => {
  if (model in table) return table[model];
  const match = Object.keys(table)
    .filter(
      (key) =>
        model.startsWith(`${key}-`) || model.startsWith(`${key}:`) || model.startsWith(`${key}@`),
    )
    .sort((a, b) => b.length - a.length)[0];
  return match === undefined ? undefined : table[match];
};

export const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

export const fromBase64 = (data: string): Uint8Array => new Uint8Array(Buffer.from(data, 'base64'));

const AUDIO_TYPES: Readonly<Record<string, string>> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
};

export const audioMimeType = (path: string): string =>
  AUDIO_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

/** A price list where some entries change on announced dates. */
export type DatedPrice = { from?: string; prices: UnitPrices };

export const priceOn = (schedule: readonly DatedPrice[], at: Date): UnitPrices | null => {
  const applicable = schedule.filter(
    (entry) => entry.from === undefined || at.getTime() >= Date.parse(entry.from),
  );
  return applicable.at(-1)?.prices ?? null;
};

export const withSource = (prices: UnitPrices, source: string): UnitPrices => ({
  ...prices,
  source,
});

export const FREE_LOCAL: UnitPrices = Object.freeze({ source: 'Runs locally; no charge.' });
