/**
 * Re-tunes the deterministic image-score threshold on fixtures/image-scenes.json and prints the
 * per-category result. Update IMAGE_SCORE_THRESHOLD in src/images.ts when the scoring changes.
 *   npm run tune:threshold
 */
import dataset from '../fixtures/image-scenes.json' with { type: 'json' };
import { evaluateThreshold, tuneThreshold, type ThresholdDataset } from '../src/image-threshold';
import { IMAGE_SCORE_THRESHOLD } from '../src/images';

const data = dataset as ThresholdDataset;
const tuned = tuneThreshold(data);
console.log(`Tuned threshold: ${tuned.threshold} (shipped: ${IMAGE_SCORE_THRESHOLD})`);
console.log(
  `Accepted without vision: ${tuned.accepted}/${data.scenes.length}, accuracy ${(tuned.accuracyWhenAccepted * 100).toFixed(0)}%`,
);
for (const [category, r] of Object.entries(tuned.byCategory)) {
  console.log(
    `  ${category.padEnd(9)} ${r.accepted}/${r.total} deterministic, ${r.correctAccepted} correct`,
  );
}
for (const t of [0.5, 0.6, 0.7]) {
  const e = evaluateThreshold(data, t);
  console.log(
    `  at ${t}: cost ${e.cost.toFixed(2)}, accepted ${e.accepted}, accuracy ${(e.accuracyWhenAccepted * 100).toFixed(0)}%`,
  );
}
if (tuned.threshold !== IMAGE_SCORE_THRESHOLD) process.exitCode = 1;
