import type { AnimationKind, Aspect, BackdropKind, CaptionStyle } from './enums';
import type {
  BackdropConfig,
  CaptionsConfig,
  MotionConfig,
  TransitionsConfig,
  VideoConfig,
} from './schema';
import { isTransitionExposed } from './transitions';

type MotionBundle = Omit<MotionConfig, 'motionBlur'>;

type AnimationBundle = {
  motion: MotionBundle;
  transitions: (
    exposed: (name: TransitionsConfig['presentations'][number]) => boolean,
  ) => TransitionsConfig;
  letterbox: boolean;
  lightLeaks: { enabled: boolean; intensity: number };
  /** Average scene length the script stage aims for. */
  sceneSeconds: number;
};

/** Spec table "Animation kind sets how images move and how scenes join". */
const ANIMATION_BUNDLES: Readonly<Record<AnimationKind, AnimationBundle>> = {
  calm: {
    motion: {
      imageMoves: ['push-in'],
      zoomAmount: 1.1,
      zoomPerSecond: 0.02,
      holdSeconds: 0.6,
      easing: { type: 'sin', direction: 'in-out' },
      spring: { mass: 1, damping: 18, stiffness: 80, overshootClamping: false },
    },
    transitions: () => ({
      presentations: ['fade'],
      timing: 'linear',
      durationInFrames: 24,
      direction: 'from-right',
    }),
    letterbox: false,
    lightLeaks: { enabled: false, intensity: 0.4 },
    sceneSeconds: 7,
  },
  documentary: {
    motion: {
      imageMoves: ['push-in', 'drift-lr', 'push-in', 'drift-ud', 'none'],
      zoomAmount: 1.15,
      zoomPerSecond: 0.03,
      holdSeconds: 0.4,
      easing: { type: 'ease', direction: 'in-out' },
      spring: { mass: 1, damping: 10, stiffness: 100, overshootClamping: false },
    },
    transitions: () => ({
      presentations: ['wipe', 'slide'],
      timing: 'linear',
      durationInFrames: 18,
      direction: 'from-right',
    }),
    letterbox: false,
    lightLeaks: { enabled: false, intensity: 0.4 },
    sceneSeconds: 6,
  },
  dynamic: {
    motion: {
      imageMoves: ['push-in', 'pull-out'],
      zoomAmount: 1.3,
      zoomPerSecond: 0.07,
      holdSeconds: 0.1,
      easing: { type: 'cubic', direction: 'out' },
      spring: { mass: 0.6, damping: 14, stiffness: 240, overshootClamping: true },
    },
    transitions: () => ({
      presentations: ['push-cut', 'zoom-in-out', 'cross-zoom'],
      timing: 'spring',
      durationInFrames: 12,
      direction: 'from-right',
    }),
    letterbox: false,
    lightLeaks: { enabled: false, intensity: 0.4 },
    sceneSeconds: 3.5,
  },
  cinematic: {
    motion: {
      imageMoves: ['drift-lr', 'drift-ud'],
      zoomAmount: 1.12,
      zoomPerSecond: 0.015,
      holdSeconds: 0.8,
      easing: { type: 'sin', direction: 'in-out' },
      spring: { mass: 1, damping: 20, stiffness: 70, overshootClamping: false },
    },
    // film-burn is shader-heavy and gated: it joins the cycle only once it has been timed.
    transitions: (exposed) => ({
      presentations: exposed('film-burn') ? ['dissolve', 'film-burn'] : ['dissolve'],
      timing: 'linear',
      durationInFrames: 30,
      direction: 'from-right',
    }),
    letterbox: true,
    lightLeaks: { enabled: true, intensity: 0.35 },
    sceneSeconds: 9,
  },
  minimal: {
    motion: {
      imageMoves: ['none'],
      zoomAmount: 1,
      zoomPerSecond: 0,
      holdSeconds: 0,
      easing: { type: 'linear' },
      spring: { mass: 1, damping: 26, stiffness: 170, overshootClamping: true },
    },
    transitions: () => ({
      presentations: ['none'],
      timing: 'linear',
      durationInFrames: 8,
      direction: 'from-right',
    }),
    letterbox: false,
    lightLeaks: { enabled: false, intensity: 0.4 },
    sceneSeconds: 5,
  },
};

export type ApplyKindOptions = { timedTransitions: ReadonlySet<string> };

export const applyAnimationKind = (
  config: VideoConfig,
  kind: AnimationKind,
  { timedTransitions }: ApplyKindOptions,
): VideoConfig => {
  const bundle = ANIMATION_BUNDLES[kind];
  const next = structuredClone(config);
  next.simple.animationKind = kind;
  next.motion = { ...structuredClone(bundle.motion), motionBlur: next.motion.motionBlur };
  next.transitions = bundle.transitions((name) => isTransitionExposed(name, timedTransitions));
  next.backdrop.letterbox.enabled = bundle.letterbox;
  next.backdrop.lightLeaks.enabled = bundle.lightLeaks.enabled;
  next.backdrop.lightLeaks.intensity = bundle.lightLeaks.intensity;
  return next;
};

/** The script stage reads this: Dynamic gets more, shorter scenes; Cinematic fewer, longer ones. */
export const sceneTargetSeconds = (kind: AnimationKind): number =>
  ANIMATION_BUNDLES[kind].sceneSeconds;

export const MAX_SCENES = 80;

