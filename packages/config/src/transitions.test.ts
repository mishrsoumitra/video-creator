import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  GATED_TRANSITIONS,
  TRANSITION_CATALOG,
  TRANSITION_DIRECTIONS,
  TRANSITION_NAMES,
  cssStandIn,
  exposedTransitions,
  isTransitionExposed,
  resolveTransitionDirection,
  type TransitionName,
} from './index';

const require = createRequire(import.meta.url);
const transitionsPkg = require('@remotion/transitions/package.json') as {
  exports: Record<string, unknown>;
};
const installedNames = Object.keys(transitionsPkg.exports)
  .filter((key) => key !== '.' && key !== './package.json')
  .map((key) => key.slice(2))
  .sort();

const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

describe('transition catalog vs installed @remotion/transitions 4.0.536', () => {
  it('lists exactly the presentations the installed package exports', () => {
    expect([...TRANSITION_NAMES].sort()).toEqual(installedNames);
  });

  it('matches the twenty names in the spec, in spec order', () => {
    expect([...TRANSITION_NAMES]).toEqual([
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
    ]);
  });

  it.each(TRANSITION_NAMES)(
    'classifies %s as shader or CSS the same way the package does',
    async (name) => {
      const mod = (await import(`@remotion/transitions/${name}`)) as Record<string, unknown>;
      expect(typeof mod[camel(name)]).toBe('function');
      const shipsShader = typeof mod[`${camel(name)}Shader`] === 'function';
      expect(TRANSITION_CATALOG[name].renderer).toBe(shipsShader ? 'shader' : 'css');
    },
  );
});

describe('gating of shader-heavy transitions', () => {
  it('gates exactly crosswarp, ripple, film-burn and book-flip until they are timed on a server', () => {
    expect([...GATED_TRANSITIONS].sort()).toEqual([
      'book-flip',
      'crosswarp',
      'film-burn',
      'ripple',
    ]);
  });

  it('always exposes ungated transitions', () => {
    expect(isTransitionExposed('fade', new Set())).toBe(true);
    expect(isTransitionExposed('dissolve', new Set())).toBe(true);
  });

  it('exposes a gated transition only once a timing measurement exists for it', () => {
    expect(isTransitionExposed('ripple', new Set())).toBe(false);
    expect(isTransitionExposed('ripple', new Set(['ripple']))).toBe(true);
    expect(isTransitionExposed('ripple', new Set(['crosswarp']))).toBe(false);
  });

  it('lists exposed transitions in catalog order', () => {
    const list = exposedTransitions(new Set(['film-burn']));
    expect(list).toContain('film-burn');
    expect(list).not.toContain('ripple');
    expect(list.length).toBe(TRANSITION_NAMES.length - 3);
    expect(list).toEqual(TRANSITION_NAMES.filter((n) => list.includes(n)));
  });
});

describe('CSS stand-ins for the browser preview', () => {
  const shaderNames = TRANSITION_NAMES.filter((n) => TRANSITION_CATALOG[n].renderer === 'shader');

  it('covers every shader transition with a CSS transition', () => {
    expect(shaderNames.length).toBe(12);
    for (const name of shaderNames) {
      const standIn = cssStandIn(name);
      expect(TRANSITION_CATALOG[standIn].renderer).toBe('css');
    }
  });

  it('keeps CSS transitions as they are', () => {
    for (const name of TRANSITION_NAMES.filter((n) => TRANSITION_CATALOG[n].renderer === 'css')) {
      expect(cssStandIn(name)).toBe(name);
    }
  });

  it('maps directional shaders to a directional CSS transition', () => {
    expect(cssStandIn('blur-slide')).toBe('slide');
    expect(cssStandIn('book-flip')).toBe('flip');
  });
});

describe('directions', () => {
  it('only gives a direction to presentations that take one', () => {
    const directional = TRANSITION_NAMES.filter(
      (n) => TRANSITION_CATALOG[n].directions !== 'none',
    ).sort();
    expect(directional).toEqual(['blur-slide', 'book-flip', 'flip', 'slide', 'wipe']);
    expect(TRANSITION_CATALOG.wipe.directions).toBe('all');
  });

  it('passes diagonals through for wipe', () => {
    expect(resolveTransitionDirection('wipe', 'from-top-left')).toBe('from-top-left');
  });

  it.each([
    ['from-top-left', 'from-left'],
    ['from-bottom-left', 'from-left'],
    ['from-top-right', 'from-right'],
    ['from-bottom-right', 'from-right'],
    ['from-top', 'from-top'],
  ] as const)('maps %s to %s for four-direction presentations', (direction, expected) => {
    for (const name of ['slide', 'flip', 'book-flip', 'blur-slide'] as TransitionName[]) {
      expect(resolveTransitionDirection(name, direction)).toBe(expected);
    }
  });

  it('returns null for presentations without a direction', () => {
    expect(resolveTransitionDirection('fade', 'from-left')).toBeNull();
  });

  it('offers all eight directions in the schema', () => {
    expect(TRANSITION_DIRECTIONS.length).toBe(8);
  });
});
