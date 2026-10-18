import type { Aspect } from '@vc/config';
import { DEFAULT_LICENSES, filterCandidates, rankCandidates } from './images';
import type { ImageCandidate } from './services';

export type ThresholdScene = {
  id: string;
  category: string;
  narration: string;
  imageQuery: string;
  acceptable: string[];
  candidates: Array<Pick<ImageCandidate, 'id' | 'title' | 'tags' | 'width' | 'height' | 'license'>>;
};
export type ThresholdDataset = { version: number; aspect: Aspect; scenes: ThresholdScene[] };

/** One wrong deterministic pick costs as much as four vision calls. */
export const VISION_CALL_COST = 0.25;

const best = (scene: ThresholdScene, aspect: Aspect) => {
  const candidates = scene.candidates.map((c): ImageCandidate => ({
    ...c,
    provider: 'fixture',
    url: '',
    thumbnailUrl: null,
    licenseVersion: null,
    licenseUrl: null,
    creator: null,
    sourceUrl: null,
  }));
  const ranked = rankCandidates(
    { ...scene, keywords: [] },
    filterCandidates(candidates, { aspect, licenses: DEFAULT_LICENSES }).kept,
    aspect,
  );
  return ranked[0] ?? null;
};

export type ThresholdEvaluation = {
  threshold: number;
  /** Errors on accepted scenes + VISION_CALL_COST per vision call. */
  cost: number;
  accepted: number;
  accuracyWhenAccepted: number;
  byCategory: Record<string, { total: number; accepted: number; correctAccepted: number }>;
};

export const evaluateThreshold = (
  data: ThresholdDataset,
  threshold: number,
): ThresholdEvaluation => {
  let cost = 0;
  let accepted = 0;
  let correctAccepted = 0;
  const byCategory: ThresholdEvaluation['byCategory'] = {};
  for (const scene of data.scenes) {
    const top = best(scene, data.aspect);
    const cat = (byCategory[scene.category] ??= { total: 0, accepted: 0, correctAccepted: 0 });
    cat.total++;
    if (top && top.scores.score >= threshold) {
      accepted++;
      cat.accepted++;
      const correct = scene.acceptable.includes(top.candidate.id);
      if (correct) {
        correctAccepted++;
        cat.correctAccepted++;
      } else {
        cost += 1;
      }
    } else {
      cost += VISION_CALL_COST;
    }
  }
  return {
    threshold,
    cost,
    accepted,
    accuracyWhenAccepted: accepted === 0 ? 1 : correctAccepted / accepted,
    byCategory,
  };
};

/**
 * Picks the threshold that minimises errors + vision calls on the labelled set. Thresholds between
 * two scenes' scores give the same decisions; the middle of the best plateau is the most robust.
 */
export const tuneThreshold = (data: ThresholdDataset): ThresholdEvaluation => {
  const grid = Array.from({ length: 101 }, (_, i) => i / 100);
  const evaluations = grid.map((t) => evaluateThreshold(data, t));
  const minCost = Math.min(...evaluations.map((e) => e.cost));
  const first = evaluations.findIndex((e) => Math.abs(e.cost - minCost) < 1e-9);
  let last = first;
  while (last + 1 < evaluations.length && Math.abs(evaluations[last + 1]!.cost - minCost) < 1e-9)
    last++;
  const threshold = Math.round(((grid[first]! + grid[last]!) / 2) * 100) / 100;
  return evaluateThreshold(data, threshold);
};
