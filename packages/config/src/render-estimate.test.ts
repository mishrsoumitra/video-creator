import { describe, expect, it } from 'vitest';
import {
  SCHEMA_DEFAULTS,
  estimateRenderTime,
  extractRenderFeatures,
  fitRenderModel,
  mergeConfig,
  type RenderSample,
  type VideoConfig,
  type VideoConfigInput,
} from './index';

const env = { durationMs: 60_000, sceneCount: 10, cpuCount: 8 };
const cfg = (patch: VideoConfigInput = {}): VideoConfig => mergeConfig(SCHEMA_DEFAULTS, patch);

/** A deterministic pseudo-random generator so the synthetic data is stable. */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

// Ground truth the synthetic "renders" are drawn from: ms per frame.
const truth = (c: VideoConfig, envOverride = env) => {
  const f = extractRenderFeatures(c, envOverride);
  const log =
    Math.log(30) +
    1.0 * Math.log(f.megapixels / 2.0736) -
    0.8 * Math.log(f.concurrency / 4) +
    0.6 * f.vector.motionBlur +
    0.3 * f.vector.lightLeaks +
    0.15 * f.vector.grain +
    0.5 * f.vector.shaderCuts +
    0.2 * f.vector.png;
  return Math.exp(log);
};

const sampleConfigs = (): Array<{ config: VideoConfig; env: typeof env }> => {
  const out: Array<{ config: VideoConfig; env: typeof env }> = [];
  const resolutions = ['720p', '1080p', '4k'] as const;
  const r = rng(7);
  for (let i = 0; i < 48; i++) {
    out.push({
      config: cfg({
        output: {
          resolution: resolutions[i % 3],
          imageFormat: i % 5 === 0 ? 'png' : 'jpeg',
          concurrency: [2, 4, 8][i % 3],
        },
        motion: { motionBlur: { enabled: i % 4 === 0, samples: 4 + (i % 3) * 4 } },
        backdrop: { lightLeaks: { enabled: i % 3 === 1 }, grain: { enabled: i % 2 === 0 } },
        transitions: { presentations: r() > 0.5 ? ['dissolve', 'fade'] : ['fade'] },
      }),
      env: { ...env, durationMs: 10_000 + Math.floor(r() * 50_000) },
    });
  }
  return out;
};

const samplesFrom = (noise = 0.03): RenderSample[] => {
  const r = rng(42);
  return sampleConfigs().map(({ config, env: e }) => {
    const features = extractRenderFeatures(config, e);
    const perFrame = truth(config, e) * Math.exp((r() - 0.5) * 2 * noise);
    return { features, elapsedMs: perFrame * features.frames, source: 'benchmark' as const };
  });
};

describe('extractRenderFeatures', () => {
  it('counts frames and megapixels from the config', () => {
    const f = extractRenderFeatures(cfg(), env);
    expect(f.frames).toBe(1800);
    expect(f.megapixels).toBeCloseTo(2.0736, 4);
    expect(
      extractRenderFeatures(cfg({ output: { resolution: '4k' } }), env).megapixels,
    ).toBeCloseTo(8.2944, 4);
    expect(extractRenderFeatures(cfg({ output: { fps: 60 } }), env).frames).toBe(3600);
  });

  it('resolves concurrency the way Remotion does', () => {
    expect(extractRenderFeatures(cfg(), { ...env, cpuCount: 10 }).concurrency).toBe(5);
    expect(extractRenderFeatures(cfg(), { ...env, cpuCount: 32 }).concurrency).toBe(8);
    expect(
      extractRenderFeatures(cfg({ output: { concurrency: '50%' } }), { ...env, cpuCount: 10 })
        .concurrency,
    ).toBe(5);
    expect(extractRenderFeatures(cfg({ output: { concurrency: 3 } }), env).concurrency).toBe(3);
  });

  it('measures the share of cuts that use shader and blur transitions', () => {
    const f = extractRenderFeatures(cfg({ transitions: { presentations: ['fade', 'dissolve'] } }), {
      ...env,
      sceneCount: 5,
    });
    expect(f.vector.shaderCuts).toBeCloseTo(0.5, 10);
    const blur = extractRenderFeatures(cfg({ transitions: { presentations: ['zoom-blur'] } }), env);
    expect(blur.vector.blurCuts).toBe(1);
    expect(blur.vector.shaderCuts).toBe(1);
  });

  it('records which named transitions a render used, for gating', () => {
    const f = extractRenderFeatures(
      cfg({ transitions: { presentations: ['film-burn', 'fade'] } }),
      env,
    );
    expect(f.transitions.sort()).toEqual(['fade', 'film-burn']);
  });
});

