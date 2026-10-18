import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export const REDACTED = '[REDACTED]';
/** Shorter values are ignored: scrubbing tiny strings would shred ordinary log text. */
export const MIN_SCRUB_LENGTH = 8;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Removes registered secret values from text (logs, error messages). Catches the raw value and
 * the encoded forms keys travel in: URL-encoded query strings and base64.
 */
export class SecretScrubber {
  private readonly secrets = new Set<string>();
  private pattern: RegExp | null = null;

  get size(): number {
    return this.secrets.size;
  }

  /** Returns false (and ignores the value) when it is too short to scrub safely. */
  add(value: string): boolean {
    if (typeof value !== 'string' || value.length < MIN_SCRUB_LENGTH) return false;
    if (!this.secrets.has(value)) {
      this.secrets.add(value);
      this.pattern = null;
    }
    return true;
  }

  remove(value: string): void {
    if (this.secrets.delete(value)) this.pattern = null;
  }

  clear(): void {
    this.secrets.clear();
    this.pattern = null;
  }

  scrub(text: string): string {
    if (this.secrets.size === 0 || text.length === 0) return text;
    return text.replace(this.compile(), REDACTED);
  }

  private compile(): RegExp {
    if (this.pattern) return this.pattern;
    const forms = new Set<string>();
    for (const secret of this.secrets) {
      const bytes = Buffer.from(secret, 'utf8');
      const base64 = bytes.toString('base64');
      for (const form of [
        secret,
        encodeURIComponent(secret),
        base64,
        base64.replace(/=+$/, ''),
        bytes.toString('base64url'),
      ]) {
        if (form.length >= MIN_SCRUB_LENGTH) forms.add(form);
      }
    }
    // Longest first, so a secret that contains another is removed whole.
    const alternatives = [...forms].sort((a, b) => b.length - a.length).map(escapeRegExp);
    this.pattern = new RegExp(alternatives.join('|'), 'g');
    return this.pattern;
  }
}

/** Lines longer than this are flushed even without a newline, so memory stays bounded. */
const MAX_BUFFERED_CHARS = 64 * 1024;

/**
 * A log destination that scrubs secrets before writing. It buffers to line ends, so a secret split
 * across two writes of one line is still caught.
 */
export const createScrubbingStream = (
  destination: NodeJS.WritableStream,
  scrubber: SecretScrubber,
): Writable => {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const forward = (text: string, callback: (error?: Error | null) => void) => {
    if (text.length === 0) {
      callback();
      return;
    }
    if (destination.write(text)) callback();
    else destination.once('drain', () => callback());
  };
  return new Writable({
    decodeStrings: false,
    write(chunk: Buffer | string, _encoding, callback) {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const cut =
        pending.length > MAX_BUFFERED_CHARS ? pending.length : pending.lastIndexOf('\n') + 1;
      if (cut === 0) {
        callback();
        return;
      }
      const complete = pending.slice(0, cut);
      pending = pending.slice(cut);
      forward(scrubber.scrub(complete), callback);
    },
    final(callback) {
      const rest = pending + decoder.end();
      pending = '';
      forward(scrubber.scrub(rest), callback);
    },
  });
};
