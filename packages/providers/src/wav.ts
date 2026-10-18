/** 16-bit PCM audio, interleaved when there is more than one channel. */
export type Pcm16 = { sampleRate: number; channels: number; samples: Int16Array };

const ascii = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));

export const encodeWav = ({ sampleRate, channels, samples }: Pcm16): Uint8Array => {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string) =>
    [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true);
  return out;
};

/** Reads a 16-bit PCM WAV (plain or WAVE_FORMAT_EXTENSIBLE), skipping unknown chunks. */
export const decodeWav = (bytes: Uint8Array): Pcm16 => {
  if (bytes.length < 12 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE')
    throw new Error('Not a WAV file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format: { sampleRate: number; channels: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === 'fmt ') {
      const tag = view.getUint16(start, true);
      const bits = view.getUint16(start + 14, true);
      const isPcm =
        tag === 1 || (tag === 0xfffe && size >= 26 && view.getUint16(start + 24, true) === 1);
      if (!isPcm || bits !== 16)
        throw new Error(`Only 16-bit PCM WAV is supported (format ${tag}, ${bits} bits).`);
      format = {
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data chunk before fmt chunk.');
      const end = Math.min(bytes.length, start + size);
      const count = Math.floor((end - start) / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(start + i * 2, true);
      return { ...format, samples };
    }
    offset = start + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk.');
};

/** Raw little-endian 16-bit PCM (e.g. OpenAI `pcm`, ElevenLabs `pcm_24000`). */
export const pcm16FromBytes = (bytes: Uint8Array, sampleRate: number, channels: number): Pcm16 => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return { sampleRate, channels, samples };
};

export const floatToPcm16 = (input: Float32Array, sampleRate: number): Pcm16 => {
  const samples = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    samples[i] = Math.round(s < 0 ? s * 32768 : s * 32767);
  }
  return { sampleRate, channels: 1, samples };
};

export const concatPcm = (parts: readonly Pcm16[]): Pcm16 => {
  const [first] = parts;
  if (!first) throw new Error('Nothing to concatenate.');
  if (parts.some((p) => p.sampleRate !== first.sampleRate || p.channels !== first.channels)) {
    throw new Error('Cannot concatenate audio with different formats.');
  }
  const samples = new Int16Array(parts.reduce((n, p) => n + p.samples.length, 0));
  let offset = 0;
  for (const part of parts) {
    samples.set(part.samples, offset);
    offset += part.samples.length;
  }
  return { sampleRate: first.sampleRate, channels: first.channels, samples };
};

export const durationSeconds = ({ sampleRate, channels, samples }: Pcm16): number =>
  samples.length / channels / sampleRate;
