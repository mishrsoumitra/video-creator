import { describe, expect, it } from 'vitest';
import { encodeWav, silentWav } from './index';

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.slice(at, at + length));

describe('encodeWav', () => {
  it('writes a canonical 16-bit PCM RIFF header', () => {
    const bytes = encodeWav(new Float32Array(100), 48_000);
    const v = view(bytes);
    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 200);
    expect(ascii(bytes, 8, 4)).toBe('WAVE');
    expect(ascii(bytes, 12, 4)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // channels
    expect(v.getUint32(24, true)).toBe(48_000);
    expect(v.getUint32(28, true)).toBe(96_000); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(bytes, 36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(200);
    expect(bytes.byteLength).toBe(244);
  });

  it('converts floats to 16-bit samples, clamping out-of-range values and NaN', () => {
    const v = view(encodeWav(Float32Array.from([1, -1, 0, 0.5, 1.5, -2, Number.NaN]), 8000));
    const sample = (i: number) => v.getInt16(44 + i * 2, true);
    expect(sample(0)).toBe(32767);
    expect(sample(1)).toBe(-32768);
    expect(sample(2)).toBe(0);
    expect(sample(3)).toBe(16384);
    expect(sample(4)).toBe(32767);
    expect(sample(5)).toBe(-32768);
    expect(sample(6)).toBe(0);
  });

  it('interleaves channels', () => {
    const bytes = encodeWav([Float32Array.from([1, 0]), Float32Array.from([-1, 0.5])], 8000);
    const v = view(bytes);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint16(32, true)).toBe(4);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([
      32767, -32768, 0, 16384,
    ]);
  });

  it('rejects channels of different lengths, no channels, or a bad sample rate', () => {
    expect(() => encodeWav([new Float32Array(3), new Float32Array(4)], 8000)).toThrow(/length/);
    expect(() => encodeWav([], 8000)).toThrow(/channel/);
    expect(() => encodeWav(new Float32Array(1), 0)).toThrow(/sample rate/i);
  });

  it('writes a valid empty file', () => {
    const bytes = encodeWav(new Float32Array(0), 16_000);
    expect(bytes.byteLength).toBe(44);
    expect(view(bytes).getUint32(40, true)).toBe(0);
  });
});

describe('silentWav', () => {
  it('produces mono silence of the requested length at 16 kHz by default', () => {
    const bytes = silentWav(500);
    const v = view(bytes);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(40, true)).toBe(8000 * 2);
    expect(bytes.slice(44).every((b) => b === 0)).toBe(true);
  });

  it('honours a custom sample rate', () => {
    expect(view(silentWav(1000, 8000)).getUint32(40, true)).toBe(16_000);
  });
});
