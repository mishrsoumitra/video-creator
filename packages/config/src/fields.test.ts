import { describe, expect, it } from 'vitest';
import {
  CODECS,
  FIELDS,
  GROUPS,
  SCHEMA_DEFAULTS,
  diffConfig,
  getAtPath,
  getDisabledReason,
  getField,
  getFieldConstraints,
  getFieldDefault,
  listLeafPaths,
  mergeConfig,
  setAtPath,
  type VideoConfig,
} from './index';

const withPatch = (patch: Parameters<typeof mergeConfig>[1]): VideoConfig =>
  mergeConfig(SCHEMA_DEFAULTS, patch);

describe('field metadata covers the whole schema', () => {
  it('has exactly one field entry for every leaf of the config, and no extras', () => {
    const leafPaths = listLeafPaths(SCHEMA_DEFAULTS).filter(
      (p) => p !== 'version' && p !== 'basedOnPreset',
    );
    const fieldPaths = FIELDS.map((f) => f.path);
    expect(new Set(fieldPaths).size).toBe(fieldPaths.length);
    expect([...fieldPaths].sort()).toEqual([...leafPaths].sort());
  });

  it('has 80+ fields, as the spec expects', () => {
    expect(FIELDS.length).toBeGreaterThanOrEqual(80);
  });

  it('gives every field a label and a one-line note', () => {
    for (const field of FIELDS) {
      expect(field.label.trim().length, field.path).toBeGreaterThan(0);
      expect(field.note.trim().length, field.path).toBeGreaterThan(0);
      expect(field.note, field.path).not.toMatch(/\n/);
      expect(field.note.length, field.path).toBeLessThanOrEqual(120);
    }
  });

  it('shows the schema default for every field', () => {
    for (const field of FIELDS) {
      expect(getFieldDefault(field.path), field.path).toEqual(
        getAtPath(SCHEMA_DEFAULTS, field.path),
      );
    }
  });
});

describe('three layers of UI', () => {
  it('puts exactly the five pickers in the simple tier', () => {
    expect(FIELDS.filter((f) => f.tier === 'simple').map((f) => f.path)).toEqual([
      'simple.animationKind',
      'simple.backdropKind',
      'simple.animationSpeed',
      'simple.captionStyle',
      'simple.aspect',
    ]);
  });

  it('groups the advanced panel as the spec does, with Output behind one more click', () => {
    expect(GROUPS.map((g) => [g.id, g.label, g.tier])).toEqual([
      ['motion', 'Motion', 'advanced'],
      ['transitions', 'Transitions', 'advanced'],
      ['captions', 'Captions', 'advanced'],
      ['backdrop', 'Backdrop and effects', 'advanced'],
      ['audio', 'Audio', 'advanced'],
      ['output', 'Output', 'output'],
    ]);
    for (const field of FIELDS.filter((f) => f.tier !== 'simple')) {
      const group = GROUPS.find((g) => g.id === field.group);
      expect(group, field.path).toBeDefined();
      expect(field.tier, field.path).toBe(group!.tier);
    }
  });

  it('keeps every output field in the output tier', () => {
    const outputFields = FIELDS.filter((f) => f.path.startsWith('output.'));
    expect(outputFields.length).toBe(12);
    expect(outputFields.every((f) => f.tier === 'output' && f.group === 'output')).toBe(true);
  });
});

describe('constraints come from the schema', () => {
  it('reads numeric ranges', () => {
    expect(getFieldConstraints('simple.animationSpeed')).toMatchObject({
      kind: 'number',
      min: 0.5,
      max: 2,
    });
    expect(getFieldConstraints('motion.zoomAmount')).toMatchObject({
      kind: 'number',
      min: 1,
      max: 1.4,
    });
    expect(getFieldConstraints('transitions.durationInFrames')).toMatchObject({
      kind: 'number',
      min: 1,
      max: 120,
      integer: true,
    });
  });

  it('reads enum options', () => {
    expect(getFieldConstraints('output.codec')).toEqual({ kind: 'enum', options: [...CODECS] });
  });

  it('marks nullable fields', () => {
    expect(getFieldConstraints('output.crf')).toMatchObject({ kind: 'number', nullable: true });
  });

  it('throws for an unknown path', () => {
    expect(() => getFieldConstraints('motion.nope')).toThrow(/unknown field/i);
    expect(() => getField('motion.nope')).toThrow(/unknown field/i);
  });
});

