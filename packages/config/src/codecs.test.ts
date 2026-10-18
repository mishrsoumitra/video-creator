import { BrowserSafeApis } from '@remotion/renderer/client';
import { describe, expect, it } from 'vitest';
import {
  CODECS,
  COLOR_SPACES,
  HARDWARE_ACCELERATION,
  IMAGE_FORMATS,
  PIXEL_FORMATS,
  PRORES_PROFILES,
  SCHEMA_DEFAULTS,
  VideoConfigSchema,
  X264_PRESETS,
  containerFor,
  crfRangeFor,
  defaultCrfFor,
  mergeConfig,
  outputDimensions,
  pixelFormatsFor,
  resolutionScale,
  type Codec,
  type VideoConfigInput,
} from './index';

const issuesFor = (output: NonNullable<VideoConfigInput['output']>) => {
  const result = VideoConfigSchema.safeParse(mergeConfig(SCHEMA_DEFAULTS, { output }));
  return result.success ? [] : result.error.issues;
};
const pathsFor = (output: NonNullable<VideoConfigInput['output']>) =>
  issuesFor(output).map((i) => i.path.join('.'));

describe('codec tables match the installed @remotion/renderer', () => {
  it('exposes exactly the six codecs from the spec, all of which Remotion knows', () => {
    expect([...CODECS]).toEqual(['h264', 'h265', 'vp8', 'vp9', 'av1', 'prores']);
    for (const codec of CODECS) {
      expect(BrowserSafeApis.validCodecs).toContain(codec);
    }
  });

  it.each(CODECS.filter((c) => c !== 'prores'))(
    'uses Remotion’s CRF range and default for %s',
    (codec) => {
      const [min, max] = BrowserSafeApis.getValidCrfRanges(codec);
      expect(crfRangeFor(codec)).toEqual({ min, max });
      expect(defaultCrfFor(codec)).toBe(BrowserSafeApis.getDefaultCrfForCodec(codec));
    },
  );

  it('matches the CRF numbers stated in the spec', () => {
    expect(crfRangeFor('h264')).toEqual({ min: 1, max: 51 });
    expect(defaultCrfFor('h264')).toBe(18);
    expect(crfRangeFor('h265')).toEqual({ min: 0, max: 51 });
    expect(defaultCrfFor('h265')).toBe(23);
    expect(crfRangeFor('vp9')).toEqual({ min: 0, max: 63 });
    expect(defaultCrfFor('vp9')).toBe(28);
    expect(crfRangeFor('av1')).toEqual({ min: 0, max: 63 });
    expect(defaultCrfFor('av1')).toBe(30);
  });

  it('reports no CRF for ProRes, which uses a profile instead', () => {
    expect(crfRangeFor('prores')).toBeNull();
    expect(defaultCrfFor('prores')).toBeNull();
    expect(BrowserSafeApis.codecSupportsCrf('prores')).toBe(false);
  });

  it('lists the same ProRes profiles, x264 presets, hardware modes and colour spaces', () => {
    expect([...PRORES_PROFILES].sort()).toEqual([...BrowserSafeApis.proResProfileOptions].sort());
    expect([...X264_PRESETS]).toEqual([...BrowserSafeApis.x264PresetOptions]);
    expect([...HARDWARE_ACCELERATION]).toEqual([...BrowserSafeApis.hardwareAccelerationOptions]);
    expect([...COLOR_SPACES]).toEqual([...BrowserSafeApis.validColorSpaces]);
    expect([...PIXEL_FORMATS]).toEqual([...BrowserSafeApis.validPixelFormats]);
  });

  it('only offers image formats Remotion accepts for video frames', () => {
    for (const format of IMAGE_FORMATS) {
      expect(BrowserSafeApis.validVideoImageFormats).toContain(format);
    }
  });

  it('uses Remotion’s default JPEG quality and pixel format', () => {
    expect(SCHEMA_DEFAULTS.output.jpegQuality).toBe(BrowserSafeApis.DEFAULT_JPEG_QUALITY);
    expect(SCHEMA_DEFAULTS.output.pixelFormat).toBe(BrowserSafeApis.DEFAULT_PIXEL_FORMAT);
    expect(SCHEMA_DEFAULTS.output.colorSpace).toBe(BrowserSafeApis.DEFAULT_COLOR_SPACE);
  });

  it.each(CODECS)('agrees with Remotion on which pixel formats %s accepts', (codec) => {
    const remotion = BrowserSafeApis.validPixelFormatsForCodec(codec) as readonly string[];
    expect([...pixelFormatsFor(codec)].sort()).toEqual([...remotion].sort());
    for (const pixelFormat of PIXEL_FORMATS) {
      const imageFormat = pixelFormat.startsWith('yuva') ? 'png' : 'jpeg';
      const ok = pathsFor({ codec, pixelFormat, imageFormat }).length === 0;
      expect({ codec, pixelFormat, ok }).toEqual({
        codec,
        pixelFormat,
        ok: remotion.includes(pixelFormat),
      });
    }
  });

  it.each(CODECS)('picks the same container extension as Remotion for %s', (codec) => {
    expect(containerFor(codec)).toBe(BrowserSafeApis.getFileExtensionFromCodec(codec, null));
  });
});

