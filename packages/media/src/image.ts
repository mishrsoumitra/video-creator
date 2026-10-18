import { MediaError } from './errors';
import { assertExists } from './probe';
import { runFfmpeg, type MediaOptions } from './process';

export type PixelFormat = 'gray' | 'rgb24';

/**
 * Downsamples an image (area averaging) to raw pixels: one byte per pixel for gray, three for
 * rgb24. Deterministic input for caption placement and palette extraction.
 */
export const samplePixels = async (
  path: string,
  options: MediaOptions & { width: number; height: number; format: PixelFormat },
): Promise<Uint8Array> => {
  const { width, height, format } = options;
  if (!(
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width * height <= 4096 * 4096
  )) {
    throw new MediaError({
      code: 'invalid_input',
      message: 'width and height must be positive integers.',
    });
  }
  await assertExists(path);
  const expected = width * height * (format === 'gray' ? 1 : 3);
  const { stdout } = await runFfmpeg(
    [
      '-i',
      path,
      '-vf',
      `scale=${width}:${height}:flags=area,format=${format}`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-',
    ],
    { timeoutMs: 60_000, maxStdoutBytes: expected * 2, ...options },
  );
  if (stdout.length !== expected) {
    throw new MediaError({
      code: 'parse_failed',
      message: `Expected ${expected} pixel bytes, got ${stdout.length}.`,
    });
  }
  return new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength);
};
