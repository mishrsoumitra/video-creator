import { outputDimensions } from './codecs';
import type { TransitionName } from './enums';
import type { VideoConfig } from './schema';
import { TRANSITION_CATALOG } from './transitions';

/*
 * Render-time estimate "computed from the config and measured from real renders, not guessed".
 * Model: ln(ms per frame) = β·x, fitted by ridge regression on measured renders (benchmark runs
 * and every real render). Priors only pin the physics we know (cost ∝ pixels, sublinear in
 * concurrency); every effect's cost comes from measurements. Effects never measured are reported
 * as such instead of being guessed.
 */

export const VECTOR_KEYS = [
  'motionBlur',
  'lightLeaks',
  'starburst',
  'grain',
  'blurredBackdrop',
  'patterns',
  'shaderCuts',
  'blurCuts',
  'png',
  'codecH265',
  'codecVp8',
  'codecVp9',
  'codecAv1',
  'codecProres',
] as const;
export type VectorKey = (typeof VECTOR_KEYS)[number];

export type RenderFeatures = {
  frames: number;
  fps: number;
  megapixels: number;
  concurrency: number;
  vector: Record<VectorKey, number>;
  /** Transitions in the cycle, so a finished render can mark gated transitions as timed. */
  transitions: TransitionName[];
};

export type RenderSample = {
  features: RenderFeatures;
  elapsedMs: number;
  source: 'render' | 'benchmark';
};

export type RenderModel = {
  coefficients: number[];
  sampleCount: number;
  measured: VectorKey[];
  residualStd: number;
};

export type RenderEstimate = {
  status: 'uncalibrated' | 'partial' | 'ok';
  seconds: number | null;
  lowSeconds: number | null;
  highSeconds: number | null;
  unmeasured: VectorKey[];
  sampleCount: number;
};

export type RenderEnvironment = { durationMs: number; sceneCount: number; cpuCount: number };

/** Remotion's resolveConcurrency: null → round(min(8, max(1, cores/2))). */
export const resolveConcurrency = (
  value: VideoConfig['output']['concurrency'],
  cpuCount: number,
): number => {
  if (value === null) return Math.round(Math.min(8, Math.max(1, cpuCount / 2)));
  const resolved =
    typeof value === 'string'
      ? Math.floor((Number.parseFloat(value) / 100) * cpuCount)
      : Math.floor(value);
  return resolved;
};

export const extractRenderFeatures = (
  config: VideoConfig,
  env: RenderEnvironment,
): RenderFeatures => {
  const { output, backdrop, motion, transitions } = config;
  const dims = outputDimensions(config.simple.aspect, output.resolution).output;
  const cuts = Math.max(0, env.sceneCount - 1);
  const share = (predicate: (name: TransitionName) => boolean) => {
    if (cuts === 0) return 0;
    let hits = 0;
    for (let k = 0; k < cuts; k++)
      if (predicate(transitions.presentations[k % transitions.presentations.length]!)) hits++;
    return hits / cuts;
  };
  const patternKeys = [
    'linearGradient',
    'rings',
    'gridlines',
    'checkerboard',
    'zigzag',
    'tile',
    'tint',
    'vignette',
  ] as const;
  const vector: Record<VectorKey, number> = {
    motionBlur: motion.motionBlur.enabled ? Math.log(1 + motion.motionBlur.samples) : 0,
    lightLeaks: backdrop.lightLeaks.enabled ? 1 : 0,
    starburst: backdrop.starburst.enabled ? 1 : 0,
    grain: backdrop.grain.enabled ? 1 : 0,
    blurredBackdrop: backdrop.imageFit === 'contain' ? 1 : 0,
    patterns: patternKeys.filter((k) => backdrop[k].enabled).length,
    shaderCuts: share((n) => TRANSITION_CATALOG[n].renderer === 'shader'),
    blurCuts: share((n) => TRANSITION_CATALOG[n].blur),
    png: output.imageFormat === 'png' ? 1 : 0,
    codecH265: output.codec === 'h265' ? 1 : 0,
    codecVp8: output.codec === 'vp8' ? 1 : 0,
    codecVp9: output.codec === 'vp9' ? 1 : 0,
    codecAv1: output.codec === 'av1' ? 1 : 0,
    codecProres: output.codec === 'prores' ? 1 : 0,
  };
  return {
    frames: Math.max(1, Math.ceil((env.durationMs * output.fps) / 1000)),
    fps: output.fps,
    megapixels: (dims.width * dims.height) / 1e6,
    concurrency: Math.max(
      1,
      Math.min(env.cpuCount, resolveConcurrency(output.concurrency, env.cpuCount)),
    ),
    vector,
    transitions: [...new Set(transitions.presentations)],
  };
};

