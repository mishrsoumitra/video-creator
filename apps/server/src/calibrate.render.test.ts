import { join } from 'node:path';
import {
  GATED_TRANSITIONS,
  estimateRenderTime,
  extractRenderFeatures,
  fitRenderModel,
  initialConfig,
  mergeConfig,
  type RenderSample,
} from '@vc/config';
import { describe, expect, it } from 'vitest';
import { calibrationConfigs } from './calibrate';
import { createRemotionRenderer } from './renderer';

const repo = new URL('../../..', import.meta.url).pathname;

describe('calibration renders: render time measured, not guessed', () => {
  it('times every feature and every shader transition, which unlocks the gated ones', async () => {
    const renderer = createRemotionRenderer({
      bundleDir: null,
      entryPoint: join(repo, 'packages/composition/src/entry.ts'),
      publicDir: join(repo, 'packages/composition/public'),
    });
    const samples: RenderSample[] = [];
    const timed = new Set<string>();
    await renderer.run((config, durationMs, sceneCount, elapsedMs) => {
      const features = extractRenderFeatures(config, { durationMs, sceneCount, cpuCount: 8 });
      samples.push({ features, elapsedMs, source: 'benchmark' });
      for (const t of features.transitions) timed.add(t);
    });
    expect(samples).toHaveLength(calibrationConfigs().length);
    expect(samples.every((s) => s.elapsedMs > 0)).toBe(true);
    for (const gated of GATED_TRANSITIONS) expect(timed.has(gated)).toBe(true);

    const model = fitRenderModel(samples);
    const estimate = estimateRenderTime(
      initialConfig(),
      { durationMs: 60_000, sceneCount: 10, cpuCount: 8 },
      model,
    );
    expect(estimate.status).toBe('ok');
    expect(estimate.seconds).toBeGreaterThan(0);
    const blurred = estimateRenderTime(
      mergeConfig(initialConfig(), { motion: { motionBlur: { enabled: true, samples: 6 } } }),
      { durationMs: 60_000, sceneCount: 10, cpuCount: 8 },
      model,
    );
    expect(blurred.status).toBe('ok');
    console.log(
      'calibrated estimate for a 60 s documentary at 1080p:',
      estimate.seconds?.toFixed(1),
      's; with motion blur:',
      blurred.seconds?.toFixed(1),
      's',
    );
  });
});