export const targetSceneCount = (lengthSeconds: number, kind: AnimationKind): number => {
  if (!Number.isFinite(lengthSeconds) || lengthSeconds <= 0)
    throw new RangeError('Length must be a positive number of seconds.');
  return Math.min(MAX_SCENES, Math.max(1, Math.round(lengthSeconds / sceneTargetSeconds(kind))));
};

/* ----------------------------------------------------------------- backdrop */

type BackdropBundle = {
  palette: [string, string, string, string, string];
  imageFit: BackdropConfig['imageFit'];
  /** Effects switched on by this kind; every other pattern/texture effect is switched off. */
  on: Partial<Pick<BackdropConfig, 'linearGradient' | 'grain' | 'gridlines' | 'rings'>>;
  captions: Pick<CaptionsConfig, 'textColor' | 'outlineColor' | 'outlineWidth'>;
};

const BACKDROP_BUNDLES: Readonly<Record<BackdropKind, BackdropBundle>> = {
  dark: {
    palette: ['#0B0B0F', '#1C1F2A', '#F5B700', '#F2F2F2', '#4C8DFF'],
    imageFit: 'cover',
    on: {},
    captions: { textColor: '#FFFFFF', outlineColor: '#000000', outlineWidth: 6 },
  },
  light: {
    palette: ['#F5F3EE', '#E8E3D9', '#C2410C', '#1F2937', '#2563EB'],
    imageFit: 'card',
    on: {},
    captions: { textColor: '#1F2937', outlineColor: '#F5F3EE', outlineWidth: 0 },
  },
  gradient: {
    palette: ['#1E1B4B', '#7C3AED', '#F59E0B', '#F8FAFC', '#22D3EE'],
    imageFit: 'card',
    on: { linearGradient: { enabled: true, start: [0, 0], end: [1, 1] } },
    captions: { textColor: '#FFFFFF', outlineColor: '#1E1B4B', outlineWidth: 0 },
  },
  'blurred-image': {
    palette: ['#0B0B0F', '#1C1F2A', '#F5B700', '#F2F2F2', '#4C8DFF'],
    imageFit: 'contain',
    on: {},
    captions: { textColor: '#FFFFFF', outlineColor: '#000000', outlineWidth: 6 },
  },
  textured: {
    palette: ['#111827', '#1F2937', '#F59E0B', '#F9FAFB', '#60A5FA'],
    imageFit: 'card',
    on: {
      grain: { enabled: true, amount: 0.06, size: 2, animated: true },
      gridlines: { enabled: true, gridSize: 64, lineWidth: 2, opacity: 0.12 },
    },
    captions: { textColor: '#F9FAFB', outlineColor: '#111827', outlineWidth: 0 },
  },
};

const PATTERN_EFFECTS = [
  'linearGradient',
  'rings',
  'gridlines',
  'checkerboard',
  'zigzag',
  'tile',
  'grain',
  'tint',
  'vignette',
  'starburst',
] as const;

export const applyBackdropKind = (config: VideoConfig, kind: BackdropKind): VideoConfig => {
  const bundle = BACKDROP_BUNDLES[kind];
  const next = structuredClone(config);
  next.simple.backdropKind = kind;
  next.backdrop.palette = { source: 'custom', colors: [...bundle.palette] };
  next.backdrop.imageFit = bundle.imageFit;
  for (const effect of PATTERN_EFFECTS) next.backdrop[effect].enabled = false;
  if (kind === 'blurred-image') next.backdrop.blur = { radius: 48, darken: 0.35 };
  if (bundle.imageFit === 'card') next.backdrop.card = { radius: 24, shadow: 0.35, margin: 0.06 };
  Object.assign(next.backdrop, structuredClone(bundle.on));
  Object.assign(next.captions, bundle.captions);
  return next;
};

/* ------------------------------------------------------------------ captions */

const CAPTION_BUNDLES: Readonly<Record<Exclude<CaptionStyle, 'off'>, Partial<CaptionsConfig>>> = {
  'kinetic-words': {
    highlightAnimation: 'scale',
    combineTokensWithinMilliseconds: 400,
    breakOnSilenceAfterMilliseconds: 500,
  },
  'phrase-cards': {
    highlightAnimation: 'colour',
    combineTokensWithinMilliseconds: 1200,
    breakOnSilenceAfterMilliseconds: 700,
  },
  'underline-highlight': {
    highlightAnimation: 'underline',
    combineTokensWithinMilliseconds: 1000,
    breakOnSilenceAfterMilliseconds: 700,
  },
};

/** "Off" changes nothing else: the .srt is still written with the current grouping. */
export const applyCaptionStyle = (config: VideoConfig, style: CaptionStyle): VideoConfig => {
  const next = structuredClone(config);
  next.simple.captionStyle = style;
  if (style !== 'off') Object.assign(next.captions, CAPTION_BUNDLES[style]);
  return next;
};

export const applyAspect = (config: VideoConfig, aspect: Aspect): VideoConfig => {
  const next = structuredClone(config);
  next.simple.aspect = aspect;
  return next;
};

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

export const applySpeed = (config: VideoConfig, speed: number): VideoConfig => {
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    throw new RangeError(`Animation speed must be between ${MIN_SPEED}x and ${MAX_SPEED}x.`);
  }
  const next = structuredClone(config);
  next.simple.animationSpeed = speed;
  return next;
};
