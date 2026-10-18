import { zColor } from '@remotion/zod-types';
import { z } from 'zod';
import {
  crfRangeFor,
  isTransparentPixelFormat,
  pixelFormatsFor,
  supportsHardwareAcceleration,
} from './codecs';
import {
  ANIMATION_KINDS,
  ASPECTS,
  BACKDROP_KINDS,
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  CODECS,
  COLOR_SPACES,
  EASING_DIRECTIONS,
  HARDWARE_ACCELERATION,
  HIGHLIGHT_ANIMATIONS,
  IMAGE_FITS,
  IMAGE_FORMATS,
  IMAGE_MOVES,
  LETTERBOX_RATIOS,
  MUSIC_SOURCES,
  PALETTE_SOURCES,
  PIXEL_FORMATS,
  PRORES_PROFILES,
  RESOLUTIONS,
  TEXT_FIT_MODES,
  TIMING_KINDS,
  TRANSITION_DIRECTIONS,
  TRANSITION_NAMES,
  X264_PRESETS,
  ZIGZAG_DIRECTIONS,
  type ImageMove,
  type TransitionName,
} from './enums';

export const CONFIG_VERSION = 1 as const;

// zColor() is Remotion's colour type: Studio shows a colour picker for it.
const color = (fallback: string) => zColor().default(fallback);
const unit = (fallback: number) => z.number().min(0).max(1).default(fallback);
const toggle = (fallback: boolean) => z.boolean().default(fallback);
const uv = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);

/* ------------------------------------------------------------------ simple */

export const SimpleSchema = z.strictObject({
  animationKind: z.enum(ANIMATION_KINDS).default('documentary'),
  backdropKind: z.enum(BACKDROP_KINDS).default('dark'),
  animationSpeed: z.number().min(0.5).max(2).default(1),
  captionStyle: z.enum(CAPTION_STYLES).default('phrase-cards'),
  aspect: z.enum(ASPECTS).default('16:9'),
});

/* ------------------------------------------------------------------ motion */

const easingDirection = z.enum(EASING_DIRECTIONS).default('in-out');

/** Remotion Easing. Bezier x values must lie in [0, 1] (Remotion throws otherwise). */
export const EasingSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('linear') }),
  z.strictObject({
    type: z.literal(['ease', 'quad', 'cubic', 'sin', 'exp', 'circle', 'bounce']),
    direction: easingDirection,
  }),
  z.strictObject({
    type: z.literal('back'),
    direction: easingDirection,
    overshoot: z.number().min(0).max(10).default(1.70158),
  }),
  z.strictObject({
    type: z.literal('elastic'),
    direction: easingDirection,
    bounciness: z.number().min(0).max(10).default(1),
  }),
  z.strictObject({
    type: z.literal('bezier'),
    x1: z.number().min(0).max(1),
    y1: z.number().min(-2).max(3),
    x2: z.number().min(0).max(1),
    y2: z.number().min(-2).max(3),
  }),
]);

/** Remotion spring() config. Defaults are Remotion's: mass 1, damping 10, stiffness 100. */
export const SpringSchema = z.strictObject({
  mass: z.number().gt(0).max(20).default(1),
  damping: z.number().gt(0).max(1000).default(10),
  stiffness: z.number().gt(0).max(5000).default(100),
  overshootClamping: toggle(false),
});

export const MotionSchema = z.strictObject({
  imageMoves: z
    .array(z.enum(IMAGE_MOVES))
    .min(1)
    .max(8)
    .default((): ImageMove[] => ['push-in', 'drift-lr', 'push-in', 'drift-ud', 'none']),
  zoomAmount: z.number().min(1).max(1.4).default(1.15),
  zoomPerSecond: z.number().min(0).max(0.2).default(0.03),
  holdSeconds: z.number().min(0).max(3).default(0.4),
  easing: EasingSchema.default(() => ({ type: 'ease' as const, direction: 'in-out' as const })),
  spring: SpringSchema.prefault({}),
  motionBlur: z
    .strictObject({
      enabled: toggle(false),
      samples: z.int().min(1).max(64).default(10),
      shutterAngle: z.number().min(1).max(360).default(180),
    })
    .prefault({}),
});

