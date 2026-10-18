import { describe, expect, it } from 'vitest';
import {
  ANIMATION_KINDS,
  BACKDROP_KINDS,
  BUILT_IN_PRESETS,
  DEFAULT_PRESET_ID,
  PresetSchema,
  SCHEMA_DEFAULTS,
  VideoConfigSchema,
  applyAnimationKind,
  createPresetRecord,
  getBuiltInPreset,
  getWarnings,
  initialConfig,
  slugifyPresetName,
  validatePresetName,
} from './index';

describe('built-in presets', () => {
  it('ships at least five curated looks with unique ids and names', () => {
    expect(BUILT_IN_PRESETS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(BUILT_IN_PRESETS.map((p) => p.id)).size).toBe(BUILT_IN_PRESETS.length);
    expect(new Set(BUILT_IN_PRESETS.map((p) => p.name.toLowerCase())).size).toBe(
      BUILT_IN_PRESETS.length,
    );
  });

  it.each(BUILT_IN_PRESETS.map((p) => [p.id, p] as const))(
    '%s is a valid, saved config object',
    (_id, preset) => {
      expect(PresetSchema.safeParse(preset).success).toBe(true);
      expect(VideoConfigSchema.parse(preset.config)).toEqual(preset.config);
      expect(preset.builtIn).toBe(true);
      expect(preset.config.basedOnPreset).toBe(preset.id);
    },
  );

  it.each(BUILT_IN_PRESETS.map((p) => [p.id, p] as const))(
    '%s raises no warnings (presets are curated)',
    (_id, preset) => {
      expect(getWarnings(preset.config, { timedTransitions: new Set() })).toEqual([]);
    },
  );

  it('covers every animation kind and every backdrop kind', () => {
    expect(new Set(BUILT_IN_PRESETS.map((p) => p.config.simple.animationKind))).toEqual(
      new Set(ANIMATION_KINDS),
    );
    expect(new Set(BUILT_IN_PRESETS.map((p) => p.config.simple.backdropKind))).toEqual(
      new Set(BACKDROP_KINDS),
    );
  });

  it.each(BUILT_IN_PRESETS.map((p) => [p.id, p] as const))(
    '%s keeps motion and transitions exactly as its animation kind sets them',
    (_id, preset) => {
      const reapplied = applyAnimationKind(preset.config, preset.config.simple.animationKind, {
        timedTransitions: new Set(),
      });
      expect(reapplied.motion).toEqual(preset.config.motion);
      expect(reapplied.transitions).toEqual(preset.config.transitions);
    },
  );

  it('looks presets up by id', () => {
    expect(getBuiltInPreset(DEFAULT_PRESET_ID)?.id).toBe(DEFAULT_PRESET_ID);
    expect(getBuiltInPreset('nope')).toBeUndefined();
  });

  it('gives a user who touches nothing the default preset', () => {
    expect(initialConfig()).toEqual(getBuiltInPreset(DEFAULT_PRESET_ID)!.config);
  });

  it('returns a fresh copy each time so the UI cannot mutate the preset', () => {
    const a = initialConfig();
    a.motion.zoomAmount = 1.39;
    expect(initialConfig().motion.zoomAmount).not.toBe(1.39);
  });
});

describe('user presets ("my channel look")', () => {
  const existing = ['My Channel Look'];

  it.each([
    ['', /required/i],
    ['   ', /required/i],
    ['x'.repeat(61), /60/],
    ['my channel look', /exists/i],
    ['  My Channel Look  ', /exists/i],
    ['Documentary', /built-in/i],
  ])('rejects the name %j', (name, message) => {
    expect(validatePresetName(name, existing)).toMatch(message);
  });

  it('accepts a fresh name', () => {
    expect(validatePresetName('Shorts – bold', existing)).toBeNull();
  });

  it('slugifies names into stable ids', () => {
    expect(slugifyPresetName('  My Channel Look! ')).toBe('my-channel-look');
    expect(slugifyPresetName('Ünïcode   Look')).toBe('unicode-look');
    expect(slugifyPresetName('!!!')).toMatch(/^preset-[a-z0-9]+$/);
  });

  it('creates a validated record and keeps provenance', () => {
    const config = { ...SCHEMA_DEFAULTS, basedOnPreset: 'documentary' };
    const record = createPresetRecord({ name: 'My Look', description: 'warm', config }, existing);
    expect(record).toMatchObject({
      id: 'my-look',
      name: 'My Look',
      description: 'warm',
      builtIn: false,
    });
    expect(record.config.basedOnPreset).toBe('documentary');
    expect(PresetSchema.safeParse(record).success).toBe(true);
  });

  it('refuses to save an invalid config', () => {
    const bad = { ...SCHEMA_DEFAULTS, motion: { ...SCHEMA_DEFAULTS.motion, zoomAmount: 3 } };
    expect(() => createPresetRecord({ name: 'Broken', config: bad }, [])).toThrow(/zoomAmount/);
  });

  it('refuses a duplicate name', () => {
    expect(() =>
      createPresetRecord({ name: 'my channel look', config: SCHEMA_DEFAULTS }, existing),
    ).toThrow(/exists/i);
  });

  it('survives a JSON round trip', () => {
    const record = createPresetRecord({ name: 'Round Trip', config: SCHEMA_DEFAULTS }, []);
    expect(PresetSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });
});