describe('disabled fields (the UI disables one control when another makes it meaningless)', () => {
  it('disables CRF while hardware acceleration is on, and vice versa', () => {
    expect(
      getDisabledReason(
        'output.crf',
        withPatch({ output: { hardwareAcceleration: 'if-possible' } }),
      ),
    ).toMatch(/hardware/i);
    expect(
      getDisabledReason('output.hardwareAcceleration', withPatch({ output: { crf: 22 } })),
    ).toMatch(/CRF/);
    expect(getDisabledReason('output.crf', SCHEMA_DEFAULTS)).toBeNull();
    expect(getDisabledReason('output.hardwareAcceleration', SCHEMA_DEFAULTS)).toBeNull();
  });

  it('disables CRF for ProRes and the ProRes profile for other codecs', () => {
    expect(getDisabledReason('output.crf', withPatch({ output: { codec: 'prores' } }))).toMatch(
      /profile/i,
    );
    expect(getDisabledReason('output.proResProfile', SCHEMA_DEFAULTS)).toMatch(/ProRes/);
    expect(
      getDisabledReason('output.proResProfile', withPatch({ output: { codec: 'prores' } })),
    ).toBeNull();
  });

  it('disables the x264 preset unless the codec is h264', () => {
    expect(getDisabledReason('output.x264Preset', withPatch({ output: { codec: 'vp9' } }))).toMatch(
      /h264/,
    );
    expect(getDisabledReason('output.x264Preset', SCHEMA_DEFAULTS)).toBeNull();
  });

  it('disables JPEG quality for PNG frames', () => {
    expect(
      getDisabledReason('output.jpegQuality', withPatch({ output: { imageFormat: 'png' } })),
    ).toMatch(/PNG/);
  });

  it('keeps narration playbackRate disabled until unlocked', () => {
    expect(getDisabledReason('audio.narrationPlaybackRate', SCHEMA_DEFAULTS)).toMatch(/locked/i);
    expect(
      getDisabledReason(
        'audio.narrationPlaybackRate',
        withPatch({ audio: { unlockPlaybackRate: true } }),
      ),
    ).toBeNull();
  });

  it('disables sub-settings of switched-off effects', () => {
    expect(getDisabledReason('motion.motionBlur.samples', SCHEMA_DEFAULTS)).toMatch(/off/i);
    expect(getDisabledReason('backdrop.vignette.amount', SCHEMA_DEFAULTS)).toMatch(/off/i);
    expect(
      getDisabledReason(
        'backdrop.vignette.amount',
        withPatch({ backdrop: { vignette: { enabled: true } } }),
      ),
    ).toBeNull();
  });

  it('disables the track picker unless music comes from the library', () => {
    expect(
      getDisabledReason(
        'audio.music.trackId',
        withPatch({ audio: { music: { source: 'none', trackId: null } } }),
      ),
    ).not.toBeNull();
    expect(
      getDisabledReason(
        'audio.music.trackId',
        withPatch({ audio: { music: { source: 'library', trackId: 'soft-pad' } } }),
      ),
    ).toBeNull();
  });
});

describe('path helpers', () => {
  it('reads nested values and array items', () => {
    expect(getAtPath(SCHEMA_DEFAULTS, 'motion.spring.mass')).toBe(1);
    expect(getAtPath(SCHEMA_DEFAULTS, 'backdrop.palette.colors')).toHaveLength(5);
    expect(getAtPath(SCHEMA_DEFAULTS, 'motion.nope.deeper')).toBeUndefined();
  });

  it('sets a value immutably, sharing untouched branches', () => {
    const next = setAtPath(SCHEMA_DEFAULTS, 'motion.spring.mass', 3);
    expect(next.motion.spring.mass).toBe(3);
    expect(SCHEMA_DEFAULTS.motion.spring.mass).toBe(1);
    expect(next.output).toBe(SCHEMA_DEFAULTS.output);
  });

  it('diffs two configs by field path', () => {
    const next = withPatch({
      motion: { zoomAmount: 1.3, imageMoves: ['none'] },
      output: { fps: 60 },
    });
    expect(diffConfig(SCHEMA_DEFAULTS, next).sort()).toEqual([
      'motion.imageMoves',
      'motion.zoomAmount',
      'output.fps',
    ]);
    expect(diffConfig(SCHEMA_DEFAULTS, SCHEMA_DEFAULTS)).toEqual([]);
  });

  it('treats easing, arrays and coordinate pairs as single fields', () => {
    const paths = listLeafPaths(SCHEMA_DEFAULTS);
    expect(paths).toContain('motion.easing');
    expect(paths).toContain('motion.imageMoves');
    expect(paths).toContain('backdrop.palette.colors');
    expect(paths).toContain('backdrop.linearGradient.start');
    expect(paths).not.toContain('motion.easing.type');
  });
});
