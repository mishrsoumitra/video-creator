import { spring } from 'remotion';
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_DEFAULTS,
  deriveMotion,
  imageMoveForScene,
  imageMotionAt,
  mergeConfig,
  type VideoConfig,
} from './index';

const at = (speed: number, patch: Parameters<typeof mergeConfig>[1] = {}): VideoConfig =>
  mergeConfig(SCHEMA_DEFAULTS, { ...patch, simple: { animationSpeed: speed } });

describe('deriveMotion: one speed number scales several things together', () => {
  const base = mergeConfig(SCHEMA_DEFAULTS, {
    transitions: { durationInFrames: 20 },
    motion: {
      zoomPerSecond: 0.04,
      holdSeconds: 0.5,
      spring: { mass: 1, damping: 12, stiffness: 120 },
    },
  });
  const derive = (speed: number, fps = 30) =>
    deriveMotion({ ...base, simple: { ...base.simple, animationSpeed: speed } }, fps);

  it('returns the base values at 1x', () => {
    const d = derive(1);
    expect(d.transitionFrames).toBe(20);
    expect(d.zoomPerSecond).toBeCloseTo(0.04, 10);
    expect(d.holdFrames).toBe(15);
    expect(d.captionSpring).toEqual({
      mass: 1,
      damping: 12,
      stiffness: 120,
      overshootClamping: false,
    });
  });

  it('at 2x halves transitions and holds, doubles zoom rate, stiffens the spring', () => {
    const d = derive(2);
    expect(d.transitionFrames).toBe(10);
    expect(d.holdFrames).toBe(8);
    expect(d.zoomPerSecond).toBeCloseTo(0.08, 10);
    expect(d.captionSpring.stiffness).toBeCloseTo(480, 10);
    expect(d.captionSpring.damping).toBeCloseTo(24, 10);
    expect(d.captionSpring.mass).toBe(1);
  });

  it('at 0.5x doubles transitions and holds, halves zoom rate, softens the spring', () => {
    const d = derive(0.5);
    expect(d.transitionFrames).toBe(40);
    expect(d.holdFrames).toBe(30);
    expect(d.zoomPerSecond).toBeCloseTo(0.02, 10);
    expect(d.captionSpring.stiffness).toBeCloseTo(30, 10);
    expect(d.captionSpring.damping).toBeCloseTo(6, 10);
  });

  it('never shortens a transition below one frame', () => {
    const tiny = mergeConfig(SCHEMA_DEFAULTS, {
      transitions: { durationInFrames: 1 },
      simple: { animationSpeed: 2 },
    });
    expect(deriveMotion(tiny, 30).transitionFrames).toBe(1);
  });

  it('scales the hold with fps', () => {
    expect(derive(1, 60).holdFrames).toBe(30);
    expect(derive(1, 24).holdFrames).toBe(12);
  });

  it.each([0.5, 2])(
    'makes the caption spring an exact time compression of the base spring at %sx',
    (speed) => {
      const d = derive(speed);
      const baseSpring = base.motion.spring;
      for (let frame = 0; frame <= 40; frame += 2) {
        const scaled = spring({ frame, fps: 30, config: d.captionSpring });
        const reference = spring({ frame: frame * speed, fps: 30, config: baseSpring });
        expect(scaled).toBeCloseTo(reference, 3);
      }
    },
  );

  it('keeps the caption spring shape (damping ratio) unchanged across speeds', () => {
    const ratio = (s: { mass: number; damping: number; stiffness: number }) =>
      s.damping / (2 * Math.sqrt(s.stiffness * s.mass));
    expect(ratio(derive(2).captionSpring)).toBeCloseTo(ratio(derive(1).captionSpring), 10);
    expect(ratio(derive(0.5).captionSpring)).toBeCloseTo(ratio(derive(1).captionSpring), 10);
  });
});

describe('image moves cycle per scene', () => {
  it('cycles through the configured moves in order', () => {
    const c = mergeConfig(SCHEMA_DEFAULTS, {
      motion: { imageMoves: ['push-in', 'drift-lr', 'none'] },
    });
    expect([0, 1, 2, 3, 4].map((i) => imageMoveForScene(c, i))).toEqual([
      'push-in',
      'drift-lr',
      'none',
      'push-in',
      'drift-lr',
    ]);
  });
});

