/** Encodes float samples (-1..1) as a 16-bit PCM WAV file. Pure JS: no ffmpeg needed. */
export const encodeWav = (
  samples: Float32Array | readonly Float32Array[],
  sampleRate: number,
): Uint8Array => {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0)
    throw new RangeError('The sample rate must be a positive integer.');
  const channels: readonly Float32Array[] = samples instanceof Float32Array ? [samples] : samples;
  if (channels.length === 0) throw new RangeError('At least one channel is required.');
  const frames = channels[0]!.length;
  if (channels.some((c) => c.length !== frames))
    throw new RangeError('Every channel must have the same length.');

  const blockAlign = channels.length * 2;
  const dataBytes = frames * blockAlign;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const raw = channel[frame]!;
      const s = Number.isNaN(raw) ? 0 : Math.max(-1, Math.min(1, raw));
      view.setInt16(offset, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
      offset += 2;
    }
  }
  return bytes;
};

/** Mono digital silence; used for the word-timing provider's tiny test call. */
export const silentWav = (durationMs: number, sampleRate = 16_000): Uint8Array =>
  encodeWav(new Float32Array(Math.round((durationMs / 1000) * sampleRate)), sampleRate);