/* ------------------------------------------------------------- transitions */

export const TransitionsSchema = z.strictObject({
  presentations: z
    .array(z.enum(TRANSITION_NAMES))
    .min(1)
    .max(8)
    .default((): TransitionName[] => ['wipe', 'slide']),
  timing: z.enum(TIMING_KINDS).default('linear'),
  durationInFrames: z.int().min(1).max(120).default(18),
  direction: z.enum(TRANSITION_DIRECTIONS).default('from-right'),
});

/* ---------------------------------------------------------------- captions */

export const CaptionsSchema = z
  .strictObject({
    combineTokensWithinMilliseconds: z.int().min(0).max(5000).default(1200),
    breakOnSilenceAfterMilliseconds: z.int().min(0).max(5000).nullable().default(700),
    fontFamily: z.string().trim().min(1).max(100).default('Inter'),
    fontWeight: z.int().min(100).max(900).multipleOf(100).default(700),
    fontSize: z.int().min(16).max(200).default(64),
    minFontSize: z.int().min(12).max(200).default(36),
    maxCharsPerLine: z.int().min(8).max(80).default(32),
    maxLines: z.int().min(1).max(4).default(2),
    fitMode: z.enum(TEXT_FIT_MODES).default('shrink'),
    textColor: color('#FFFFFF'),
    highlightColor: color('#FFD60A'),
    highlightAnimation: z.enum(HIGHLIGHT_ANIMATIONS).default('colour'),
    outlineColor: color('#000000'),
    outlineWidth: z.number().min(0).max(16).default(6),
    position: z.enum(CAPTION_POSITIONS).default('lower-third'),
    burnIn: toggle(true),
  })
  .superRefine((c, ctx) => {
    if (c.minFontSize > c.fontSize) {
      ctx.addIssue({
        code: 'custom',
        path: ['minFontSize'],
        message: `Minimum font size (${c.minFontSize}) cannot be larger than the font size (${c.fontSize}).`,
      });
    }
  });

/* --------------------------------------------------------------- backdrop */