// Design row: [1, ln megapixels, ln concurrency, ...vector].
const row = (f: RenderFeatures): number[] => [
  1,
  Math.log(f.megapixels),
  Math.log(f.concurrency),
  ...VECTOR_KEYS.map((k) => f.vector[k]),
];

// Prior means and precisions per coefficient (intercept nearly flat).
const PRIOR_MEAN = [0, 1, -0.8, ...VECTOR_KEYS.map(() => 0)];
const PRIOR_PRECISION = [1e-6, 1, 1, ...VECTOR_KEYS.map(() => 0.1)];

const solve = (a: number[][], b: number[]): number[] => {
  const n = b.length;
  const m = a.map((r, i) => [...r, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const p = m[col]![col]!;
    for (let c = col; c <= n; c++) m[col]![c]! /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r]![col]!;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) m[r]![c]! -= factor * m[col]![c]!;
    }
  }
  return m.map((r) => r[n]!);
};

const isValidSample = (s: RenderSample) =>
  Number.isFinite(s.elapsedMs) &&
  s.elapsedMs > 0 &&
  s.features.frames > 0 &&
  s.features.megapixels > 0 &&
  s.features.concurrency >= 1 &&
  VECTOR_KEYS.every((k) => Number.isFinite(s.features.vector[k]));

export const fitRenderModel = (samples: readonly RenderSample[]): RenderModel => {
  const valid = samples.filter(isValidSample);
  const p = PRIOR_MEAN.length;
  const xtx = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? PRIOR_PRECISION[i]! : 0)),
  );
  const xty = PRIOR_MEAN.map((mu, i) => mu * PRIOR_PRECISION[i]!);
  const rows = valid.map((s) => row(s.features));
  const ys = valid.map((s) => Math.log(s.elapsedMs / s.features.frames));
  rows.forEach((x, r) => {
    for (let i = 0; i < p; i++) {
      xty[i]! += x[i]! * ys[r]!;
      for (let j = 0; j < p; j++) xtx[i]![j]! += x[i]! * x[j]!;
    }
  });
  const coefficients = solve(xtx, xty);
  const residuals = rows.map(
    (x, r) => ys[r]! - x.reduce((acc, v, i) => acc + v * coefficients[i]!, 0),
  );
  const residualStd =
    residuals.length > 1
      ? Math.sqrt(residuals.reduce((a, e) => a + e * e, 0) / (residuals.length - 1))
      : 0;
  const measured = VECTOR_KEYS.filter((k) => valid.some((s) => s.features.vector[k] !== 0));
  return { coefficients, sampleCount: valid.length, measured, residualStd };
};

export const estimateRenderTime = (
  config: VideoConfig,
  env: RenderEnvironment,
  model: RenderModel | null,
): RenderEstimate => {
  const features = extractRenderFeatures(config, env);
  const used = VECTOR_KEYS.filter((k) => features.vector[k] !== 0);
  if (!model || model.sampleCount === 0) {
    return {
      status: 'uncalibrated',
      seconds: null,
      lowSeconds: null,
      highSeconds: null,
      unmeasured: used,
      sampleCount: 0,
    };
  }
  const unmeasured = used.filter((k) => !model.measured.includes(k));
  const logPerFrame = row(features).reduce((acc, v, i) => acc + v * model.coefficients[i]!, 0);
  const seconds = (Math.exp(logPerFrame) * features.frames) / 1000;
  const spread =
    Math.max(0.1, model.residualStd) *
    (model.sampleCount < 5 ? 2 : 1) *
    (unmeasured.length > 0 ? 1.5 : 1);
  return {
    status: unmeasured.length > 0 ? 'partial' : 'ok',
    seconds,
    lowSeconds: seconds * Math.exp(-1.645 * spread),
    highSeconds: seconds * Math.exp(1.645 * spread),
    unmeasured,
    sampleCount: model.sampleCount,
  };
};
