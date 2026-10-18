import type { Aspect, Codec, PixelFormat, Resolution } from './enums';
import { PIXEL_FORMATS } from './enums';

type CodecInfo = {
  /** Valid CRF range, or null when the codec has no CRF (ProRes uses a profile). */
  readonly crf: { readonly min: number; readonly max: number; readonly default: number } | null;
  readonly container: 'mp4' | 'webm' | 'mov';
  /** Platforms with a hardware encoder Remotion can use. */
  readonly hardwarePlatforms: readonly NodeJS.Platform[];
  readonly audioCodec: 'aac' | 'opus' | 'pcm-16';
};

/** Read from @remotion/renderer 4.0.536 (crf.js, get-codec-name.js); tests compare against BrowserSafeApis. */
export const CODEC_TABLE: Readonly<Record<Codec, CodecInfo>> = Object.freeze({
  h264: {
    crf: { min: 1, max: 51, default: 18 },
    container: 'mp4',
    hardwarePlatforms: ['darwin', 'linux', 'win32'],
    audioCodec: 'aac',
  },
  h265: {
    crf: { min: 0, max: 51, default: 23 },
    container: 'mp4',
    hardwarePlatforms: ['darwin', 'linux', 'win32'],
    audioCodec: 'aac',
  },
  vp8: {
    crf: { min: 4, max: 63, default: 9 },
    container: 'webm',
    hardwarePlatforms: [],
    audioCodec: 'opus',
  },
  vp9: {
    crf: { min: 0, max: 63, default: 28 },
    container: 'webm',
    hardwarePlatforms: [],
    audioCodec: 'opus',
  },
  av1: {
    crf: { min: 0, max: 63, default: 30 },
    container: 'mp4',
    hardwarePlatforms: [],
    audioCodec: 'aac',
  },
  prores: { crf: null, container: 'mov', hardwarePlatforms: ['darwin'], audioCodec: 'pcm-16' },
});

export const crfRangeFor = (codec: Codec): { min: number; max: number } | null => {
  const crf = CODEC_TABLE[codec].crf;
  return crf ? { min: crf.min, max: crf.max } : null;
};

export const defaultCrfFor = (codec: Codec): number | null =>
  CODEC_TABLE[codec].crf?.default ?? null;

export const containerFor = (codec: Codec): CodecInfo['container'] => CODEC_TABLE[codec].container;

/** Can this codec be hardware-encoded anywhere (schema check) / on this platform (environment check)? */
export const supportsHardwareAcceleration = (codec: Codec, platform?: NodeJS.Platform): boolean =>
  platform === undefined
    ? CODEC_TABLE[codec].hardwarePlatforms.length > 0
    : CODEC_TABLE[codec].hardwarePlatforms.includes(platform);

/** Mirrors Remotion's validPixelFormatsForCodec: yuva420p is VP8/VP9-only. */
export const pixelFormatsFor = (codec: Codec): readonly PixelFormat[] =>
  codec === 'vp8' || codec === 'vp9'
    ? PIXEL_FORMATS
    : PIXEL_FORMATS.filter((f) => f !== 'yuva420p');

export const isTransparentPixelFormat = (format: PixelFormat): boolean =>
  format === 'yuva420p' || format === 'yuva444p10le';

/** The composition is always laid out at 1080p; Remotion's `scale` produces the other sizes. */
export const BASE_DIMENSIONS: Readonly<Record<Aspect, { width: number; height: number }>> =
  Object.freeze({
    '16:9': { width: 1920, height: 1080 },
    '9:16': { width: 1080, height: 1920 },
    '1:1': { width: 1080, height: 1080 },
  });

const SCALE: Readonly<Record<Resolution, number>> = Object.freeze({
  '720p': 2 / 3,
  '1080p': 1,
  '4k': 2,
});

export const resolutionScale = (resolution: Resolution): number => SCALE[resolution];

export const outputDimensions = (aspect: Aspect, resolution: Resolution) => {
  const composition = BASE_DIMENSIONS[aspect];
  const scale = resolutionScale(resolution);
  return {
    composition: { ...composition },
    scale,
    output: {
      width: Math.round(composition.width * scale),
      height: Math.round(composition.height * scale),
    },
  };
};