export const BackdropSchema = z.strictObject({
  palette: z
    .strictObject({
      source: z.enum(PALETTE_SOURCES).default('custom'),
      colors: z
        .array(zColor())
        .length(5)
        .default(() => ['#0B0B0F', '#1C1F2A', '#F5B700', '#F2F2F2', '#4C8DFF']),
    })
    .prefault({}),
  imageFit: z.enum(IMAGE_FITS).default('cover'),
  card: z
    .strictObject({
      radius: z.int().min(0).max(80).default(24),
      shadow: unit(0.35),
      margin: z.number().min(0).max(0.3).default(0.06),
    })
    .prefault({}),
  blur: z
    .strictObject({ radius: z.int().min(0).max(120).default(48), darken: unit(0.35) })
    .prefault({}),
  linearGradient: z
    .strictObject({
      enabled: toggle(false),
      start: uv.default(() => [0, 0] as [number, number]),
      end: uv.default(() => [1, 1] as [number, number]),
    })
    .prefault({}),
  tint: z
    .strictObject({ enabled: toggle(false), color: color('#4C8DFF'), amount: unit(0.15) })
    .prefault({}),
  rings: z
    .strictObject({
      enabled: toggle(false),
      thickness: z.number().min(0.1).max(400).default(40),
      gap: z.number().min(0).max(400).default(0),
      opacity: unit(0.12),
    })
    .prefault({}),
  gridlines: z
    .strictObject({
      enabled: toggle(false),
      gridSize: z.int().min(1).max(400).default(64),
      lineWidth: z.number().min(0).max(100).default(2),
      opacity: unit(0.12),
    })
    .prefault({}),
  checkerboard: z
    .strictObject({
      enabled: toggle(false),
      cellSize: z.number().min(0.1).max(800).default(80),
      gap: z.number().min(0).max(400).default(0),
      angle: z.number().min(-180).max(180).default(0),
      opacity: unit(0.1),
    })
    .prefault({}),
  zigzag: z
    .strictObject({
      enabled: toggle(false),
      direction: z.enum(ZIGZAG_DIRECTIONS).default('horizontal'),
      thickness: z.number().min(0.1).max(400).default(40),
      gap: z.number().min(0).max(400).default(0),
      opacity: unit(0.1),
    })
    .prefault({}),
  tile: z
    .strictObject({ enabled: toggle(false), horizontal: toggle(true), vertical: toggle(true) })
    .prefault({}),
  lightLeaks: z
    .strictObject({
      enabled: toggle(false),
      intensity: unit(0.4),
      hueShift: z.number().min(0).max(360).default(0),
      seed: z.int().min(0).max(10_000).default(0),
    })
    .prefault({}),
  starburst: z
    .strictObject({
      enabled: toggle(false),
      intensity: unit(0.2),
      rays: z.int().min(4).max(64).default(16),
      rotationPerSecond: z.number().min(-90).max(90).default(6),
    })
    .prefault({}),
  vignette: z
    .strictObject({
      enabled: toggle(false),
      amount: unit(0.4),
      radius: unit(0.65),
      feather: unit(0.35),
    })
    .prefault({}),
  grain: z
    .strictObject({
      enabled: toggle(false),
      amount: unit(0.06),
      size: z.number().min(1).max(8).default(2),
      animated: toggle(true),
    })
    .prefault({}),
  letterbox: z
    .strictObject({ enabled: toggle(false), ratio: z.enum(LETTERBOX_RATIOS).default('2.39:1') })
    .prefault({}),
});

/* ------------------------------------------------------------------- audio */

export const AudioSchema = z
  .strictObject({
    music: z
      .strictObject({
        source: z.enum(MUSIC_SOURCES).default('none'),
        trackId: z.string().min(1).max(100).nullable().default(null),
        uploadId: z.string().min(1).max(100).nullable().default(null),
        volume: unit(0.25),
      })
      .superRefine((m, ctx) => {
        if (m.source === 'library' && m.trackId === null) {
          ctx.addIssue({
            code: 'custom',
            path: ['trackId'],
            message: 'Pick a library track, or set music to none.',
          });
        }
        if (m.source === 'upload' && m.uploadId === null) {
          ctx.addIssue({
            code: 'custom',
            path: ['uploadId'],
            message: 'Upload a music file, or set music to none.',
          });
        }
      })
      .prefault({}),
    ducking: z
      .strictObject({
        enabled: toggle(true),
        depthDb: z.number().min(0).max(30).default(12),
        attackMs: z.number().min(1).max(2000).default(30),
        releaseMs: z.number().min(10).max(5000).default(400),
      })
      .prefault({}),
    loudnessTargetLufs: z.number().min(-30).max(-5).default(-14),
    narrationVolume: z.number().min(0).max(2).default(1),
    narrationPlaybackRate: z.number().min(0.5).max(2).default(1),
    unlockPlaybackRate: toggle(false),
  })
  .superRefine((a, ctx) => {
    if (!a.unlockPlaybackRate && a.narrationPlaybackRate !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['narrationPlaybackRate'],
        message:
          'Narration playbackRate is locked at 1.0 because changing it breaks the word timings. Unlock it first.',
      });
    }
  });

/* ------------------------------------------------------------------ output */

