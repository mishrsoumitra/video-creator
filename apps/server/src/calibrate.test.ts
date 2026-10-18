import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATED_TRANSITIONS,
  TRANSITION_CATALOG,
  TRANSITION_NAMES,
  VideoConfigSchema,
  extractRenderFeatures,
  initialConfig,
  mergeConfig,
} from '@vc/config';
import { describe, expect, it } from 'vitest';
import { calibrationConfigs, recordCalibrationSample } from './calibrate';
import { openDb } from './db';

const configs = calibrationConfigs();

describe('calibration renders', () => {
  it('are all valid configs, and all different', () => {
    for (const config of configs) expect(VideoConfigSchema.safeParse(config).success).toBe(true);
    expect(new Set(configs.map((c) => JSON.stringify(c))).size).toBe(configs.length);
  });

  it('start from a cheap 720p base, then switch on one costly feature at a time', () => {
    const [base, ...rest] = configs;
    expect(base!.output.resolution).toBe('720p');
    expect(base!.motion.motionBlur.enabled).toBe(false);
    expect(rest.some((c) => c.output.resolution === '1080p')).toBe(true);
    expect(rest.some((c) => c.motion.motionBlur.enabled)).toBe(true);
    expect(rest.some((c) => c.output.imageFormat === 'png')).toBe(true);
    expect(new Set(rest.map((c) => c.output.codec))).toEqual(
      new Set(['h264', 'h265', 'vp9', 'prores']),
    );
  });

  it('time every shader transition, so the gated ones can be offered afterwards', () => {
    const timed = new Set(
      configs.flatMap(
        (c) =>
          extractRenderFeatures(c, { durationMs: 3000, sceneCount: 2, cpuCount: 8 }).transitions,
      ),
    );
    for (const name of TRANSITION_NAMES.filter((n) => TRANSITION_CATALOG[n].renderer === 'shader'))
      expect(timed.has(name), name).toBe(true);
    for (const gated of GATED_TRANSITIONS) expect(timed.has(gated), gated).toBe(true);
  });
});

describe('recordCalibrationSample', () => {
  it("stores a benchmark sample with this machine's cores and marks its transitions as timed", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vc-calibrate-'));
    const db = openDb(join(dir, 'app.sqlite'));
    try {
      const record = recordCalibrationSample(db, 12);
      record(
        mergeConfig(initialConfig(), { transitions: { presentations: ['crosswarp'] } }),
        3000,
        2,
        4321,
      );
      const [sample] = db.samples.all();
      expect(sample).toMatchObject({
        elapsedMs: 4321,
        source: 'benchmark',
        features: { concurrency: 6, transitions: ['crosswarp'] },
      });
      expect([...db.timedTransitions.get()]).toEqual(['crosswarp']);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