describe('imageMotionAt: the image transform inside a scene', () => {
  const fps = 30;
  const sceneFrames = 150; // 5 s

  it('holds still for the hold time, then moves', () => {
    const c = at(1, {
      motion: {
        imageMoves: ['push-in'],
        holdSeconds: 1,
        zoomPerSecond: 0.05,
        zoomAmount: 1.4,
        easing: { type: 'linear' },
      },
    });
    expect(imageMotionAt(c, { sceneIndex: 0, frame: 0, sceneFrames, fps }).scale).toBe(1);
    expect(imageMotionAt(c, { sceneIndex: 0, frame: 29, sceneFrames, fps }).scale).toBe(1);
    expect(imageMotionAt(c, { sceneIndex: 0, frame: 90, sceneFrames, fps }).scale).toBeGreaterThan(
      1,
    );
  });

  it('never zooms past zoomAmount, however long the scene or fast the speed', () => {
    const c = at(2, {
      motion: { imageMoves: ['push-in'], zoomPerSecond: 0.2, zoomAmount: 1.1, holdSeconds: 0 },
    });
    const end = imageMotionAt(c, { sceneIndex: 0, frame: 600 - 1, sceneFrames: 600, fps });
    expect(end.scale).toBeLessThanOrEqual(1.1 + 1e-9);
  });

  it('zooms further per second at a higher speed within the same scene', () => {
    const patch = {
      motion: {
        imageMoves: ['push-in' as const],
        zoomPerSecond: 0.03,
        zoomAmount: 1.4,
        holdSeconds: 0,
        easing: { type: 'linear' as const },
      },
    };
    const slow = imageMotionAt(at(1, patch), { sceneIndex: 0, frame: 90, sceneFrames, fps }).scale;
    const fast = imageMotionAt(at(2, patch), { sceneIndex: 0, frame: 90, sceneFrames, fps }).scale;
    expect(fast).toBeGreaterThan(slow);
  });

  it('pull-out starts zoomed and ends at 1', () => {
    const c = at(1, {
      motion: { imageMoves: ['pull-out'], zoomPerSecond: 0.05, zoomAmount: 1.2, holdSeconds: 0 },
    });
    const first = imageMotionAt(c, { sceneIndex: 0, frame: 0, sceneFrames, fps });
    const last = imageMotionAt(c, { sceneIndex: 0, frame: sceneFrames - 1, sceneFrames, fps });
    expect(first.scale).toBeGreaterThan(last.scale);
    expect(last.scale).toBeCloseTo(1, 2);
  });

  it('drifts without ever showing the image edge', () => {
    const c = at(1, {
      motion: { imageMoves: ['drift-lr'], zoomPerSecond: 0.03, zoomAmount: 1.2, holdSeconds: 0 },
    });
    for (let frame = 0; frame < sceneFrames; frame += 10) {
      const m = imageMotionAt(c, { sceneIndex: 0, frame, sceneFrames, fps });
      // translateX as a fraction of width must stay within the overscan the scale provides.
      expect(Math.abs(m.translateX)).toBeLessThanOrEqual((m.scale - 1) / 2 + 1e-9);
      expect(m.translateY).toBe(0);
    }
  });

  it('does nothing for "none" and for a zero zoom rate', () => {
    const none = at(1, { motion: { imageMoves: ['none'] } });
    expect(imageMotionAt(none, { sceneIndex: 0, frame: 100, sceneFrames, fps })).toEqual({
      scale: 1,
      translateX: 0,
      translateY: 0,
    });
    const still = at(1, { motion: { imageMoves: ['push-in'], zoomPerSecond: 0 } });
    expect(imageMotionAt(still, { sceneIndex: 0, frame: 100, sceneFrames, fps }).scale).toBe(1);
  });

  it('clamps frames outside the scene', () => {
    const c = at(1, { motion: { imageMoves: ['push-in'], holdSeconds: 0 } });
    expect(imageMotionAt(c, { sceneIndex: 0, frame: -5, sceneFrames, fps })).toEqual(
      imageMotionAt(c, { sceneIndex: 0, frame: 0, sceneFrames, fps }),
    );
    expect(imageMotionAt(c, { sceneIndex: 0, frame: 9999, sceneFrames, fps })).toEqual(
      imageMotionAt(c, { sceneIndex: 0, frame: sceneFrames - 1, sceneFrames, fps }),
    );
  });
});
