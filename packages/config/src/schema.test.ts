import { spring } from 'remotion';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_VERSION,
  SCHEMA_DEFAULTS,
  VideoConfigSchema,
  mergeConfig,
  type VideoConfig,
  type VideoConfigInput,
} from './index';

const parse = (input: unknown) => VideoConfigSchema.safeParse(input);

/** Parse `patch` deep-merged onto the schema defaults and return the issues (if any). */
const issuesFor = (patch: VideoConfigInput) => {
  const result = parse(mergeConfig(SCHEMA_DEFAULTS, patch));
  return result.success ? [] : result.error.issues;
};

const pathsOf = (patch: VideoConfigInput) => issuesFor(patch).map((i) => i.path.join('.'));

describe('VideoConfigSchema defaults', () => {
  it('fills every group from an empty object', () => {
    const config = VideoConfigSchema.parse({});
    expect(config.version).toBe(CONFIG_VERSION);
    expect(Object.keys(config).sort()).toEqual(
      [
        'audio',
        'backdrop',
        'basedOnPreset',
        'captions',
        'motion',
        'output',
        'simple',
        'transitions',
        'version',
      ].sort(),
    );
    expect(config).toEqual(SCHEMA_DEFAULTS);
  });

  it('applies inner defaults when a group is partially given', () => {
    const config = VideoConfigSchema.parse({ motion: { zoomAmount: 1.3 } });
    expect(config.motion.zoomAmount).toBe(1.3);
    expect(config.motion.spring).toEqual(SCHEMA_DEFAULTS.motion.spring);
    expect(config.motion.imageMoves).toEqual(SCHEMA_DEFAULTS.motion.imageMoves);
  });

  it('exposes deeply frozen defaults so callers cannot mutate the shared object', () => {
    const isDeepFrozen = (value: unknown): boolean =>
      value === null ||
      typeof value !== 'object' ||
      (Object.isFrozen(value) && Object.values(value).every(isDeepFrozen));
    expect(isDeepFrozen(SCHEMA_DEFAULTS)).toBe(true);
  });

  it('uses the Remotion spring defaults: mass 1, damping 10, stiffness 100, no overshoot clamping', () => {
    expect(SCHEMA_DEFAULTS.motion.spring).toEqual({
      mass: 1,
      damping: 10,
      stiffness: 100,
      overshootClamping: false,
    });
    // Same curve as calling Remotion's spring() with no config at all.
    for (let frame = 0; frame <= 60; frame++) {
      expect(spring({ frame, fps: 30, config: SCHEMA_DEFAULTS.motion.spring })).toBeCloseTo(
        spring({ frame, fps: 30 }),
        10,
      );
    }
  });

  it('defaults animation speed to 1x and output to h264 with the codec-default CRF', () => {
    expect(SCHEMA_DEFAULTS.simple.animationSpeed).toBe(1);
    expect(SCHEMA_DEFAULTS.output.codec).toBe('h264');
    expect(SCHEMA_DEFAULTS.output.crf).toBeNull();
    expect(SCHEMA_DEFAULTS.output.hardwareAcceleration).toBe('disable');
  });

  it('keeps narration playbackRate at 1.0 and locked by default', () => {
    expect(SCHEMA_DEFAULTS.audio.narrationPlaybackRate).toBe(1);
    expect(SCHEMA_DEFAULTS.audio.unlockPlaybackRate).toBe(false);
  });
});

