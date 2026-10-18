import { describe, expect, it } from 'vitest';
import {
  ANIMATION_KINDS,
  BACKDROP_KINDS,
  CAPTION_STYLES,
  SCHEMA_DEFAULTS,
  TRANSITION_CATALOG,
  VideoConfigSchema,
  applyAnimationKind,
  applyAspect,
  applyBackdropKind,
  applyCaptionStyle,
  applySpeed,
  contrastRatio,
  diffConfig,
  relativeLuminance,
  sceneTargetSeconds,
  targetSceneCount,
  type VideoConfig,
} from './index';

const NOTHING_TIMED = new Set<string>();
const ALL_TIMED = new Set(Object.keys(TRANSITION_CATALOG));

const kind = (k: (typeof ANIMATION_KINDS)[number], timed = NOTHING_TIMED) =>
  applyAnimationKind(SCHEMA_DEFAULTS, k, { timedTransitions: timed });

describe('animation kind bundles (spec table)', () => {
  it('Calm: slow push-in, crossfade between scenes', () => {
    const c = kind('calm');
    expect(c.simple.animationKind).toBe('calm');
    expect(c.motion.imageMoves).toEqual(['push-in']);
    expect(c.transitions.presentations).toEqual(['fade']);
    expect(c.motion.zoomPerSecond).toBeLessThan(kind('dynamic').motion.zoomPerSecond);
  });

  it('Documentary: push-in and drift, wipe/slide transitions, occasional hold', () => {
    const c = kind('documentary');
    expect(c.motion.imageMoves).toContain('push-in');
    expect(c.motion.imageMoves.some((m) => m === 'drift-lr' || m === 'drift-ud')).toBe(true);
    expect(c.motion.imageMoves).toContain('none');
    expect(c.motion.imageMoves.filter((m) => m === 'none').length).toBe(1);
    expect([...c.transitions.presentations].sort()).toEqual(['slide', 'wipe']);
  });

  it('Dynamic: faster moves, push-cut / zoom-in-out / cross-zoom, captions snap in', () => {
    const c = kind('dynamic');
    const calm = kind('calm');
    expect([...c.transitions.presentations].sort()).toEqual([
      'cross-zoom',
      'push-cut',
      'zoom-in-out',
    ]);
    expect(c.motion.zoomPerSecond).toBeGreaterThan(calm.motion.zoomPerSecond);
    expect(c.motion.holdSeconds).toBeLessThan(calm.motion.holdSeconds);
    expect(c.transitions.durationInFrames).toBeLessThan(calm.transitions.durationInFrames);
    expect(c.motion.spring.overshootClamping).toBe(true);
    expect(c.motion.spring.stiffness).toBeGreaterThan(calm.motion.spring.stiffness);
  });

  it('Cinematic: slow drift, dissolve, light leaks, letterbox bars', () => {
    const c = kind('cinematic');
    expect(c.motion.imageMoves.every((m) => m === 'drift-lr' || m === 'drift-ud')).toBe(true);
    expect(c.transitions.presentations).toContain('dissolve');
    expect(c.backdrop.lightLeaks.enabled).toBe(true);
    expect(c.backdrop.letterbox.enabled).toBe(true);
    expect(c.motion.zoomPerSecond).toBeLessThanOrEqual(kind('calm').motion.zoomPerSecond);
  });

  it('Cinematic uses film-burn only once film-burn has been timed on the server', () => {
    expect(kind('cinematic', NOTHING_TIMED).transitions.presentations).not.toContain('film-burn');
    expect(kind('cinematic', ALL_TIMED).transitions.presentations).toEqual([
      'dissolve',
      'film-burn',
    ]);
  });

  it('Minimal: no image motion, a plain cut, captions do the work', () => {
    const c = kind('minimal');
    expect(c.motion.imageMoves).toEqual(['none']);
    expect(c.motion.zoomPerSecond).toBe(0);
    expect(['none', 'fade']).toContain(c.transitions.presentations[0]);
    expect(c.transitions.presentations).toHaveLength(1);
  });

  it.each(ANIMATION_KINDS)(
    '%s produces a valid config and never uses a gated transition untimed',
    (k) => {
      const c = kind(k);
      expect(VideoConfigSchema.safeParse(c).success).toBe(true);
      for (const name of c.transitions.presentations) {
        expect(TRANSITION_CATALOG[name].gated, name).toBe(false);
      }
    },
  );

  it.each(ANIMATION_KINDS)(
    '%s only touches motion, transitions, letterbox and light leaks',
    (k) => {
      const changed = diffConfig(SCHEMA_DEFAULTS, kind(k));
      for (const path of changed) {
        expect(
          path === 'simple.animationKind' ||
            path.startsWith('motion.') ||
            path.startsWith('transitions.') ||
            path.startsWith('backdrop.letterbox.') ||
            path.startsWith('backdrop.lightLeaks.'),
          path,
        ).toBe(true);
      }
    },
  );

  it('is pure and idempotent', () => {
    const before = structuredClone(SCHEMA_DEFAULTS);
    const once = kind('dynamic');
    const twice = applyAnimationKind(once, 'dynamic', { timedTransitions: NOTHING_TIMED });
    expect(twice).toEqual(once);
    expect(SCHEMA_DEFAULTS).toEqual(before);
  });

  it('overrides earlier advanced edits in its own fields but keeps the rest', () => {
    const edited: VideoConfig = {
      ...SCHEMA_DEFAULTS,
      motion: { ...SCHEMA_DEFAULTS.motion, zoomAmount: 1.37 },
      captions: { ...SCHEMA_DEFAULTS.captions, fontSize: 90 },
    };
    const next = applyAnimationKind(edited, 'calm', { timedTransitions: NOTHING_TIMED });
    expect(next.motion.zoomAmount).not.toBe(1.37);
    expect(next.captions.fontSize).toBe(90);
  });
});

