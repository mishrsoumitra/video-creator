import { describe, expect, it } from 'vitest';
import { maskSecret } from './index';

describe('maskSecret (Settings shows the last four characters only)', () => {
  it('shows only the last four characters of a normal key', () => {
    expect(maskSecret('sk-proj-1234567890abcd')).toBe('••••abcd');
  });

  it('starts showing the tail at 12 characters', () => {
    expect(maskSecret('123456789012')).toBe('••••9012');
    expect(maskSecret('12345678901')).toBe('••••');
  });

  it('never reveals any of a short key', () => {
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret('a')).toBe('••••');
  });

  it('returns an empty string for an empty value', () => {
    expect(maskSecret('')).toBe('');
  });

  it('never reveals more than four characters of any key', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
    for (let length = 1; length <= 80; length++) {
      const key = Array.from(
        { length },
        (_, i) => alphabet[(i * 7 + length) % alphabet.length],
      ).join('');
      const masked = maskSecret(key);
      const revealed = masked.replace(/^•+/, '');
      expect(revealed.length).toBeLessThanOrEqual(4);
      if (revealed.length > 0) expect(key.endsWith(revealed)).toBe(true);
    }
  });
});
