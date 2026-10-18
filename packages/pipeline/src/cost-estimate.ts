import { targetSceneCount, type AnimationKind } from '@vc/config';
import { VISION_TOP_K } from './images';
import { priceUsage, type PriceLookup, type Stage } from './ledger';
import type { Role, Usage } from './roles';
import { wordBudget } from './text';

export type EstimateProviders = {
  text: { providerId: string; model: string };
  search: { providerId: string; model: string | null; usesModel: boolean } | null;
  voice: { providerId: string; model: string; returnsTimings: boolean } | null;
  align: { providerId: string; model: string } | null;
  vision: { providerId: string; model: string } | null;
};

export type EstimateLine = {
  stage: Stage;
  role: Role;
  providerId: string;
  model: string;
  units: Usage;
  usd: number;
  maxUsd: number;
  note: string;
};
export type CostEstimate = {
  totalUsd: number;
  maxUsd: number;
  lines: EstimateLine[];
  unpriced: string[];
};

/** Share of scenes whose best image score falls below the threshold (from the tuning set). */
export const EXPECTED_VISION_SHARE = 0.2;
const CHARS_PER_WORD = 6;

/**
 * The cost shown before Generate: every call the pipeline will make for this request, priced
 * with the provider tables. `maxUsd` includes the allowed retries and every optional AI call.
 */
export const estimateJobCost = (input: {
  lengthSeconds: number;
  animationKind: AnimationKind;
  providers: EstimateProviders;
  prices: PriceLookup;
  sourceTextProvided: boolean;
  recordingProvided: boolean;
  visionAlways: boolean;
  visionFinalCheck: boolean;
}): CostEstimate => {
  const { providers, prices } = input;
  const words = wordBudget(input.lengthSeconds);
  const scenes = targetSceneCount(input.lengthSeconds, input.animationKind);
  const lines: EstimateLine[] = [];
  const unpriced = new Set<string>();

  const add = (
    stage: Stage,
    role: Role,
    p: { providerId: string; model: string | null },
    units: Usage,
    note: string,
    maxFactor = 1,
    maxUnits?: Usage,
  ) => {
    const model = p.model ?? 'search-api';
    const table = prices(p.providerId, model, role);
    if (table === null) unpriced.add(`${p.providerId}/${model}`);
    const usd = priceUsage(units, table);
    lines.push({
      stage,
      role,
      providerId: p.providerId,
      model,
      units,
      usd,
      maxUsd: maxUnits ? priceUsage(maxUnits, table) : usd * maxFactor,
      note,
    });
  };

  if (!input.sourceTextProvided && providers.search) {
    const s = providers.search;
    add(
      'research',
      'search',
      s,
      s.usesModel ? { searches: 3, inputTokens: 2000, outputTokens: 600 } : { searches: 1 },
      'Find source pages',
    );
    add(
      'research',
      'text',
      providers.text,
      { inputTokens: 9000, outputTokens: 1500 },
      'Fact sheet from fetched pages',
      2,
    );
  }
  add(
    'script',
    'text',
    providers.text,
    { inputTokens: 1500 + words * 2, outputTokens: Math.ceil(words * 1.6 + scenes * 25) },
    'Script to the word budget',
    2,
  );
  if (!input.recordingProvided && providers.voice) {
    add(
      'voice',
      'voice',
      providers.voice,
      { characters: words * CHARS_PER_WORD },
      'Narration (TTS)',
    );
  }
  if (input.recordingProvided || (providers.voice && !providers.voice.returnsTimings)) {
    if (providers.align)
      add(
        'timing',
        'align',
        providers.align,
        { audioSeconds: input.lengthSeconds },
        'Word timings (forced alignment)',
      );
  }
  if (providers.vision) {
    const perCall = (n: number): Usage => ({
      images: n * VISION_TOP_K,
      inputTokens: n * (300 + VISION_TOP_K * 800),
      outputTokens: n * 150,
    });
    const expected = input.visionAlways
      ? scenes
      : Math.max(1, Math.round(scenes * EXPECTED_VISION_SHARE));
    add(
      'images',
      'vision',
      providers.vision,
      perCall(expected),
      input.visionAlways
        ? 'Vision ranks every scene (on in Settings)'
        : 'Vision ranks low-scoring scenes',
      1,
      perCall(scenes),
    );
    if (input.visionFinalCheck)
      add(
        'checks',
        'vision',
        providers.vision,
        { images: 1, inputTokens: 1500, outputTokens: 200 },
        'Contact-sheet frame check',
      );
  }

  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    totalUsd: round(lines.reduce((s, l) => s + l.usd, 0)),
    maxUsd: round(lines.reduce((s, l) => s + l.maxUsd, 0)),
    lines,
    unpriced: [...unpriced],
  };
};
