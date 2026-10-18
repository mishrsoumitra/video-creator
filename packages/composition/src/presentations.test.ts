import {
  SCHEMA_DEFAULTS,
  TRANSITION_CATALOG,
  TRANSITION_NAMES,
  cssStandIn,
  mergeConfig,
} from '@vc/config';
import { describe, expect, it } from 'vitest';
import { buildPresentation, buildTiming } from './presentations';

const dims = { width: 1920, height: 1080 };

describe('buildPresentation', () => {
  it.each(TRANSITION_NAMES)('builds %s from @remotion/transitions', (name) => {
    const p = buildPresentation({
      name,
      direction: 'from-left',
      ...dims,
      htmlInCanvasSupported: true,
    });
    expect(typeof p.component).toBe('function');
    expect(p.props).toBeTypeOf('object');
  });

  it('passes the resolved direction to directional presentations', () => {
    expect(
      buildPresentation({
        name: 'slide',
        direction: 'from-left',
        ...dims,
        htmlInCanvasSupported: true,
      }).props,
    ).toMatchObject({ direction: 'from-left' });
    expect(
      buildPresentation({
        name: 'wipe',
        direction: 'from-top-left',
        ...dims,
        htmlInCanvasSupported: true,
      }).props,
    ).toMatchObject({ direction: 'from-top-left' });
  });

  it('gives clock-wipe and iris the frame size they require', () => {
    expect(
      buildPresentation({
        name: 'clock-wipe',
        direction: null,
        ...dims,
        htmlInCanvasSupported: true,
      }).props,
    ).toMatchObject(dims);
    expect(
      buildPresentation({ name: 'iris', direction: null, ...dims, htmlInCanvasSupported: true })
        .props,
    ).toMatchObject(dims);
  });

  it.each(TRANSITION_NAMES.filter((n) => TRANSITION_CATALOG[n].renderer === 'shader'))(
    'substitutes a CSS stand-in for %s when the browser lacks HTML-in-canvas',
    (name) => {
      const preview = buildPresentation({
        name,
        direction: 'from-right',
        ...dims,
        htmlInCanvasSupported: false,
      });
      const standIn = buildPresentation({
        name: cssStandIn(name),
        direction: 'from-right',
        ...dims,
        htmlInCanvasSupported: false,
      });
      expect(preview.component).toBe(standIn.component);
      const real = buildPresentation({
        name,
        direction: 'from-right',
        ...dims,
        htmlInCanvasSupported: true,
      });
      expect(real.component).not.toBe(standIn.component);
    },
  );
});

describe('buildTiming', () => {
  it('uses linear timing with the motion easing for the exact frame count', () => {
    const t = buildTiming({ kind: 'linear', durationInFrames: 18, config: SCHEMA_DEFAULTS });
    expect(t.getDurationInFrames({ fps: 30 })).toBe(18);
    expect(t.getProgress({ frame: 0, fps: 30 })).toBe(0);
    expect(t.getProgress({ frame: 18, fps: 30 })).toBeCloseTo(1, 5);
  });

  it('stretches spring timing to the clamped frame count', () => {
    const config = mergeConfig(SCHEMA_DEFAULTS, { simple: { animationSpeed: 2 } });
    const t = buildTiming({ kind: 'spring', durationInFrames: 10, config });
    expect(t.getDurationInFrames({ fps: 30 })).toBe(10);
    expect(t.getProgress({ frame: 10, fps: 30 })).toBeCloseTo(1, 1);
  });
});
