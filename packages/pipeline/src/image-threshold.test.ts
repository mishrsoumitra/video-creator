import { describe, expect, it } from 'vitest';
import dataset from '../fixtures/image-scenes.json' with { type: 'json' };
import { evaluateThreshold, tuneThreshold, type ThresholdDataset } from './image-threshold';
import { IMAGE_SCORE_THRESHOLD } from './images';

const data = dataset as ThresholdDataset;

describe('image score threshold, tuned on a test set of 50 scenes', () => {
  it('uses a set of 50 labelled scenes', () => {
    expect(data.scenes).toHaveLength(50);
    expect(new Set(data.scenes.map((s) => s.category))).toEqual(
      new Set(['history', 'nature', 'science', 'abstract']),
    );
  });

  it('ships the threshold the tuner picks', () => {
    expect(IMAGE_SCORE_THRESHOLD).toBe(tuneThreshold(data).threshold);
  });

  it('is right when it skips the vision model', () => {
    expect(
      evaluateThreshold(data, IMAGE_SCORE_THRESHOLD).accuracyWhenAccepted,
    ).toBeGreaterThanOrEqual(0.9);
  });

  it('lets the deterministic path handle most historical and nature topics', () => {
    const r = evaluateThreshold(data, IMAGE_SCORE_THRESHOLD);
    const share =
      (r.byCategory.history!.accepted + r.byCategory.nature!.accepted) /
      (r.byCategory.history!.total + r.byCategory.nature!.total);
    expect(share).toBeGreaterThanOrEqual(0.7);
  });

  it('sends most abstract topics to the vision model', () => {
    const r = evaluateThreshold(data, IMAGE_SCORE_THRESHOLD);
    expect(r.byCategory.abstract!.accepted / r.byCategory.abstract!.total).toBeLessThanOrEqual(0.4);
  });

  it('beats both extremes (never / always calling vision) on the tuning objective', () => {
    const tuned = tuneThreshold(data);
    expect(tuned.cost).toBeLessThan(evaluateThreshold(data, 0).cost);
    expect(tuned.cost).toBeLessThan(evaluateThreshold(data, 1.01).cost);
  });
});