const concurrency = z
  .union([
    z.int().min(1).max(512),
    z
      .string()
      .regex(/^\d+(\.\d+)?%$/, 'Use a whole number of cores or a percentage such as "50%".')
      .refine((v) => {
        const pct = Number.parseFloat(v);
        return pct > 0 && pct <= 100;
      }, 'A percentage must be above 0% and at most 100%.'),
  ])
  .nullable()
  .default(null);

export const OutputSchema = z
  .strictObject({
    codec: z.enum(CODECS).default('h264'),
    /** null = the codec's own default CRF. The valid range depends on the codec. */
    crf: z.int().nullable().default(null),
    proResProfile: z.enum(PRORES_PROFILES).default('hq'),
    fps: z.literal([24, 30, 60]).default(30),
    resolution: z.enum(RESOLUTIONS).default('1080p'),
    x264Preset: z.enum(X264_PRESETS).nullable().default(null),
    pixelFormat: z.enum(PIXEL_FORMATS).default('yuv420p'),
    colorSpace: z.enum(COLOR_SPACES).default('default'),
    imageFormat: z.enum(IMAGE_FORMATS).default('jpeg'),
    jpegQuality: z.int().min(0).max(100).default(80),
    concurrency,
    hardwareAcceleration: z.enum(HARDWARE_ACCELERATION).default('disable'),
  })
  .superRefine((o, ctx) => {
    const issue = (key: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [key], message });
    if (o.crf !== null) {
      const range = crfRangeFor(o.codec);
      if (range === null) {
        issue('crf', 'ProRes has no CRF; it uses a profile (proResProfile). Clear the CRF.');
      } else if (o.crf < range.min || o.crf > range.max) {
        issue('crf', `CRF must be between ${range.min} and ${range.max} for ${o.codec}.`);
      } else if (o.hardwareAcceleration !== 'disable') {
        issue(
          'hardwareAcceleration',
          'Hardware acceleration cannot be combined with an explicit CRF. Clear the CRF or disable acceleration.',
        );
      }
    }
    if (o.hardwareAcceleration === 'required' && !supportsHardwareAcceleration(o.codec)) {
      issue(
        'hardwareAcceleration',
        `${o.codec} has no hardware encoder. Use "if-possible" or "disable".`,
      );
    }
    if (o.x264Preset !== null && o.codec !== 'h264') {
      issue('x264Preset', 'x264 presets only apply to the h264 codec.');
    }
    if (!pixelFormatsFor(o.codec).includes(o.pixelFormat)) {
      issue('pixelFormat', `${o.pixelFormat} is not supported by ${o.codec}.`);
    } else if (isTransparentPixelFormat(o.pixelFormat) && o.imageFormat !== 'png') {
      issue('imageFormat', `Transparent pixel format ${o.pixelFormat} needs PNG frames.`);
    }
  });

/* ------------------------------------------------------------------ config */

export const VideoConfigSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
  /** Which preset this config started from, for display only. */
  basedOnPreset: z.string().min(1).max(80).nullable().default(null),
  simple: SimpleSchema.prefault({}),
  motion: MotionSchema.prefault({}),
  transitions: TransitionsSchema.prefault({}),
  captions: CaptionsSchema.prefault({}),
  backdrop: BackdropSchema.prefault({}),
  audio: AudioSchema.prefault({}),
  output: OutputSchema.prefault({}),
});

export type VideoConfig = z.output<typeof VideoConfigSchema>;
export type VideoConfigInput = z.input<typeof VideoConfigSchema>;
export type Easing = z.output<typeof EasingSchema>;
export type SpringConfig = z.output<typeof SpringSchema>;
export type MotionConfig = z.output<typeof MotionSchema>;
export type TransitionsConfig = z.output<typeof TransitionsSchema>;
export type CaptionsConfig = z.output<typeof CaptionsSchema>;
export type BackdropConfig = z.output<typeof BackdropSchema>;
export type AudioConfig = z.output<typeof AudioSchema>;
export type OutputConfig = z.output<typeof OutputSchema>;
