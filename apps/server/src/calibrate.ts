import {
  SCHEMA_DEFAULTS,
  TRANSITION_CATALOG,
  TRANSITION_NAMES,
  extractRenderFeatures,
  initialConfig,
  mergeConfig,
  type VideoConfig,
  type VideoConfigInput,
} from '@vc/config';
import type { Db } from './db';

/**
 * What calibration renders: a base look at two resolutions, then each costly feature on its own,
 * and every shader transition (which also "times" the gated ones so the UI can expose them).
 */
export const calibrationConfigs = (): VideoConfig[] => {
  const base = mergeConfig(initialConfig(), {
    output: { resolution: '720p' },
    backdrop: { vignette: { enabled: false } },
  });
  const v = (patch: VideoConfigInput) => mergeConfig(base, patch);
  return [
    base,
    v({ output: { resolution: '1080p' } }),
    v({ motion: { motionBlur: { enabled: true, samples: 6 } } }),
    v({ backdrop: { lightLeaks: { enabled: true } } }),
    v({ backdrop: { grain: { enabled: true } } }),
    v({ backdrop: { imageFit: 'contain' } }),
    v({ backdrop: { gridlines: { enabled: true }, linearGradient: { enabled: true } } }),
    v({ backdrop: { starburst: { enabled: true } } }),
    v({ output: { imageFormat: 'png' } }),
    v({ output: { codec: 'h265' } }),
    v({ output: { codec: 'vp9' } }),
    v({ output: { codec: 'prores', proResProfile: 'standard' } }),
    ...TRANSITION_NAMES.filter((n) => TRANSITION_CATALOG[n].renderer === 'shader').map((name) =>
      v({ transitions: { presentations: [name] } }),
    ),
  ].map((c) => mergeConfig(SCHEMA_DEFAULTS, c));
};

/** Stores one calibration render: a benchmark sample for the model, and the transitions it timed. */
export const recordCalibrationSample =
  (db: Db, cpuCount: number) =>
  (config: VideoConfig, durationMs: number, sceneCount: number, elapsedMs: number): void => {
    const features = extractRenderFeatures(config, { durationMs, sceneCount, cpuCount });
    db.samples.insert({ features, elapsedMs, source: 'benchmark' });
    db.timedTransitions.add(features.transitions);
  };
