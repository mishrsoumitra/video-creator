import type { StageContext } from './context';
import { tryExtractJsonObject } from './json';
import type { VisionImage, VisionProvider } from './roles';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';
export type Check = { id: string; label: string; status: CheckStatus; detail: string };

export type CaptionOverflow = {
  pageText: string;
  fontSize: number;
  overflowPx: number;
  sceneIndex?: number;
};
export type ClippingReport = { peakDbfs: number; clippedSamples: number; clipped: boolean };

export type FinalCheckInput = {
  plan: {
    durationMs: number;
    scenes: ReadonlyArray<{
      visual: { type: 'image'; src: string } | { type: 'typographic'; text: string };
    }>;
  };
  fps: number;
  renderedDurationMs: number;
  requestedLengthSeconds: number;
  /** Reported by the composition through the renderer's browser log. */
  captionOverflows: readonly CaptionOverflow[];
  clipping: ClippingReport;
  vision: VisionProvider | null;
  visionFinalCheck: boolean;
  isStyleRerun: boolean;
  contactSheet: () => Promise<VisionImage>;
};

/** Narration may land this far from the requested length before we warn. */
export const LENGTH_TOLERANCE = 0.25;

/**
 * Final checks: duration within tolerance, a visual for every scene, caption overflow, audio
 * clipping. A vision model looks at a 12-frame contact sheet only when enabled in Settings (off by
 * default), and never on a style-only rerun.
 */
export const runFinalChecks = async (
  ctx: StageContext,
  input: FinalCheckInput,
): Promise<{ checks: Check[]; passed: boolean }> => {
  const checks: Check[] = [];
  const frameMs = 1000 / input.fps;
  const expectedMs =
    (Math.ceil((input.plan.durationMs * input.fps) / 1000 - 1e-9) / input.fps) * 1000;
  const drift = Math.abs(input.renderedDurationMs - expectedMs);
  const tolerance = frameMs + 50;
  checks.push({
    id: 'duration',
    label: 'Duration matches the narration',
    status: drift <= tolerance ? 'pass' : 'fail',
    detail: `Rendered ${(input.renderedDurationMs / 1000).toFixed(2)} s, expected ${(expectedMs / 1000).toFixed(2)} s (±${Math.round(tolerance)} ms).`,
  });

  const ratio = input.plan.durationMs / 1000 / input.requestedLengthSeconds;
  checks.push({
    id: 'length-target',
    label: 'Close to the requested length',
    status: Math.abs(ratio - 1) <= LENGTH_TOLERANCE ? 'pass' : 'warn',
    detail: `Narration is ${(input.plan.durationMs / 1000).toFixed(1)} s for a ${input.requestedLengthSeconds} s request.`,
  });

  const missing = input.plan.scenes
    .map((s, i) =>
      (s.visual.type === 'image' && s.visual.src) ||
      (s.visual.type === 'typographic' && s.visual.text.trim())
        ? null
        : i + 1,
    )
    .filter((i): i is number => i !== null);
  checks.push({
    id: 'visuals',
    label: 'Every scene has an image or a typographic fallback',
    status: missing.length === 0 ? 'pass' : 'fail',
    detail:
      missing.length === 0
        ? `${input.plan.scenes.length} scenes covered.`
        : `Scenes without a visual: ${missing.join(', ')}.`,
  });

  checks.push({
    id: 'caption-overflow',
    label: 'Captions fit',
    status: input.captionOverflows.length === 0 ? 'pass' : 'warn',
    detail:
      input.captionOverflows.length === 0
        ? 'No caption overflowed its box.'
        : `${input.captionOverflows.length} caption page(s) overflowed even at the minimum size: ${input.captionOverflows
            .slice(0, 3)
            .map((o) => `“${o.pageText}”`)
            .join(', ')}.`,
  });

  checks.push({
    id: 'audio-clipping',
    label: 'Audio does not clip',
    status: input.clipping.clipped ? 'warn' : 'pass',
    detail: `Peak ${input.clipping.peakDbfs.toFixed(1)} dBFS, ${input.clipping.clippedSamples} clipped samples.`,
  });

  checks.push(await visionCheck(ctx, input));
  return { checks, passed: checks.every((c) => c.status !== 'fail') };
};

const visionCheck = async (ctx: StageContext, input: FinalCheckInput): Promise<Check> => {
  const skipped = (detail: string): Check => ({
    id: 'vision-frames',
    label: 'Vision frame check',
    status: 'skipped',
    detail,
  });
  if (!input.visionFinalCheck) return skipped('Off (enable it in Settings).');
  if (input.isStyleRerun) return skipped('Not run on a style-only rerun.');
  if (!input.vision) return skipped('No vision provider is set up.');
  const vision = input.vision;
  const sheet = await input.contactSheet();
  const outcome = await ctx.ledger.call(
    {
      stage: 'checks',
      role: 'vision',
      providerId: vision.providerId,
      model: vision.model,
      required: false,
      estimate: { images: 1, inputTokens: 1500, outputTokens: 200 },
      reason: 'The vision frame check is turned on in Settings.',
    },
    () =>
      vision.describe(
        {
          prompt:
            'This is a contact sheet of 12 frames from a narrated video, numbered left to right, top to bottom. List visible problems only: black or broken frames, text running off the frame, captions covering faces, unreadable text. Reply with JSON only: {"issues":[{"frame":1,"problem":"..."}]}',
          images: [sheet],
          maxOutputTokens: 400,
          json: true,
        },
        { signal: ctx.signal },
      ),
  );
  if (outcome.status !== 'ok') return skipped('Skipped: the per-job cost cap was reached.');
  const json = tryExtractJsonObject(outcome.value);
  const issues =
    json.ok && Array.isArray((json.value as { issues?: unknown }).issues)
      ? ((json.value as { issues: unknown[] }).issues as Array<{
          frame?: unknown;
          problem?: unknown;
        }>)
      : null;
  if (!issues)
    return {
      id: 'vision-frames',
      label: 'Vision frame check',
      status: 'warn',
      detail: 'The vision reply could not be read.',
    };
  const lines = issues
    .filter((i) => typeof i.problem === 'string')
    .map((i) => `frame ${Number(i.frame) || '?'}: ${String(i.problem)}`);
  return {
    id: 'vision-frames',
    label: 'Vision frame check',
    status: lines.length === 0 ? 'pass' : 'warn',
    detail: lines.length === 0 ? 'No problems seen on the contact sheet.' : lines.join('; '),
  };
};