describe('CRF validation per codec', () => {
  it.each(CODECS.filter((c) => c !== 'prores'))(
    'accepts the edges of the %s range and rejects one past them',
    (codec) => {
      const range = crfRangeFor(codec)!;
      expect(pathsFor({ codec, crf: range.min })).toEqual([]);
      expect(pathsFor({ codec, crf: range.max })).toEqual([]);
      expect(pathsFor({ codec, crf: range.min - 1 })).toEqual(['output.crf']);
      expect(pathsFor({ codec, crf: range.max + 1 })).toEqual(['output.crf']);
    },
  );

  it('rejects CRF 0 for h264 (Remotion refuses it; such files do not play on Apple devices)', () => {
    expect(pathsFor({ codec: 'h264', crf: 0 })).toEqual(['output.crf']);
  });

  it('rejects any CRF for ProRes and names the profile instead', () => {
    const issues = issuesFor({ codec: 'prores', crf: 10 });
    expect(issues.map((i) => i.path.join('.'))).toEqual(['output.crf']);
    expect(issues[0]?.message).toMatch(/profile/i);
  });

  it('accepts null CRF (use the codec default) for every codec', () => {
    for (const codec of CODECS) {
      expect(pathsFor({ codec, crf: null })).toEqual([]);
    }
  });

  it('rejects fractional CRF values', () => {
    expect(pathsFor({ codec: 'h264', crf: 18.5 })).toEqual(['output.crf']);
  });

  it('reports the codec and range in the error message', () => {
    expect(issuesFor({ codec: 'vp9', crf: 70 })[0]?.message).toMatch(/0.*63.*vp9|vp9.*0.*63/);
  });
});

describe('hardware acceleration', () => {
  it.each(['if-possible', 'required'] as const)(
    'cannot be combined with an explicit CRF (%s)',
    (hardwareAcceleration) => {
      const issues = issuesFor({ codec: 'h264', crf: 20, hardwareAcceleration });
      expect(issues.map((i) => i.path.join('.'))).toEqual(['output.hardwareAcceleration']);
      expect(issues[0]?.message).toMatch(/CRF/);
    },
  );

  it('is fine with the codec-default CRF', () => {
    expect(pathsFor({ codec: 'h264', crf: null, hardwareAcceleration: 'required' })).toEqual([]);
  });

  it('allows an explicit CRF when disabled', () => {
    expect(pathsFor({ codec: 'h264', crf: 20, hardwareAcceleration: 'disable' })).toEqual([]);
  });

  it.each(['vp8', 'vp9', 'av1'] as const)(
    'cannot be required for %s, which has no hardware encoder',
    (codec) => {
      expect(pathsFor({ codec, hardwareAcceleration: 'required' })).toEqual([
        'output.hardwareAcceleration',
      ]);
    },
  );

  it.each(['h264', 'h265', 'prores'] as const)('can be required for %s', (codec) => {
    expect(pathsFor({ codec, hardwareAcceleration: 'required' })).toEqual([]);
  });

  it('is allowed as "if-possible" for any codec (Remotion falls back to software)', () => {
    for (const codec of CODECS) {
      expect(pathsFor({ codec, hardwareAcceleration: 'if-possible' })).toEqual([]);
    }
  });
});

