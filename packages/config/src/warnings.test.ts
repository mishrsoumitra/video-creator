import { describe, expect, it } from 'vitest';
import {
  SCHEMA_DEFAULTS,
  VideoConfigSchema,
  getWarnings,
  mergeConfig,
  type VideoConfigInput,
} from './index';

const NONE_TIMED = { timedTransitions: new Set<string>() };
const warn = (patch: VideoConfigInput, ctx = NONE_TIMED) =>
  getWarnings(mergeConfig(SCHEMA_DEFAULTS, patch), ctx);
const ids = (patch: VideoConfigInput, ctx = NONE_TIMED) => warn(patch, ctx).map((w) => w.id);
const ripple = new Set(['ripple']);

describe('getWarnings: Advanced warns, never blocks', () => {
  it('flags the spec’s example: elastic easing at 2x with ripple transitions', () => {
    const patch: VideoConfigInput = {
      simple: { animationSpeed: 2 },
      motion: { easing: { type: 'elastic', direction: 'out', bounciness: 1 } },
      transitions: { presentations: ['ripple'] },
    };
    const warning = warn(patch, { timedTransitions: ripple }).find(
      (w) => w.id === 'jarring-combination',
    );
    expect(warning).toMatchObject({ severity: 'warn' });
    expect([...warning!.fields].sort()).toEqual([
      'motion.easing',
      'simple.animationSpeed',
      'transitions.presentations',
    ]);
    // Valid all the same: the schema accepts it.
    expect(VideoConfigSchema.safeParse(mergeConfig(SCHEMA_DEFAULTS, patch)).success).toBe(true);
  });

  it('does not flag elastic easing at 1x, or at 2x with a calm transition', () => {
    expect(
      ids(
        {
          motion: { easing: { type: 'elastic', direction: 'out', bounciness: 1 } },
          transitions: { presentations: ['ripple'] },
        },
        { timedTransitions: ripple },
      ),
    ).not.toContain('jarring-combination');
    expect(
      ids({
        simple: { animationSpeed: 2 },
        motion: { easing: { type: 'elastic', direction: 'out', bounciness: 1 } },
        transitions: { presentations: ['fade'] },
      }),
    ).not.toContain('jarring-combination');
  });

  it('flags bounce easing at high speed with crosswarp too', () => {
    expect(
      ids(
        {
          simple: { animationSpeed: 1.8 },
          motion: { easing: { type: 'bounce', direction: 'out' } },
          transitions: { presentations: ['crosswarp'] },
        },
        { timedTransitions: new Set(['crosswarp']) },
      ),
    ).toContain('jarring-combination');
  });

  it.each([
    [{ backdrop: { lightLeaks: { enabled: true } } }],
    [{ motion: { motionBlur: { enabled: true } } }],
    [{ transitions: { presentations: ['zoom-blur'] } }],
    [{ transitions: { presentations: ['linear-blur'] } }],
    [{ transitions: { presentations: ['blur-slide'] } }],
  ] as VideoConfigInput[][])('warns about render cost when %j is combined with 4K', (patch) => {
    expect(
      ids(mergeConfig(mergeConfig(SCHEMA_DEFAULTS, patch), { output: { resolution: '4k' } })),
    ).toContain('render-cost');
    expect(ids(patch)).not.toContain('render-cost');
  });

  it('warns about many motion-blur samples', () => {
    expect(ids({ motion: { motionBlur: { enabled: true, samples: 32 } } })).toContain(
      'motion-blur-samples',
    );
    expect(ids({ motion: { motionBlur: { enabled: true, samples: 10 } } })).not.toContain(
      'motion-blur-samples',
    );
    expect(ids({ motion: { motionBlur: { enabled: false, samples: 32 } } })).not.toContain(
      'motion-blur-samples',
    );
  });

  it('warns that letterbox bars eat a vertical frame', () => {
    expect(
      ids({ simple: { aspect: '9:16' }, backdrop: { letterbox: { enabled: true } } }),
    ).toContain('letterbox-vertical');
    expect(
      ids({ simple: { aspect: '16:9' }, backdrop: { letterbox: { enabled: true } } }),
    ).not.toContain('letterbox-vertical');
  });

  it('warns about low-contrast captions sitting on a light backdrop', () => {
    const light: VideoConfigInput = {
      backdrop: {
        imageFit: 'card',
        palette: { colors: ['#F5F3EE', '#E7E2D8', '#B45309', '#1F2937', '#2563EB'] },
      },
    };
    expect(ids({ ...light, captions: { textColor: '#FFFFFF' } })).toContain('caption-contrast');
    expect(ids({ ...light, captions: { textColor: '#111111' } })).not.toContain('caption-contrast');
    // Captions over a full-bleed image carry their own outline, so the backdrop does not matter.
    expect(
      ids({
        backdrop: { imageFit: 'cover', palette: light.backdrop!.palette },
        captions: { textColor: '#FFFFFF' },
      }),
    ).not.toContain('caption-contrast');
    // Captions switched off: nothing to read.
    expect(
      ids({ ...light, simple: { captionStyle: 'off' }, captions: { textColor: '#FFFFFF' } }),
    ).not.toContain('caption-contrast');
  });

  it('warns when loud music is not ducked under the narration', () => {
    expect(
      ids({
        audio: {
          music: { source: 'library', trackId: 'soft-pad', volume: 0.8 },
          ducking: { enabled: false },
        },
      }),
    ).toContain('music-masking');
    expect(
      ids({
        audio: {
          music: { source: 'library', trackId: 'soft-pad', volume: 0.8 },
          ducking: { enabled: true, depthDb: 3 },
        },
      }),
    ).toContain('music-masking');
    expect(
      ids({
        audio: {
          music: { source: 'library', trackId: 'soft-pad', volume: 0.8 },
          ducking: { enabled: true, depthDb: 12 },
        },
      }),
    ).not.toContain('music-masking');
    expect(
      ids({
        audio: {
          music: { source: 'none', trackId: null, volume: 0.8 },
          ducking: { enabled: false },
        },
      }),
    ).not.toContain('music-masking');
  });

  it('warns that long transitions will be clamped on short scenes', () => {
    expect(
      ids({ transitions: { durationInFrames: 60 }, simple: { animationSpeed: 0.5 } }),
    ).toContain('long-transition');
    expect(ids({ transitions: { durationInFrames: 18 } })).not.toContain('long-transition');
    expect(ids({ transitions: { durationInFrames: 120, presentations: ['none'] } })).not.toContain(
      'long-transition',
    );
  });

  it('warns that a very short transition is almost a hard cut', () => {
    expect(
      ids({ transitions: { durationInFrames: 3, presentations: ['fade'] }, output: { fps: 60 } }),
    ).toContain('short-transition');
  });

  it('warns when a gated transition has no timing measurement yet', () => {
    expect(ids({ transitions: { presentations: ['film-burn'] } })).toContain('untimed-transition');
    expect(
      ids(
        { transitions: { presentations: ['film-burn'] } },
        { timedTransitions: new Set(['film-burn']) },
      ),
    ).not.toContain('untimed-transition');
  });

  it('warns about very fast zooms', () => {
    expect(ids({ motion: { zoomPerSecond: 0.1 }, simple: { animationSpeed: 2 } })).toContain(
      'fast-zoom',
    );
    expect(ids({ motion: { zoomPerSecond: 0.03 } })).not.toContain('fast-zoom');
  });

  it('warns about extreme CRF choices in both directions', () => {
    expect(ids({ output: { codec: 'h264', crf: 45 } })).toContain('crf-low-quality');
    expect(ids({ output: { codec: 'h264', crf: 8 } })).toContain('crf-huge-files');
    expect(
      ids({ output: { codec: 'h264', crf: 20 } }).filter((id) => id.startsWith('crf')),
    ).toEqual([]);
  });

  it('warns when the narration rate is unlocked and changed', () => {
    expect(ids({ audio: { unlockPlaybackRate: true, narrationPlaybackRate: 1.2 } })).toContain(
      'narration-rate',
    );
    expect(ids({ audio: { unlockPlaybackRate: true, narrationPlaybackRate: 1 } })).not.toContain(
      'narration-rate',
    );
  });

  it('warns about heavy grain', () => {
    expect(ids({ backdrop: { grain: { enabled: true, amount: 0.4 } } })).toContain('heavy-grain');
    expect(ids({ backdrop: { grain: { enabled: true, amount: 0.06 } } })).not.toContain(
      'heavy-grain',
    );
  });

  it('returns nothing for the schema defaults', () => {
    expect(warn({})).toEqual([]);
  });

  it('is deterministic and every warning names real fields', () => {
    const patch: VideoConfigInput = {
      simple: { animationSpeed: 2, aspect: '9:16' },
      backdrop: { letterbox: { enabled: true }, lightLeaks: { enabled: true } },
      output: { resolution: '4k' },
    };
    const a = warn(patch);
    expect(warn(patch)).toEqual(a);
    for (const w of a) {
      expect(w.message.length).toBeGreaterThan(10);
      expect(w.fields.length).toBeGreaterThan(0);
    }
  });
});