describe('estimateRenderTime', () => {
  it('admits it has no estimate before any render or calibration', () => {
    const e = estimateRenderTime(cfg(), env, null);
    expect(e.status).toBe('uncalibrated');
    expect(e.seconds).toBeNull();
  });

  it('recovers the true per-frame cost from measured renders', () => {
    const model = fitRenderModel(samplesFrom());
    expect(model.sampleCount).toBe(48);
    const held = cfg({
      output: { resolution: '1080p', concurrency: 4 },
      backdrop: { lightLeaks: { enabled: true } },
      motion: { motionBlur: { enabled: true, samples: 8 } },
    });
    const e = estimateRenderTime(held, env, model);
    expect(e.status).toBe('ok');
    const expected = (truth(held) * extractRenderFeatures(held, env).frames) / 1000;
    expect(e.seconds!).toBeGreaterThan(expected * 0.9);
    expect(e.seconds!).toBeLessThan(expected * 1.1);
    expect(e.lowSeconds!).toBeLessThan(e.seconds!);
    expect(e.highSeconds!).toBeGreaterThan(e.seconds!);
  });

  it('is monotonic in the things that cost render time', () => {
    const model = fitRenderModel(samplesFrom());
    const s = (patch: VideoConfigInput) => estimateRenderTime(cfg(patch), env, model).seconds!;
    expect(s({ output: { resolution: '4k' } })).toBeGreaterThan(
      s({ output: { resolution: '1080p' } }),
    );
    expect(s({ output: { resolution: '1080p' } })).toBeGreaterThan(
      s({ output: { resolution: '720p' } }),
    );
    expect(s({ motion: { motionBlur: { enabled: true, samples: 10 } } })).toBeGreaterThan(s({}));
    expect(s({ backdrop: { lightLeaks: { enabled: true } } })).toBeGreaterThan(s({}));
    expect(estimateRenderTime(cfg(), { ...env, durationMs: 120_000 }, model).seconds!).toBeCloseTo(
      2 * s({}),
      6,
    );
  });

  it('reports features it has never measured instead of guessing them', () => {
    const withoutLeaks = samplesFrom().filter((x) => x.features.vector.lightLeaks === 0);
    const model = fitRenderModel(withoutLeaks);
    const e = estimateRenderTime(cfg({ backdrop: { lightLeaks: { enabled: true } } }), env, model);
    expect(e.status).toBe('partial');
    expect(e.unmeasured).toEqual(['lightLeaks']);
    expect(estimateRenderTime(cfg(), env, model).status).toBe('ok');
  });

  it('stays finite and positive with a single sample', () => {
    const [one] = samplesFrom();
    const e = estimateRenderTime(cfg(), env, fitRenderModel([one!]));
    expect(Number.isFinite(e.seconds!)).toBe(true);
    expect(e.seconds!).toBeGreaterThan(0);
  });

  it('ignores corrupt samples', () => {
    const good = samplesFrom();
    const bad: RenderSample = { ...good[0]!, elapsedMs: Number.NaN };
    const zero: RenderSample = { ...good[1]!, elapsedMs: 0 };
    expect(fitRenderModel([...good, bad, zero]).sampleCount).toBe(48);
  });
});