describe('codec-specific options', () => {
  it('only allows an x264 preset with h264', () => {
    expect(pathsFor({ codec: 'h264', x264Preset: 'slow' })).toEqual([]);
    expect(pathsFor({ codec: 'h265', x264Preset: 'slow' })).toEqual(['output.x264Preset']);
    expect(pathsFor({ codec: 'h265', x264Preset: null })).toEqual([]);
  });

  it('requires PNG frames for transparent pixel formats', () => {
    expect(pathsFor({ codec: 'vp9', pixelFormat: 'yuva420p', imageFormat: 'jpeg' })).toEqual([
      'output.imageFormat',
    ]);
    expect(pathsFor({ codec: 'vp9', pixelFormat: 'yuva420p', imageFormat: 'png' })).toEqual([]);
    expect(
      pathsFor({
        codec: 'prores',
        pixelFormat: 'yuva444p10le',
        imageFormat: 'png',
        proResProfile: '4444',
      }),
    ).toEqual([]);
  });

  it('keeps JPEG quality within 0..100', () => {
    expect(pathsFor({ jpegQuality: 0 })).toEqual([]);
    expect(pathsFor({ jpegQuality: 100 })).toEqual([]);
    expect(pathsFor({ jpegQuality: 101 })).toEqual(['output.jpegQuality']);
    expect(pathsFor({ jpegQuality: -1 })).toEqual(['output.jpegQuality']);
  });

  it('accepts fps 24, 30 and 60 only', () => {
    for (const fps of [24, 30, 60] as const) {
      expect(pathsFor({ fps })).toEqual([]);
    }
    expect(pathsFor({ fps: 25 as never })).toEqual(['output.fps']);
  });

  it.each([
    [null, true],
    [1, true],
    [16, true],
    ['50%', true],
    ['12.5%', true],
    [0, false],
    [2.5, false],
    ['0%', false],
    ['101%', false],
    ['50', false],
    ['%', false],
  ] as const)('validates concurrency %j', (concurrency, ok) => {
    expect(pathsFor({ concurrency }).length === 0).toBe(ok);
  });
});

describe('resolution and dimensions', () => {
  it('maps 720p/1080p/4K to Remotion scale factors', () => {
    expect(resolutionScale('720p')).toBeCloseTo(2 / 3, 10);
    expect(resolutionScale('1080p')).toBe(1);
    expect(resolutionScale('4k')).toBe(2);
  });

  it.each([
    ['16:9', '1080p', 1920, 1080],
    ['16:9', '720p', 1280, 720],
    ['16:9', '4k', 3840, 2160],
    ['9:16', '1080p', 1080, 1920],
    ['9:16', '720p', 720, 1280],
    ['9:16', '4k', 2160, 3840],
    ['1:1', '1080p', 1080, 1080],
    ['1:1', '720p', 720, 720],
    ['1:1', '4k', 2160, 2160],
  ] as const)(
    'renders %s at %s as %dx%d (even dimensions for yuv420p)',
    (aspect, resolution, width, height) => {
      const dims = outputDimensions(aspect, resolution);
      expect(dims.output).toEqual({ width, height });
      expect(dims.output.width % 2).toBe(0);
      expect(dims.output.height % 2).toBe(0);
      // The composition is always laid out at the 1080p base and scaled by Remotion.
      expect(dims.composition.width * dims.scale).toBeCloseTo(width, 6);
    },
  );

  it('keeps the composition size independent of the output resolution', () => {
    const codecs: Codec[] = [...CODECS];
    expect(codecs.length).toBe(6);
    expect(outputDimensions('16:9', '4k').composition).toEqual(
      outputDimensions('16:9', '720p').composition,
    );
  });
});
