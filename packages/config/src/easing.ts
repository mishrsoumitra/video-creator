import type { Easing } from './schema';

/*
 * A dependency-free port of Remotion 4.0.536's Easing (itself from React Native), so the config
 * package can compute motion without importing `remotion`. easing.test.ts checks it against
 * Remotion's Easing for every type and direction.
 */

const clampUnit = (t: number) => Math.min(1, Math.max(0, t));

const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_PRECISION = 0.0000001;
const SUBDIVISION_MAX_ITERATIONS = 10;
const kSplineTableSize = 11;
const kSampleStepSize = 1.0 / (kSplineTableSize - 1.0);

const A = (a1: number, a2: number) => 1.0 - 3.0 * a2 + 3.0 * a1;
const B = (a1: number, a2: number) => 3.0 * a2 - 6.0 * a1;
const C = (a1: number) => 3.0 * a1;
const calcBezier = (t: number, a1: number, a2: number) =>
  ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
const getSlope = (t: number, a1: number, a2: number) =>
  3.0 * A(a1, a2) * t * t + 2.0 * B(a1, a2) * t + C(a1);

export const bezier = (
  mX1: number,
  mY1: number,
  mX2: number,
  mY2: number,
): ((x: number) => number) => {
  if (!(mX1 >= 0 && mX1 <= 1 && mX2 >= 0 && mX2 <= 1)) {
    throw new Error('bezier x values must be in [0, 1] range');
  }
  const sampleValues = new Float32Array(kSplineTableSize);
  if (mX1 !== mY1 || mX2 !== mY2) {
    for (let i = 0; i < kSplineTableSize; ++i)
      sampleValues[i] = calcBezier(i * kSampleStepSize, mX1, mX2);
  }
  const getTForX = (aX: number): number => {
    let intervalStart = 0.0;
    let currentSample = 1;
    const lastSample = kSplineTableSize - 1;
    for (; currentSample !== lastSample && sampleValues[currentSample]! <= aX; ++currentSample) {
      intervalStart += kSampleStepSize;
    }
    --currentSample;
    const dist =
      (aX - sampleValues[currentSample]!) /
      (sampleValues[currentSample + 1]! - sampleValues[currentSample]!);
    const guessForT = intervalStart + dist * kSampleStepSize;
    const initialSlope = getSlope(guessForT, mX1, mX2);
    if (initialSlope >= NEWTON_MIN_SLOPE) {
      let t = guessForT;
      for (let i = 0; i < NEWTON_ITERATIONS; ++i) {
        const slope = getSlope(t, mX1, mX2);
        if (slope === 0.0) return t;
        t -= (calcBezier(t, mX1, mX2) - aX) / slope;
      }
      return t;
    }
    if (initialSlope === 0.0) return guessForT;
    let aA = intervalStart;
    let aB = intervalStart + kSampleStepSize;
    let currentT: number;
    let currentX: number;
    let i = 0;
    do {
      currentT = aA + (aB - aA) / 2.0;
      currentX = calcBezier(currentT, mX1, mX2) - aX;
      if (currentX > 0.0) aB = currentT;
      else aA = currentT;
    } while (Math.abs(currentX) > SUBDIVISION_PRECISION && ++i < SUBDIVISION_MAX_ITERATIONS);
    return currentT;
  };
  return (x: number) => {
    const clampedX = Math.min(1, Math.max(0, x));
    if (mX1 === mY1 && mX2 === mY2) return clampedX;
    if (clampedX === 0) return 0;
    if (clampedX === 1) return 1;
    return calcBezier(getTForX(clampedX), mY1, mY2);
  };
};

const ease = bezier(0.42, 0, 1, 1);

const bounce = (t: number): number => {
  const u = clampUnit(t);
  if (u < 1 / 2.75) return 7.5625 * u * u;
  if (u < 2 / 2.75) {
    const v = u - 1.5 / 2.75;
    return 7.5625 * v * v + 0.75;
  }
  if (u < 2.5 / 2.75) {
    const v = u - 2.25 / 2.75;
    return 7.5625 * v * v + 0.9375;
  }
  const v = u - 2.625 / 2.75;
  return 7.5625 * v * v + 0.984375;
};

const BASE: Record<
  'ease' | 'quad' | 'cubic' | 'sin' | 'exp' | 'circle' | 'bounce',
  (t: number) => number
> = {
  ease,
  quad: (t) => t * t,
  cubic: (t) => t * t * t,
  sin: (t) => 1 - Math.cos((t * Math.PI) / 2),
  exp: (t) => 2 ** (10 * (t - 1)),
  circle: (t) => {
    const u = clampUnit(t);
    return 1 - Math.sqrt(1 - u * u);
  },
  bounce,
};

const withDirection = (fn: (t: number) => number, direction: 'in' | 'out' | 'in-out') => {
  switch (direction) {
    case 'in':
      return fn;
    case 'out':
      return (t: number) => 1 - fn(1 - t);
    case 'in-out':
      return (t: number) => (t < 0.5 ? fn(t * 2) / 2 : 1 - fn((1 - t) * 2) / 2);
  }
};

/** Compiles a config easing to a function on [0, 1], identical to Remotion's Easing. */
export const easingFunction = (easing: Easing): ((t: number) => number) => {
  switch (easing.type) {
    case 'linear':
      return (t) => t;
    case 'bezier':
      return bezier(easing.x1, easing.y1, easing.x2, easing.y2);
    case 'back': {
      const s = easing.overshoot;
      return withDirection((t) => t * t * ((s + 1) * t - s), easing.direction);
    }
    case 'elastic': {
      const p = easing.bounciness * Math.PI;
      return withDirection(
        (t) => 1 - Math.cos((t * Math.PI) / 2) ** 3 * Math.cos(t * p),
        easing.direction,
      );
    }
    default:
      return withDirection(BASE[easing.type], easing.direction);
  }
};
