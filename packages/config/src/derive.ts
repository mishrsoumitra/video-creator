import { easingFunction } from './easing';
import type { ImageMove } from './enums';
import type { SpringConfig, VideoConfig } from './schema';

export type DerivedMotion = {
  readonly speed: number;
  /** Requested transition length before it is clamped to the neighbouring scenes. */
  readonly transitionFrames: number;
  readonly holdFrames: number;
  readonly zoomPerSecond: number;
  /**
   * Stiffness ×speed² and damping ×speed: an exact time compression of the base spring, so the
   * curve keeps its shape (same damping ratio) and simply runs `speed` times faster.
   */
  readonly captionSpring: SpringConfig;
};

/**
 * One speed number scales transition length, caption word-spring, zoom per second and the hold at
 * the start of each scene. It takes no scene boundaries and returns none: speed can never move
 * narration timing.
 */
export const deriveMotion = (config: VideoConfig, fps: number): DerivedMotion => {
  const speed = config.simple.animationSpeed;
  const { spring } = config.motion;
  return {
    speed,
    transitionFrames: Math.max(1, Math.round(config.transitions.durationInFrames / speed)),
    holdFrames: Math.round((config.motion.holdSeconds * fps) / speed),
    zoomPerSecond: config.motion.zoomPerSecond * speed,
    captionSpring: {
      mass: spring.mass,
      damping: spring.damping * speed,
      stiffness: spring.stiffness * speed * speed,
      overshootClamping: spring.overshootClamping,
    },
  };
};

export const imageMoveForScene = (config: VideoConfig, sceneIndex: number): ImageMove => {
  const moves = config.motion.imageMoves;
  return moves[((sceneIndex % moves.length) + moves.length) % moves.length]!;
};

export type ImageTransform = { scale: number; translateX: number; translateY: number };

const IDENTITY: ImageTransform = Object.freeze({ scale: 1, translateX: 0, translateY: 0 });
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The image transform at `frame` (0-based, within the scene). translateX/Y are fractions of the
 * frame size and always stay inside the overscan the scale provides, so no edge ever shows.
 */
export const imageMotionAt = (
  config: VideoConfig,
  {
    sceneIndex,
    frame,
    sceneFrames,
    fps,
  }: { sceneIndex: number; frame: number; sceneFrames: number; fps: number },
): ImageTransform => {
  const move = imageMoveForScene(config, sceneIndex);
  if (move === 'none' || sceneFrames <= 0) return { ...IDENTITY };
  const { holdFrames, zoomPerSecond } = deriveMotion(config, fps);
  const hold = Math.min(holdFrames, sceneFrames - 1);
  const moveFrames = Math.max(1, sceneFrames - hold);
  const target = Math.min(config.motion.zoomAmount, 1 + zoomPerSecond * (moveFrames / fps));
  if (target <= 1) return { ...IDENTITY };

  const f = clamp(frame, 0, sceneFrames - 1);
  const raw = moveFrames <= 1 ? 1 : clamp((f - hold) / (moveFrames - 1), 0, 1);
  const p = easingFunction(config.motion.easing)(raw);
  const range = (target - 1) / 2;
  const direction = sceneIndex % 2 === 0 ? 1 : -1;
  // Overshooting easings (back, elastic, bezier y > 1) must not push past the safe overscan.
  const travel = clamp(-range + 2 * range * p, -range, range) * direction;

  switch (move) {
    case 'push-in':
      return { scale: clamp(1 + (target - 1) * p, 1, target), translateX: 0, translateY: 0 };
    case 'pull-out':
      return { scale: clamp(target - (target - 1) * p, 1, target), translateX: 0, translateY: 0 };
    case 'drift-lr':
      return { scale: target, translateX: travel, translateY: 0 };
    case 'drift-ud':
      return { scale: target, translateX: 0, translateY: travel };
  }
};
