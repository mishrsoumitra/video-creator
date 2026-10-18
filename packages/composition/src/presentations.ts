import {
  TRANSITION_CATALOG,
  cssStandIn,
  deriveMotion,
  easingFunction,
  type TimingKind,
  type TransitionDirection,
  type TransitionName,
  type VideoConfig,
} from '@vc/config';
import {
  linearTiming,
  springTiming,
  type TransitionPresentation,
  type TransitionTiming,
} from '@remotion/transitions';
import { blurSlide } from '@remotion/transitions/blur-slide';
import { bookFlip } from '@remotion/transitions/book-flip';
import { clockWipe } from '@remotion/transitions/clock-wipe';
import { crossZoom } from '@remotion/transitions/cross-zoom';
import { crosswarp } from '@remotion/transitions/crosswarp';
import { dissolve } from '@remotion/transitions/dissolve';
import { dreamyZoom } from '@remotion/transitions/dreamy-zoom';
import { fade } from '@remotion/transitions/fade';
import { filmBurn } from '@remotion/transitions/film-burn';
import { flip } from '@remotion/transitions/flip';
import { iris } from '@remotion/transitions/iris';
import { linearBlur } from '@remotion/transitions/linear-blur';
import { none } from '@remotion/transitions/none';
import { pushCut } from '@remotion/transitions/push-cut';
import { ripple } from '@remotion/transitions/ripple';
import { slide } from '@remotion/transitions/slide';
import { swap } from '@remotion/transitions/swap';
import { wipe } from '@remotion/transitions/wipe';
import { zoomBlur } from '@remotion/transitions/zoom-blur';
import { zoomInOut } from '@remotion/transitions/zoom-in-out';

type Cardinal = 'from-left' | 'from-right' | 'from-top' | 'from-bottom';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPresentation = TransitionPresentation<any>;

const cardinal = (d: TransitionDirection | null): Cardinal => {
  if (!d) return 'from-right';
  if (d.endsWith('left')) return 'from-left';
  if (d.endsWith('right')) return 'from-right';
  return d as Cardinal;
};

const FACTORIES: Record<
  TransitionName,
  (args: {
    direction: TransitionDirection | null;
    width: number;
    height: number;
  }) => AnyPresentation
> = {
  fade: () => fade(),
  slide: ({ direction }) => slide({ direction: cardinal(direction) }),
  wipe: ({ direction }) => wipe({ direction: direction ?? 'from-right' }),
  flip: ({ direction }) => flip({ direction: cardinal(direction) }),
  'clock-wipe': ({ width, height }) => clockWipe({ width, height }),
  iris: ({ width, height }) => iris({ width, height }),
  none: () => none(),
  'push-cut': () => pushCut(),
  dissolve: () => dissolve({}),
  swap: () => swap({}),
  'zoom-in-out': () => zoomInOut({}),
  'cross-zoom': () => crossZoom({}),
  'zoom-blur': () => zoomBlur({}),
  'linear-blur': () => linearBlur({}),
  'blur-slide': ({ direction }) => blurSlide({ direction: cardinal(direction) }),
  'dreamy-zoom': () => dreamyZoom({}),
  'book-flip': ({ direction }) => bookFlip({ direction: cardinal(direction) }),
  crosswarp: () => crosswarp({}),
  ripple: () => ripple({}),
  'film-burn': () => filmBurn({}),
};

/**
 * The @remotion/transitions presentation for a cut. Shader presentations throw when the browser
 * has no HTML-in-canvas (most users' Chrome), so the preview gets the CSS stand-in; the final
 * render always has it (the renderer enables CanvasDrawElement).
 */
export const buildPresentation = ({
  name,
  direction,
  width,
  height,
  htmlInCanvasSupported,
}: {
  name: TransitionName;
  direction: TransitionDirection | null;
  width: number;
  height: number;
  htmlInCanvasSupported: boolean;
}): AnyPresentation => {
  const effective =
    TRANSITION_CATALOG[name].renderer === 'shader' && !htmlInCanvasSupported
      ? cssStandIn(name)
      : name;
  return FACTORIES[effective]({ direction, width, height });
};

export const buildTiming = ({
  kind,
  durationInFrames,
  config,
}: {
  kind: TimingKind;
  durationInFrames: number;
  config: VideoConfig;
}): TransitionTiming => {
  if (kind === 'spring') {
    // fps only matters to derive frame counts; the spring is stretched to durationInFrames anyway.
    return springTiming({
      config: deriveMotion(config, config.output.fps).captionSpring,
      durationInFrames,
    });
  }
  return linearTiming({ durationInFrames, easing: easingFunction(config.motion.easing) });
};
