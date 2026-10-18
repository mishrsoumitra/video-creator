/**
 * Every enumerated option in the config. Values that mirror Remotion are cross-checked against the
 * installed @remotion/* packages in the tests (codecs.test.ts, transitions.test.ts).
 */

export const ANIMATION_KINDS = ['calm', 'documentary', 'dynamic', 'cinematic', 'minimal'] as const;
export type AnimationKind = (typeof ANIMATION_KINDS)[number];

export const BACKDROP_KINDS = ['dark', 'light', 'gradient', 'blurred-image', 'textured'] as const;
export type BackdropKind = (typeof BACKDROP_KINDS)[number];

export const CAPTION_STYLES = [
  'kinetic-words',
  'phrase-cards',
  'underline-highlight',
  'off',
] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

export const ASPECTS = ['16:9', '9:16', '1:1'] as const;
export type Aspect = (typeof ASPECTS)[number];

export const IMAGE_MOVES = ['push-in', 'pull-out', 'drift-lr', 'drift-ud', 'none'] as const;
export type ImageMove = (typeof IMAGE_MOVES)[number];

/** Remotion Easing functions exposed in the UI (step0/step1/poly/spring are left out). */
export const EASING_TYPES = [
  'linear',
  'ease',
  'quad',
  'cubic',
  'sin',
  'exp',
  'circle',
  'back',
  'bounce',
  'elastic',
  'bezier',
] as const;
export type EasingType = (typeof EASING_TYPES)[number];

export const EASING_DIRECTIONS = ['in', 'out', 'in-out'] as const;
export type EasingDirection = (typeof EASING_DIRECTIONS)[number];

/** Spec order. Kept in sync with the subpath exports of @remotion/transitions (tested). */
export const TRANSITION_NAMES = [
  'fade',
  'slide',
  'wipe',
  'flip',
  'clock-wipe',
  'iris',
  'none',
  'dissolve',
  'push-cut',
  'swap',
  'zoom-in-out',
  'cross-zoom',
  'zoom-blur',
  'linear-blur',
  'blur-slide',
  'dreamy-zoom',
  'book-flip',
  'crosswarp',
  'ripple',
  'film-burn',
] as const;
export type TransitionName = (typeof TRANSITION_NAMES)[number];

export const TRANSITION_DIRECTIONS = [
  'from-left',
  'from-right',
  'from-top',
  'from-bottom',
  'from-top-left',
  'from-top-right',
  'from-bottom-left',
  'from-bottom-right',
] as const;
export type TransitionDirection = (typeof TRANSITION_DIRECTIONS)[number];

export const TIMING_KINDS = ['linear', 'spring'] as const;
export type TimingKind = (typeof TIMING_KINDS)[number];

export const CAPTION_POSITIONS = ['lower-third', 'auto', 'follow-subject'] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];

export const HIGHLIGHT_ANIMATIONS = ['scale', 'underline', 'box', 'colour'] as const;
export type HighlightAnimation = (typeof HIGHLIGHT_ANIMATIONS)[number];

export const TEXT_FIT_MODES = ['shrink', 'wrap'] as const;
export type TextFitMode = (typeof TEXT_FIT_MODES)[number];

/** cover = full-bleed; card = soft card on the backdrop; contain = whole image over a blurred copy. */
export const IMAGE_FITS = ['cover', 'card', 'contain'] as const;
export type ImageFit = (typeof IMAGE_FITS)[number];

export const PALETTE_SOURCES = ['custom', 'image'] as const;
export type PaletteSource = (typeof PALETTE_SOURCES)[number];

export const MUSIC_SOURCES = ['none', 'library', 'upload'] as const;
export type MusicSource = (typeof MUSIC_SOURCES)[number];

export const LETTERBOX_RATIOS = ['2.39:1', '2:1', '1.85:1'] as const;
export type LetterboxRatio = (typeof LETTERBOX_RATIOS)[number];

export const ZIGZAG_DIRECTIONS = ['horizontal', 'vertical'] as const;
export type ZigzagDirection = (typeof ZIGZAG_DIRECTIONS)[number];

export const CODECS = ['h264', 'h265', 'vp8', 'vp9', 'av1', 'prores'] as const;
export type Codec = (typeof CODECS)[number];

export const PRORES_PROFILES = ['4444-xq', '4444', 'hq', 'standard', 'light', 'proxy'] as const;
export type ProResProfile = (typeof PRORES_PROFILES)[number];

export const FPS_OPTIONS = [24, 30, 60] as const;
export type Fps = (typeof FPS_OPTIONS)[number];

export const RESOLUTIONS = ['720p', '1080p', '4k'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const X264_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
  'placebo',
] as const;
export type X264Preset = (typeof X264_PRESETS)[number];

export const PIXEL_FORMATS = [
  'yuv420p',
  'yuva420p',
  'yuv422p',
  'yuv444p',
  'yuv420p10le',
  'yuv422p10le',
  'yuv444p10le',
  'yuva444p10le',
] as const;
export type PixelFormat = (typeof PIXEL_FORMATS)[number];

export const COLOR_SPACES = ['default', 'bt601', 'bt709', 'bt2020-ncl'] as const;
export type ColorSpace = (typeof COLOR_SPACES)[number];

export const IMAGE_FORMATS = ['jpeg', 'png'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export const HARDWARE_ACCELERATION = ['disable', 'if-possible', 'required'] as const;
export type HardwareAcceleration = (typeof HARDWARE_ACCELERATION)[number];

/** The length buttons on the create screen. */
export const LENGTH_PRESETS_SECONDS = [30, 60, 90, 180, 300] as const;