describe('scene pacing read by the script stage', () => {
  it('gives Dynamic more, shorter scenes and Cinematic fewer, longer ones', () => {
    expect(sceneTargetSeconds('dynamic')).toBeLessThan(sceneTargetSeconds('documentary'));
    expect(sceneTargetSeconds('cinematic')).toBeGreaterThan(sceneTargetSeconds('documentary'));
    expect(targetSceneCount(60, 'dynamic')).toBeGreaterThan(targetSceneCount(60, 'cinematic'));
  });

  it('always plans at least one scene and caps very long videos', () => {
    expect(targetSceneCount(15, 'cinematic')).toBeGreaterThanOrEqual(1);
    expect(targetSceneCount(600, 'dynamic')).toBeLessThanOrEqual(80);
  });

  it('rejects a non-positive length', () => {
    expect(() => targetSceneCount(0, 'calm')).toThrow(RangeError);
  });
});

describe('backdrop kind bundles (spec table)', () => {
  const backdrop = (k: (typeof BACKDROP_KINDS)[number]) => applyBackdropKind(SCHEMA_DEFAULTS, k);

  it('Dark: flat near-black, images full-bleed', () => {
    const c = backdrop('dark');
    expect(c.backdrop.imageFit).toBe('cover');
    expect(relativeLuminance(c.backdrop.palette.colors[0]!)).toBeLessThan(0.02);
    expect(c.backdrop.linearGradient.enabled).toBe(false);
    expect(c.backdrop.grain.enabled).toBe(false);
  });

  it('Light: off-white, images in a soft card with shadow, readable captions', () => {
    const c = backdrop('light');
    expect(c.backdrop.imageFit).toBe('card');
    expect(c.backdrop.card.shadow).toBeGreaterThan(0);
    const bg = c.backdrop.palette.colors[0]!;
    expect(relativeLuminance(bg)).toBeGreaterThan(0.8);
    expect(contrastRatio(c.captions.textColor, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('Gradient: a two-colour linearGradient from the palette', () => {
    const c = backdrop('gradient');
    expect(c.backdrop.linearGradient.enabled).toBe(true);
    expect(c.backdrop.palette.colors[0]).not.toBe(c.backdrop.palette.colors[1]);
  });

  it('Blurred image: blurred, darkened copy behind a sharp contained image', () => {
    const c = backdrop('blurred-image');
    expect(c.backdrop.imageFit).toBe('contain');
    expect(c.backdrop.blur.radius).toBeGreaterThan(0);
    expect(c.backdrop.blur.darken).toBeGreaterThan(0);
  });

  it('Textured: subtle animated grain plus rings or gridlines', () => {
    const c = backdrop('textured');
    expect(c.backdrop.grain.enabled).toBe(true);
    expect(c.backdrop.grain.animated).toBe(true);
    expect(c.backdrop.grain.amount).toBeLessThanOrEqual(0.15);
    expect(c.backdrop.rings.enabled || c.backdrop.gridlines.enabled).toBe(true);
  });

  it.each(BACKDROP_KINDS)('%s yields a valid config and records the picker', (k) => {
    const c = backdrop(k);
    expect(c.simple.backdropKind).toBe(k);
    expect(VideoConfigSchema.safeParse(c).success).toBe(true);
  });

  it('switching kinds does not leave the previous kind’s effects on', () => {
    const c = applyBackdropKind(backdrop('textured'), 'dark');
    expect(c.backdrop.grain.enabled).toBe(false);
    expect(c.backdrop.gridlines.enabled).toBe(false);
    expect(c.backdrop.rings.enabled).toBe(false);
  });
});

describe('caption style, aspect and speed pickers', () => {
  it.each(CAPTION_STYLES)('records caption style %s', (style) => {
    const c = applyCaptionStyle(SCHEMA_DEFAULTS, style);
    expect(c.simple.captionStyle).toBe(style);
    expect(VideoConfigSchema.safeParse(c).success).toBe(true);
  });

  it('uses rough-notation underlines for Underline-highlight and word scaling for Kinetic words', () => {
    expect(
      applyCaptionStyle(SCHEMA_DEFAULTS, 'underline-highlight').captions.highlightAnimation,
    ).toBe('underline');
    expect(applyCaptionStyle(SCHEMA_DEFAULTS, 'kinetic-words').captions.highlightAnimation).toBe(
      'scale',
    );
  });

  it('groups more words per card for phrase cards than for kinetic words', () => {
    const kinetic = applyCaptionStyle(SCHEMA_DEFAULTS, 'kinetic-words').captions;
    const cards = applyCaptionStyle(SCHEMA_DEFAULTS, 'phrase-cards').captions;
    expect(cards.combineTokensWithinMilliseconds).toBeGreaterThan(
      kinetic.combineTokensWithinMilliseconds,
    );
  });

  it('turning captions off keeps burn-in settings untouched (the .srt is always written)', () => {
    const c = applyCaptionStyle(SCHEMA_DEFAULTS, 'off');
    expect(c.captions).toEqual(SCHEMA_DEFAULTS.captions);
  });

  it('changes only the aspect', () => {
    const c = applyAspect(SCHEMA_DEFAULTS, '9:16');
    expect(diffConfig(SCHEMA_DEFAULTS, c)).toEqual(['simple.aspect']);
  });

  it('sets speed within 0.5x..2x and refuses anything else', () => {
    expect(applySpeed(SCHEMA_DEFAULTS, 1.5).simple.animationSpeed).toBe(1.5);
    expect(diffConfig(SCHEMA_DEFAULTS, applySpeed(SCHEMA_DEFAULTS, 2))).toEqual([
      'simple.animationSpeed',
    ]);
    expect(() => applySpeed(SCHEMA_DEFAULTS, 2.5)).toThrow(RangeError);
    expect(() => applySpeed(SCHEMA_DEFAULTS, 0.25)).toThrow(RangeError);
  });
});
