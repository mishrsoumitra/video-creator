/**
 * Times the calibration renders on this machine and stores them, exactly like Settings →
 * "Calibrate render estimates". The render-time estimate then uses measured numbers, and the
 * shader transitions that must be timed before they are offered (crosswarp, ripple, film-burn,
 * book-flip) become available. Run it on the machine that will render:
 *   npm run calibrate            (reads VC_DATA_DIR like the server; the server may keep running)
 */
import { mkdir } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { GATED_TRANSITIONS } from '@vc/config';
import { calibrationConfigs, recordCalibrationSample } from '../src/calibrate';
import { openDb } from '../src/db';
import { readEnv } from '../src/env';
import { createRemotionRenderer } from '../src/renderer';

const env = readEnv(process.env);
await mkdir(env.dataDir, { recursive: true, mode: 0o700 });
const db = openDb(join(env.dataDir, 'app.sqlite'));
const renderer = createRemotionRenderer({
  bundleDir: env.bundleDir,
  entryPoint: env.entryPoint,
  publicDir: env.publicDir,
});
const record = recordCalibrationSample(db, availableParallelism());
const total = calibrationConfigs().length;
let done = 0;

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.stdout.write(`Calibrating with ${total} short renders. Data: ${env.dataDir}\n`);
try {
  await renderer.run((config, durationMs, sceneCount, elapsedMs) => {
    record(config, durationMs, sceneCount, elapsedMs);
    done++;
    const label = `${config.output.resolution} ${config.output.codec} · ${config.transitions.presentations.join(', ')}`;
    process.stdout.write(
      `  ${String(done).padStart(2)}/${total}  ${(elapsedMs / 1000).toFixed(1).padStart(5)} s  ${label}\n`,
    );
  }, controller.signal);
  const timed = db.timedTransitions.get();
  process.stdout.write(
    `\n${db.samples.all().length} samples stored. Gated transitions now timed: ${GATED_TRANSITIONS.filter((t) => timed.has(t)).join(', ') || 'none'}.\n`,
  );
} finally {
  db.close();
}