describe('strictness', () => {
  it('rejects unknown keys at the top level', () => {
    const result = parse({ ...SCHEMA_DEFAULTS, colour: 'blue' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('rejects unknown keys inside a group with the group path', () => {
    const result = parse({ simple: { ...SCHEMA_DEFAULTS.simple, mood: 'happy' } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['simple']);
  });

  it('rejects a version it does not know', () => {
    expect(parse({ version: 2 }).success).toBe(false);
  });
});

describe('simple controls', () => {
  it.each([0.5, 0.75, 1, 1.5, 2])('accepts animation speed %s', (animationSpeed) => {
    expect(pathsOf({ simple: { animationSpeed } })).toEqual([]);
  });

  it.each([0.49, 2.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects animation speed %s',
    (animationSpeed) => {
      expect(pathsOf({ simple: { animationSpeed } })).toEqual(['simple.animationSpeed']);
    },
  );

  it('rejects a numeric string for speed instead of coercing it', () => {
    expect(pathsOf({ simple: { animationSpeed: '1' as unknown as number } })).toEqual([
      'simple.animationSpeed',
    ]);
  });

  it.each([
    ['animationKind', 'epic'],
    ['backdropKind', 'neon'],
    ['captionStyle', 'karaoke'],
    ['aspect', '4:3'],
  ] as const)('rejects unknown %s value %s', (key, value) => {
    expect(pathsOf({ simple: { [key]: value } as never })).toEqual([`simple.${key}`]);
  });
});

describe('motion', () => {
  it.each([1, 1.2, 1.4])('accepts zoom amount %s', (zoomAmount) => {
    expect(pathsOf({ motion: { zoomAmount } })).toEqual([]);
  });

  it.each([0.99, 1.41])('rejects zoom amount %s', (zoomAmount) => {
    expect(pathsOf({ motion: { zoomAmount } })).toEqual(['motion.zoomAmount']);
  });

  it('requires at least one and at most eight image moves', () => {
    expect(pathsOf({ motion: { imageMoves: [] } })).toEqual(['motion.imageMoves']);
    expect(pathsOf({ motion: { imageMoves: Array(9).fill('none') } })).toEqual([
      'motion.imageMoves',
    ]);
    expect(
      pathsOf({ motion: { imageMoves: ['push-in', 'drift-lr', 'drift-ud', 'pull-out', 'none'] } }),
    ).toEqual([]);
  });

  it('rejects an unknown image move', () => {
    expect(pathsOf({ motion: { imageMoves: ['spin'] as never } })).toEqual(['motion.imageMoves.0']);
  });

  it.each(['mass', 'damping', 'stiffness'] as const)('rejects a spring %s of 0 or below', (key) => {
    expect(pathsOf({ motion: { spring: { [key]: 0 } } })).toEqual([`motion.spring.${key}`]);
    expect(pathsOf({ motion: { spring: { [key]: -5 } } })).toEqual([`motion.spring.${key}`]);
  });

  it('accepts every easing type Remotion supports', () => {
    const easings: VideoConfig['motion']['easing'][] = [
      { type: 'linear' },
      { type: 'ease', direction: 'in-out' },
      { type: 'quad', direction: 'in' },
      { type: 'cubic', direction: 'out' },
      { type: 'sin', direction: 'in-out' },
      { type: 'exp', direction: 'out' },
      { type: 'circle', direction: 'in' },
      { type: 'bounce', direction: 'out' },
      { type: 'back', direction: 'out', overshoot: 1.70158 },
      { type: 'elastic', direction: 'out', bounciness: 1 },
      { type: 'bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
    ];
    for (const easing of easings) {
      expect(pathsOf({ motion: { easing } })).toEqual([]);
    }
  });

  it('rejects bezier x values outside [0, 1] because Remotion throws for them', () => {
    expect(
      pathsOf({ motion: { easing: { type: 'bezier', x1: -0.1, y1: 0, x2: 0.5, y2: 1 } } }),
    ).toEqual(['motion.easing.x1']);
    expect(
      pathsOf({ motion: { easing: { type: 'bezier', x1: 0.1, y1: 0, x2: 1.1, y2: 1 } } }),
    ).toEqual(['motion.easing.x2']);
  });

  it('allows bezier y values to overshoot for anticipation curves', () => {
    expect(
      pathsOf({ motion: { easing: { type: 'bezier', x1: 0.3, y1: -0.6, x2: 0.7, y2: 1.6 } } }),
    ).toEqual([]);
  });

  it('rejects an unknown easing type', () => {
    expect(issuesFor({ motion: { easing: { type: 'wobble' } as never } }).length).toBeGreaterThan(
      0,
    );
  });

  it('validates motion blur samples as a positive integer', () => {
    expect(pathsOf({ motion: { motionBlur: { enabled: true, samples: 0 } } })).toEqual([
      'motion.motionBlur.samples',
    ]);
    expect(pathsOf({ motion: { motionBlur: { enabled: true, samples: 2.5 } } })).toEqual([
      'motion.motionBlur.samples',
    ]);
    expect(pathsOf({ motion: { motionBlur: { enabled: true, samples: 16 } } })).toEqual([]);
  });
});

describe('transitions', () => {
  it('requires at least one presentation and rejects unknown names', () => {
    expect(pathsOf({ transitions: { presentations: [] } })).toEqual(['transitions.presentations']);
    expect(pathsOf({ transitions: { presentations: ['star-wipe'] as never } })).toEqual([
      'transitions.presentations.0',
    ]);
  });

  it('takes an integer duration in frames between 1 and 120', () => {
    expect(pathsOf({ transitions: { durationInFrames: 1 } })).toEqual([]);
    expect(pathsOf({ transitions: { durationInFrames: 120 } })).toEqual([]);
    expect(pathsOf({ transitions: { durationInFrames: 0 } })).toEqual([
      'transitions.durationInFrames',
    ]);
    expect(pathsOf({ transitions: { durationInFrames: 121 } })).toEqual([
      'transitions.durationInFrames',
    ]);
    expect(pathsOf({ transitions: { durationInFrames: 12.5 } })).toEqual([
      'transitions.durationInFrames',
    ]);
  });

  it('accepts linear or spring timing only', () => {
    expect(pathsOf({ transitions: { timing: 'spring' } })).toEqual([]);
    expect(pathsOf({ transitions: { timing: 'bezier' as never } })).toEqual(['transitions.timing']);
  });
});

describe('captions', () => {
  it('rejects a minimum font size larger than the font size', () => {
    expect(pathsOf({ captions: { fontSize: 40, minFontSize: 60 } })).toEqual([
      'captions.minFontSize',
    ]);
  });

  it('accepts weights in steps of 100 only', () => {
    expect(pathsOf({ captions: { fontWeight: 900 } })).toEqual([]);
    expect(pathsOf({ captions: { fontWeight: 450 } })).toEqual(['captions.fontWeight']);
    expect(pathsOf({ captions: { fontWeight: 1000 } })).toEqual(['captions.fontWeight']);
  });

  it.each([
    '#FFF',
    '#ffd60a',
    '#11223380',
    'red',
    'rgb(10, 20, 30)',
    'rgba(0,0,0,0.5)',
    'hsl(120, 50%, 50%)',
  ])('accepts CSS color %s', (textColor) => {
    expect(pathsOf({ captions: { textColor } })).toEqual([]);
  });

  it.each(['', 'not-a-color', '#12', '#GGGGGG'])('rejects invalid color %j', (textColor) => {
    expect(pathsOf({ captions: { textColor } })).toEqual(['captions.textColor']);
  });

  it('allows breakOnSilence to be switched off with null', () => {
    expect(pathsOf({ captions: { breakOnSilenceAfterMilliseconds: null } })).toEqual([]);
  });

  it('rejects an empty font family', () => {
    expect(pathsOf({ captions: { fontFamily: '   ' } })).toEqual(['captions.fontFamily']);
  });
});

describe('backdrop and effects', () => {
  it('requires exactly five palette colours', () => {
    const colors = SCHEMA_DEFAULTS.backdrop.palette.colors;
    expect(pathsOf({ backdrop: { palette: { colors: colors.slice(0, 4) as never } } })).toEqual([
      'backdrop.palette.colors',
    ]);
    expect(pathsOf({ backdrop: { palette: { colors: [...colors, '#000'] as never } } })).toEqual([
      'backdrop.palette.colors',
    ]);
  });

  it('keeps effect intensities within 0..1', () => {
    expect(pathsOf({ backdrop: { lightLeaks: { intensity: 1.2 } } })).toEqual([
      'backdrop.lightLeaks.intensity',
    ]);
    expect(pathsOf({ backdrop: { vignette: { amount: -0.1 } } })).toEqual([
      'backdrop.vignette.amount',
    ]);
    expect(pathsOf({ backdrop: { grain: { amount: 0.5 } } })).toEqual([]);
  });

  it('constrains gradient coordinates to the unit square', () => {
    expect(pathsOf({ backdrop: { linearGradient: { start: [0, 1.5] } } })).toEqual([
      'backdrop.linearGradient.start.1',
    ]);
  });
});

describe('audio', () => {
  it('locks narration playbackRate at 1.0 unless unlocked, because a different rate breaks word timings', () => {
    const issues = issuesFor({ audio: { narrationPlaybackRate: 1.25 } });
    expect(issues.map((i) => i.path.join('.'))).toEqual(['audio.narrationPlaybackRate']);
    expect(issues[0]?.message).toMatch(/locked/i);
    expect(pathsOf({ audio: { narrationPlaybackRate: 1.25, unlockPlaybackRate: true } })).toEqual(
      [],
    );
  });

  it('requires a track id for library music and an upload id for uploaded music', () => {
    expect(pathsOf({ audio: { music: { source: 'library', trackId: null } } })).toEqual([
      'audio.music.trackId',
    ]);
    expect(pathsOf({ audio: { music: { source: 'upload', uploadId: null } } })).toEqual([
      'audio.music.uploadId',
    ]);
    expect(
      pathsOf({ audio: { music: { source: 'none', trackId: null, uploadId: null } } }),
    ).toEqual([]);
  });

  it('keeps the loudness target in a sane LUFS range', () => {
    expect(pathsOf({ audio: { loudnessTargetLufs: -14 } })).toEqual([]);
    expect(pathsOf({ audio: { loudnessTargetLufs: -4 } })).toEqual(['audio.loudnessTargetLufs']);
    expect(pathsOf({ audio: { loudnessTargetLufs: -31 } })).toEqual(['audio.loudnessTargetLufs']);
  });

  it('bounds ducking depth, attack and release', () => {
    expect(pathsOf({ audio: { ducking: { depthDb: 31 } } })).toEqual(['audio.ducking.depthDb']);
    expect(pathsOf({ audio: { ducking: { attackMs: 0 } } })).toEqual(['audio.ducking.attackMs']);
    expect(pathsOf({ audio: { ducking: { releaseMs: 5001 } } })).toEqual([
      'audio.ducking.releaseMs',
    ]);
  });
});

describe('mergeConfig', () => {
  it('deep-merges objects, replaces arrays, and never mutates its inputs', () => {
    const base = structuredClone(SCHEMA_DEFAULTS) as VideoConfig;
    const merged = mergeConfig(base, {
      motion: { imageMoves: ['none'], spring: { mass: 2 } },
      backdrop: { palette: { colors: ['#000', '#111', '#222', '#333', '#444'] } },
    });
    expect(merged.motion.imageMoves).toEqual(['none']);
    expect(merged.motion.spring).toEqual({ ...SCHEMA_DEFAULTS.motion.spring, mass: 2 });
    expect(merged.backdrop.palette.colors).toEqual(['#000', '#111', '#222', '#333', '#444']);
    expect(base).toEqual(SCHEMA_DEFAULTS);
  });

  it('treats undefined in a patch as "leave unchanged" and null as a value', () => {
    const merged = mergeConfig(SCHEMA_DEFAULTS, { output: { crf: undefined, x264Preset: null } });
    expect(merged.output.crf).toBe(SCHEMA_DEFAULTS.output.crf);
    expect(merged.output.x264Preset).toBeNull();
  });
});
