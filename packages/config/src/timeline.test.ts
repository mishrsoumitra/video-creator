import { describe, expect, it } from 'vitest';
import {
  SCHEMA_DEFAULTS,
  TRANSITION_MAX_SCENE_FRACTION,
  buildTimeline,
  mergeConfig,
  msToFrame,
  type VideoConfig,
} from './index';

const scenesMs = (bounds: number[]) =>
  bounds.slice(0, -1).map((startMs, i) => ({ startMs, endMs: bounds[i + 1]! }));

const configWith = (patch: Parameters<typeof mergeConfig>[1]): VideoConfig =>
  mergeConfig(SCHEMA_DEFAULTS, patch);

describe('msToFrame', () => {
  it('rounds to the nearest frame', () => {
    expect(msToFrame(1000, 30)).toBe(30);
    expect(msToFrame(1016, 30)).toBe(30);
    expect(msToFrame(1017, 30)).toBe(31);
    expect(msToFrame(0, 60)).toBe(0);
  });
});

describe('buildTimeline', () => {
  const fade18 = configWith({
    transitions: { presentations: ['fade'], durationInFrames: 18, timing: 'linear' },
  });

  it('centres each transition on the narration cut and keeps the total equal to the narration', () => {
    const t = buildTimeline({
      scenes: scenesMs([0, 2000, 5000, 9000]),
      durationMs: 9000,
      fps: 30,
      config: fade18,
    });
    expect(t.totalFrames).toBe(270);
    expect(t.scenes.map((s) => [s.startFrame, s.endFrame])).toEqual([
      [0, 60],
      [60, 150],
      [150, 270],
    ]);
    expect(t.transitions.map((x) => [x.afterScene, x.name, x.durationInFrames])).toEqual([
      [0, 'fade', 18],
      [1, 'fade', 18],
    ]);
    expect(t.sequences.map((s) => [s.from, s.durationInFrames])).toEqual([
      [0, 69],
      [51, 108],
      [141, 129],
    ]);
    const sumSeq = t.sequences.reduce((a, s) => a + s.durationInFrames, 0);
    const sumT = t.transitions.reduce((a, x) => a + x.durationInFrames, 0);
    expect(sumSeq - sumT).toBe(t.totalFrames);
  });

  const bounds = [0, 1800, 2600, 7300, 7800, 12_000, 15_250];
  for (const fps of [24, 30, 60] as const) {
    it(`never moves scene boundaries or the total for any speed (fps ${fps})`, () => {
      const reference = buildTimeline({
        scenes: scenesMs(bounds),
        durationMs: 15_250,
        fps,
        config: configWith({ simple: { animationSpeed: 1 } }),
      });
      for (const speed of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
        const config = configWith({
          simple: { animationSpeed: speed },
          transitions: { presentations: ['wipe', 'slide', 'fade'], durationInFrames: 24 },
        });
        const t = buildTimeline({ scenes: scenesMs(bounds), durationMs: 15_250, fps, config });
        expect(t.totalFrames).toBe(reference.totalFrames);
        expect(t.scenes).toEqual(reference.scenes);
        const sumSeq = t.sequences.reduce((a, s) => a + s.durationInFrames, 0);
        const sumT = t.transitions.reduce((a, x) => a + x.durationInFrames, 0);
        expect(sumSeq - sumT).toBe(t.totalFrames);
        // Remotion: a sequence must not be shorter than an adjacent transition.
        t.sequences.forEach((seq, i) => {
          const before = t.transitions.find((x) => x.afterScene === i - 1)?.durationInFrames ?? 0;
          const after = t.transitions.find((x) => x.afterScene === i)?.durationInFrames ?? 0;
          expect(seq.durationInFrames).toBeGreaterThanOrEqual(Math.max(before, after));
        });
      }
    });
  }

  it('shortens transitions as speed rises', () => {
    const at = (s: number) =>
      buildTimeline({
        scenes: scenesMs([0, 4000, 8000]),
        durationMs: 8000,
        fps: 30,
        config: configWith({
          simple: { animationSpeed: s },
          transitions: { durationInFrames: 20 },
        }),
      }).transitions[0]!.durationInFrames;
    expect(at(0.5)).toBe(40);
    expect(at(1)).toBe(20);
    expect(at(2)).toBe(10);
  });

  it('clamps a transition to half of the shorter neighbouring scene and says so', () => {
    const t = buildTimeline({
      scenes: scenesMs([0, 2000, 2333, 5000]),
      durationMs: 5000,
      fps: 30,
      config: configWith({ transitions: { presentations: ['fade'], durationInFrames: 30 } }),
    });
    // middle scene is 10 frames (60..70)
    expect(t.scenes[1]).toMatchObject({ startFrame: 60, endFrame: 70 });
    for (const x of t.transitions) {
      expect(x.durationInFrames).toBe(Math.floor(10 * TRANSITION_MAX_SCENE_FRACTION));
      expect(x.clamped).toBe(true);
      expect(x.requestedFrames).toBe(30);
    }
  });

  it('turns "none" into a hard cut that does not extend the sequences', () => {
    const t = buildTimeline({
      scenes: scenesMs([0, 2000, 4000]),
      durationMs: 4000,
      fps: 30,
      config: configWith({ transitions: { presentations: ['none'], durationInFrames: 20 } }),
    });
    expect(t.transitions).toEqual([]);
    expect(t.sequences.map((s) => s.durationInFrames)).toEqual([60, 60]);
  });

  it('cycles presentations across cuts', () => {
    const t = buildTimeline({
      scenes: scenesMs([0, 2000, 4000, 6000, 8000]),
      durationMs: 8000,
      fps: 30,
      config: configWith({ transitions: { presentations: ['wipe', 'slide'] } }),
    });
    expect(t.transitions.map((x) => x.name)).toEqual(['wipe', 'slide', 'wipe']);
  });

  it('skips "none" entries inside a cycle without breaking the rotation', () => {
    const t = buildTimeline({
      scenes: scenesMs([0, 2000, 4000, 6000, 8000]),
      durationMs: 8000,
      fps: 30,
      config: configWith({ transitions: { presentations: ['fade', 'none'] } }),
    });
    expect(t.transitions.map((x) => [x.afterScene, x.name])).toEqual([
      [0, 'fade'],
      [2, 'fade'],
    ]);
  });

  it('resolves directions per presentation', () => {
    const t = buildTimeline({
      scenes: scenesMs([0, 2000, 4000, 6000, 8000]),
      durationMs: 8000,
      fps: 30,
      config: configWith({
        transitions: { presentations: ['slide', 'wipe', 'fade'], direction: 'from-top-left' },
      }),
    });
    expect(t.transitions.map((x) => x.direction)).toEqual(['from-left', 'from-top-left', null]);
  });

  it('handles a single scene with no transitions', () => {
    const t = buildTimeline({
      scenes: scenesMs([0, 3000]),
      durationMs: 3000,
      fps: 30,
      config: fade18,
    });
    expect(t.transitions).toEqual([]);
    expect(t.sequences).toEqual([{ sceneIndex: 0, from: 0, durationInFrames: 90 }]);
  });

  it('extends the last scene to cover an audio tail after the last word', () => {
    const t = buildTimeline({
      scenes: scenesMs([0, 2000, 4000]),
      durationMs: 4500,
      fps: 30,
      config: fade18,
    });
    expect(t.totalFrames).toBe(135);
    expect(t.scenes.at(-1)!.endFrame).toBe(135);
  });

  it('merges a scene that rounds to zero frames into its neighbour', () => {
    const t = buildTimeline({
      scenes: scenesMs([0, 1000, 1010, 2000]),
      durationMs: 2000,
      fps: 30,
      config: fade18,
    });
    expect(t.scenes.every((s) => s.endFrame > s.startFrame)).toBe(true);
    expect(t.scenes).toHaveLength(2);
    expect(t.scenes.map((s) => s.sceneIndexes)).toEqual([[0], [1, 2]]);
  });

  it('places light-leak overlays on cuts when enabled', () => {
    const config = configWith({
      backdrop: { lightLeaks: { enabled: true } },
      transitions: { presentations: ['fade'] },
    });
    const t = buildTimeline({
      scenes: scenesMs([0, 3000, 6000]),
      durationMs: 6000,
      fps: 30,
      config,
    });
    expect(t.overlays).toHaveLength(1);
    const o = t.overlays[0]!;
    expect(o.from + o.durationInFrames / 2).toBeCloseTo(90, 0);
    expect(o.from).toBeGreaterThanOrEqual(0);
    expect(o.from + o.durationInFrames).toBeLessThanOrEqual(t.totalFrames);
  });

  it.each([
    [[], 1000, /at least one scene/],
    [[{ startMs: 100, endMs: 1000 }], 1000, /start at 0/],
    [
      [
        { startMs: 0, endMs: 1000 },
        { startMs: 900, endMs: 2000 },
      ],
      2000,
      /contiguous/,
    ],
    [
      [
        { startMs: 0, endMs: 1000 },
        { startMs: 1200, endMs: 2000 },
      ],
      2000,
      /contiguous/,
    ],
    [[{ startMs: 0, endMs: 3000 }], 2000, /duration/],
    [[{ startMs: 0, endMs: 0 }], 1000, /positive/],
  ])('rejects malformed scene lists (%j)', (scenes, durationMs, message) => {
    expect(() => buildTimeline({ scenes, durationMs, fps: 30, config: fade18 })).toThrow(message);
  });
});
