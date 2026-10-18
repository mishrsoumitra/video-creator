import { Easing as RemotionEasing } from 'remotion';
import { describe, expect, it } from 'vitest';
import { easingFunction, type Easing } from './index';

const samples = Array.from({ length: 101 }, (_, i) => i / 100);

const remotion = (e: Easing): ((t: number) => number) => {
  if (e.type === 'linear') return RemotionEasing.linear;
  if (e.type === 'bezier') return RemotionEasing.bezier(e.x1, e.y1, e.x2, e.y2);
  const base =
    e.type === 'back'
      ? RemotionEasing.back(e.overshoot)
      : e.type === 'elastic'
        ? RemotionEasing.elastic(e.bounciness)
        : (RemotionEasing[e.type] as (t: number) => number);
  return e.direction === 'in'
    ? RemotionEasing.in(base)
    : e.direction === 'out'
      ? RemotionEasing.out(base)
      : RemotionEasing.inOut(base);
};

const cases: Easing[] = [
  { type: 'linear' },
  { type: 'bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
  { type: 'bezier', x1: 0.3, y1: -0.6, x2: 0.7, y2: 1.6 },
  { type: 'bezier', x1: 0, y1: 0, x2: 1, y2: 1 },
];
for (const direction of ['in', 'out', 'in-out'] as const) {
  for (const type of ['ease', 'quad', 'cubic', 'sin', 'exp', 'circle', 'bounce'] as const)
    cases.push({ type, direction });
  cases.push(
    { type: 'back', direction, overshoot: 1.70158 },
    { type: 'back', direction, overshoot: 3 },
  );
  cases.push(
    { type: 'elastic', direction, bounciness: 1 },
    { type: 'elastic', direction, bounciness: 2.5 },
  );
}

describe('easingFunction matches Remotion’s Easing exactly', () => {
  it.each(cases.map((c) => [JSON.stringify(c), c] as const))('%s', (_name, e) => {
    const ours = easingFunction(e);
    const theirs = remotion(e);
    for (const t of samples) {
      expect(ours(t)).toBeCloseTo(theirs(t), 12);
    }
  });

  it('throws for bezier x outside [0, 1], like Remotion', () => {
    expect(() => easingFunction({ type: 'bezier', x1: -0.1, y1: 0, x2: 0.5, y2: 1 })).toThrow(
      /\[0, 1\]/,
    );
    expect(() => RemotionEasing.bezier(-0.1, 0, 0.5, 1)).toThrow(/\[0, 1\]/);
  });
});
