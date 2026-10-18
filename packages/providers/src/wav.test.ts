import { describe, expect, it } from 'vitest';
import {
  concatPcm,
  decodeWav,
  durationSeconds,
  encodeWav,
  floatToPcm16,
  pcm16FromBytes,
} from './wav';
import { pcmBytes, sinePcm } from './testing/fake-fetch';

describe('wav', () => {
  it('round-trips 16-bit PCM through a RIFF/WAVE container', () => {
    const samples = sinePcm(0.5, 24_000);
    const wav = encodeWav({ sampleRate: 24_000, channels: 1, samples });
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE');
    expect(wav.length).toBe(44 + samples.length * 2);
    const back = decodeWav(wav);
    expect(back.sampleRate).toBe(24_000);
    expect(back.channels).toBe(1);
    expect([...back.samples]).toEqual([...samples]);
  });

  it('skips unknown chunks such as LIST before the data chunk', () => {
    const samples = sinePcm(0.01, 16_000);
    const base = encodeWav({ sampleRate: 16_000, channels: 1, samples });
    const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4]);
    const withList = new Uint8Array(base.length + list.length);
    withList.set(base.slice(0, 36), 0);
    withList.set(list, 36);
    withList.set(base.slice(36), 36 + list.length);
    expect([...decodeWav(withList).samples]).toEqual([...samples]);
  });

  it('rejects non-PCM or malformed files', () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3]))).toThrow(/WAV/);
    const wav = encodeWav({ sampleRate: 8000, channels: 1, samples: new Int16Array(4) });
    const float = wav.slice();
    new DataView(float.buffer).setUint16(20, 3, true); // IEEE float
    expect(() => decodeWav(float)).toThrow(/PCM/);
  });

  it('reads raw little-endian PCM', () => {
    const samples = sinePcm(0.02);
    expect([...pcm16FromBytes(pcmBytes(samples), 24_000, 1).samples]).toEqual([...samples]);
  });

  it('ignores a trailing odd byte in raw PCM', () => {
    expect(pcm16FromBytes(new Uint8Array([1, 0, 9]), 8000, 1).samples.length).toBe(1);
  });

  it('converts float samples, clamping out-of-range values', () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]), 24_000);
    expect([...pcm.samples]).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it('concatenates parts with the same format and refuses mixed formats', () => {
    const a = { sampleRate: 24_000, channels: 1, samples: sinePcm(0.25) };
    const b = { sampleRate: 24_000, channels: 1, samples: sinePcm(0.5) };
    const joined = concatPcm([a, b]);
    expect(durationSeconds(joined)).toBeCloseTo(0.75, 6);
    expect(() => concatPcm([a, { ...b, sampleRate: 16_000 }])).toThrow(/format/);
    expect(() => concatPcm([])).toThrow();
  });
});
