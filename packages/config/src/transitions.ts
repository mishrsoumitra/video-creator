import { TRANSITION_NAMES, type TransitionDirection, type TransitionName } from './enums';

export type TransitionInfo = {
  readonly label: string;
  /** css = React/CSS presentation; shader = WebGL via HTML-in-canvas (needs Chrome's CanvasDrawElement). */
  readonly renderer: 'css' | 'shader';
  readonly directions: 'none' | 'cardinal' | 'all';
  /** Spec: "should be timed on a server before they are exposed; they may be shader-heavy." */
  readonly gated: boolean;
  /** Blur-based transitions are called out by the spec as multiplying frame time. */
  readonly blur: boolean;
  /** What the in-browser preview shows when HTML-in-canvas is unavailable. */
  readonly cssStandIn: TransitionName;
};

const css = (
  label: string,
  self: TransitionName,
  directions: TransitionInfo['directions'] = 'none',
): TransitionInfo => ({
  label,
  renderer: 'css',
  directions,
  gated: false,
  blur: false,
  cssStandIn: self,
});

const shader = (
  label: string,
  cssStandIn: TransitionName,
  extra: Partial<Pick<TransitionInfo, 'directions' | 'gated' | 'blur'>> = {},
): TransitionInfo => ({
  label,
  renderer: 'shader',
  directions: extra.directions ?? 'none',
  gated: extra.gated ?? false,
  blur: extra.blur ?? false,
  cssStandIn,
});

export const TRANSITION_CATALOG: Readonly<Record<TransitionName, TransitionInfo>> = Object.freeze({
  fade: css('Fade', 'fade'),
  slide: css('Slide', 'slide', 'cardinal'),
  wipe: css('Wipe', 'wipe', 'all'),
  flip: css('Flip', 'flip', 'cardinal'),
  'clock-wipe': css('Clock wipe', 'clock-wipe'),
  iris: css('Iris', 'iris'),
  none: css('Cut (none)', 'none'),
  'push-cut': css('Push cut', 'push-cut'),
  dissolve: shader('Dissolve', 'fade'),
  swap: shader('Swap', 'flip'),
  'zoom-in-out': shader('Zoom in/out', 'fade'),
  'cross-zoom': shader('Cross zoom', 'fade'),
  'zoom-blur': shader('Zoom blur', 'fade', { blur: true }),
  'linear-blur': shader('Linear blur', 'fade', { blur: true }),
  'blur-slide': shader('Blur slide', 'slide', { blur: true, directions: 'cardinal' }),
  'dreamy-zoom': shader('Dreamy zoom', 'fade'),
  'book-flip': shader('Book flip', 'flip', { directions: 'cardinal', gated: true }),
  crosswarp: shader('Crosswarp', 'fade', { gated: true }),
  ripple: shader('Ripple', 'fade', { gated: true }),
  'film-burn': shader('Film burn', 'fade', { gated: true }),
});

export const GATED_TRANSITIONS: readonly TransitionName[] = TRANSITION_NAMES.filter(
  (n) => TRANSITION_CATALOG[n].gated,
);

/** A gated transition is exposed only once the server has a timing measurement for it. */
export const isTransitionExposed = (
  name: TransitionName,
  timedTransitions: ReadonlySet<string>,
): boolean => !TRANSITION_CATALOG[name].gated || timedTransitions.has(name);

export const exposedTransitions = (timedTransitions: ReadonlySet<string>): TransitionName[] =>
  TRANSITION_NAMES.filter((n) => isTransitionExposed(n, timedTransitions));

export const cssStandIn = (name: TransitionName): TransitionName =>
  TRANSITION_CATALOG[name].cssStandIn;

const toCardinal = (direction: TransitionDirection): TransitionDirection => {
  if (direction.endsWith('-left')) return 'from-left';
  if (direction.endsWith('-right')) return 'from-right';
  return direction;
};

/** The direction a presentation actually receives, or null when it takes none. */
export const resolveTransitionDirection = (
  name: TransitionName,
  direction: TransitionDirection,
): TransitionDirection | null => {
  switch (TRANSITION_CATALOG[name].directions) {
    case 'none':
      return null;
    case 'all':
      return direction;
    case 'cardinal':
      return toCardinal(direction);
  }
};
