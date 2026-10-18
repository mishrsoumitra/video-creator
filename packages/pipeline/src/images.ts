import type { Aspect, CaptionPosition, Credit } from '@vc/config';
import { CACHE_TTL_MS, cacheKeys } from './cache';
import { throwIfAborted, type StageContext } from './context';
import { captionPlacementFor, type CaptionPlacement, type ImageAnalysis } from './image-analysis';
import { tryExtractJsonObject } from './json';
import type { CallOptions, VisionImage, VisionProvider } from './roles';
import type { ImageCandidate, ImageSource } from './services';
import { keywordStems } from './text';

/** Tuned on fixtures/image-scenes.json by image-threshold.ts (see image-threshold.test.ts). */
export const IMAGE_SCORE_THRESHOLD = 0.65;
/** Below this text relevance an image is unrelated: use a typographic scene instead. */
export const MIN_RELEVANCE = 0.15;
/** Vision ranks at most this many candidates. */
export const VISION_TOP_K = 6;
/** Vision rates 0..10; below this nothing is good enough. */
export const VISION_MIN_SCORE = 6;
/** Commercial use and modification allowed. */
export const DEFAULT_LICENSES = ['cc0', 'pdm', 'by', 'by-sa'] as const;

const ASPECT_RATIO: Record<Aspect, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 };
const MIN_SHORT_SIDE = 480;
const MAX_SHAPE_FACTOR = 3;

export type SceneText = { narration: string; imageQuery: string; keywords: readonly string[] };
export type ScoreBreakdown = { score: number; text: number; aspect: number; size: number };
export type RankedCandidate = { candidate: ImageCandidate; scores: ScoreBreakdown };

export const filterCandidates = (
  candidates: readonly ImageCandidate[],
  {
    aspect,
    licenses,
    exclude = new Set(),
  }: { aspect: Aspect; licenses: readonly string[]; exclude?: ReadonlySet<string> },
) => {
  const kept: ImageCandidate[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];
  for (const c of candidates) {
    const license = c.license.toLowerCase();
    const shape =
      c.width && c.height ? Math.abs(Math.log(c.width / c.height / ASPECT_RATIO[aspect])) : 0;
    if (!licenses.includes(license))
      rejected.push({ id: c.id, reason: `licence ${license} not allowed` });
    else if (c.width && c.height && Math.min(c.width, c.height) < MIN_SHORT_SIDE)
      rejected.push({ id: c.id, reason: 'too small' });
    else if (shape > Math.log(MAX_SHAPE_FACTOR)) rejected.push({ id: c.id, reason: 'wrong shape' });
    else if (c.mature) rejected.push({ id: c.id, reason: 'mature' });
    else if (exclude.has(c.id)) rejected.push({ id: c.id, reason: 'used in another scene' });
    else kept.push(c);
  }
  return { kept, rejected };
};

const coverage = (wanted: ReadonlyMap<string, number>, have: ReadonlySet<string>) => {
  let total = 0;
  let hit = 0;
  for (const [term, weight] of wanted) {
    total += weight;
    if (have.has(term)) hit += weight;
  }
  return total === 0 ? 0 : hit / total;
};

/**
 * Deterministic relevance: overlap between the scene's words and the image's title and tags
 * (stemmed, stopwords removed), plus how well its shape and size suit the frame.
 */
export const scoreCandidate = (
  scene: SceneText,
  candidate: ImageCandidate,
  aspect: Aspect,
): ScoreBreakdown => {
  const query = new Map(keywordStems(scene.imageQuery).map((t) => [t, 1] as const));
  const context = new Map<string, number>();
  for (const t of keywordStems(scene.narration)) context.set(t, 1);
  for (const t of keywordStems(scene.keywords.join(' '))) context.set(t, 1.5);
  const have = new Set(keywordStems([candidate.title, ...candidate.tags].join(' ')));
  const text = 0.7 * coverage(query, have) + 0.3 * coverage(context, have);
  const ratio = candidate.width && candidate.height ? candidate.width / candidate.height : null;
  const aspectScore =
    ratio === null
      ? 0.5
      : Math.max(
          0,
          1 - Math.abs(Math.log(ratio / ASPECT_RATIO[aspect])) / Math.log(MAX_SHAPE_FACTOR),
        );
  const size =
    candidate.width && candidate.height
      ? Math.min(1, Math.min(candidate.width, candidate.height) / 1080)
      : 0.5;
  const score = 0.75 * text + 0.15 * aspectScore + 0.1 * size;
  return {
    score: Math.round(score * 1e6) / 1e6,
    text: Math.round(text * 1e6) / 1e6,
    aspect: aspectScore,
    size,
  };
};

export const rankCandidates = (
  scene: SceneText,
  candidates: readonly ImageCandidate[],
  aspect: Aspect,
): RankedCandidate[] =>
  candidates
    .map((candidate) => ({ candidate, scores: scoreCandidate(scene, candidate, aspect) }))
    .sort(
      (a, b) => b.scores.score - a.scores.score || a.candidate.id.localeCompare(b.candidate.id),
    );

export interface ImageOps {
  /** Downloads into the job folder (validating type and size); returns the real path and size. */
  download(
    candidate: ImageCandidate,
    name: string,
    options?: CallOptions,
  ): Promise<{ path: string; width: number; height: number }>;
  /** A small image for the vision model. */
  thumbnail(candidate: ImageCandidate, options?: CallOptions): Promise<VisionImage>;
  analyze(path: string): Promise<ImageAnalysis>;
  /** Five palette colours pulled from the image (used when the palette source is "image"). */
  palette(path: string): Promise<string[]>;
}

export type SceneVisual = {
  visual:
    | {
        type: 'image';
        src: string;
        width: number;
        height: number;
        credit: Credit;
        subject?: ImageAnalysis['subject'];
      }
    | { type: 'typographic'; text: string };
  captionPlacement: CaptionPlacement;
  analysis: ImageAnalysis | null;
};

export type ImageDecision = {
  sceneIndex: number;
  query: string;
  method: 'deterministic' | 'vision' | 'fallback';
  bestScore: number | null;
  chosenId: string | null;
  reason: string;
  candidatesConsidered: number;
};

type CachedImages = { candidates: ImageCandidate[]; ratings?: Record<string, number> };

const titleCase = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)(\p{Ll})/gu, (_, space: string, ch: string) => space + ch.toUpperCase());

const typographicText = (scene: SceneText) => {
  const source = scene.imageQuery.trim() || scene.narration.split(/\s+/).slice(0, 6).join(' ');
  return titleCase(source).slice(0, 80);
};

const creditFor = (c: ImageCandidate): Credit => ({
  title: c.title,
  creator: c.creator,
  license: c.license.toLowerCase(),
  licenseVersion: c.licenseVersion,
  licenseUrl: c.licenseUrl,
  sourceUrl: c.sourceUrl,
  provider: c.provider,
});

const visionPrompt = (scene: SceneText, count: number) =>
  [
    `Scene narration: "${scene.narration}"`,
    `Rate each of the ${count} numbered images from 0 to 10 for how well it illustrates this narration in a documentary video.`,
    '10 = ideal, 0 = unrelated, misleading or inappropriate. Judge only what is visible.',
    'Reply with JSON only: {"ratings":[{"index":1,"score":7}]}',
  ].join('\n');

const parseRatings = (reply: string, ids: readonly string[]): Record<string, number> | null => {
  const json = tryExtractJsonObject(reply);
  if (!json.ok || typeof json.value !== 'object' || json.value === null) return null;
  const list = (json.value as { ratings?: unknown }).ratings;
  if (!Array.isArray(list)) return null;
  const out: Record<string, number> = {};
  for (const item of list) {
    const index = Number((item as { index?: unknown }).index);
    const score = Number((item as { score?: unknown }).score);
    if (Number.isInteger(index) && index >= 1 && index <= ids.length && Number.isFinite(score))
      out[ids[index - 1]!] = Math.max(0, Math.min(10, score));
  }
  return Object.keys(out).length > 0 ? out : null;
};

/**
 * Images. Deterministic first: keyword search, licence/size/shape filters and title/tag scoring.
 * A vision model ranks the top 6 only when the best deterministic score is below the threshold,
 * or when the user turned Vision on in Settings. When nothing passes, the scene is typographic.
 */
export const runImages = async (
  ctx: StageContext,
  input: {
    scenes: readonly SceneText[];
    aspect: Aspect;
    captionPosition: CaptionPosition;
    source: ImageSource;
    ops: ImageOps;
    vision: VisionProvider | null;
    visionAlways: boolean;
    threshold?: number;
    licenses?: readonly string[];
  },
): Promise<{ scenes: SceneVisual[]; decisions: ImageDecision[] }> => {
  const { aspect, ops, vision, visionAlways } = input;
  const threshold = input.threshold ?? IMAGE_SCORE_THRESHOLD;
  const licenses = input.licenses ?? DEFAULT_LICENSES;
  const used = new Set<string>();
  const scenes: SceneVisual[] = [];
  const decisions: ImageDecision[] = [];

  for (const [sceneIndex, scene] of input.scenes.entries()) {
    throwIfAborted(ctx.signal);
    const query = scene.imageQuery.trim() || scene.narration;
    const key = cacheKeys.images({ query, aspect, licenses });
    const hit = await ctx.cache.get<CachedImages>(key);
    let cached: CachedImages;
    if (hit) {
      cached = hit.value;
    } else {
      let found: ImageCandidate[] = [];
      try {
        found = await input.source.search(
          { query, aspect, licenses, pageSize: 20 },
          { signal: ctx.signal },
        );
      } catch (error) {
        ctx.log({
          stage: 'images',
          message: `Image search failed for "${query}"`,
          data: { error: String(error) },
        });
      }
      cached = { candidates: filterCandidates(found, { aspect, licenses }).kept };
    }

    const ranked = rankCandidates(
      scene,
      filterCandidates(cached.candidates, { aspect, licenses, exclude: used }).kept,
      aspect,
    );
    const best = ranked[0] ?? null;
    let order: RankedCandidate[] = [];
    let method: ImageDecision['method'] = 'fallback';
    let reason = 'No candidate images.';

    if (best) {
      const needVision = visionAlways || best.scores.score < threshold;
      let ratings = cached.ratings;
      if (needVision && vision && !ratings) {
        const top = ranked.slice(0, VISION_TOP_K);
        const thumbs: Array<{ id: string; image: VisionImage }> = [];
        for (const r of top) {
          try {
            thumbs.push({
              id: r.candidate.id,
              image: await ops.thumbnail(r.candidate, { signal: ctx.signal }),
            });
          } catch {
            // A missing thumbnail just leaves that candidate unrated.
          }
        }
        if (thumbs.length > 0) {
          const outcome = await ctx.ledger.call(
            {
              stage: 'images',
              role: 'vision',
              providerId: vision.providerId,
              model: vision.model,
              required: false,
              estimate: {
                images: thumbs.length,
                inputTokens: 300 + thumbs.length * 800,
                outputTokens: 150,
              },
              reason: visionAlways
                ? 'Vision ranking is turned on in Settings.'
                : `Best deterministic score ${best.scores.score.toFixed(2)} is below the threshold ${threshold}; the vision model ranks the top ${thumbs.length}.`,
            },
            () =>
              vision.describe(
                {
                  prompt: visionPrompt(scene, thumbs.length),
                  images: thumbs.map((t) => t.image),
                  maxOutputTokens: 300,
                  json: true,
                },
                { signal: ctx.signal },
              ),
          );
          if (outcome.status === 'ok') {
            ratings =
              parseRatings(
                outcome.value,
                thumbs.map((t) => t.id),
              ) ?? undefined;
            if (ratings) cached = { ...cached, ratings };
            else
              ctx.log({
                stage: 'images',
                message: 'The vision reply could not be read; using the deterministic ranking.',
              });
          }
        }
      }

      if (needVision && ratings) {
        const rated = ranked.filter((r) => (ratings![r.candidate.id] ?? -1) >= VISION_MIN_SCORE);
        rated.sort((a, b) => ratings![b.candidate.id]! - ratings![a.candidate.id]!);
        if (rated.length > 0) {
          order = rated;
          method = 'vision';
          reason = `Vision rated ${rated[0]!.candidate.id} ${ratings[rated[0]!.candidate.id]}/10.`;
        } else {
          reason = 'Vision rated every candidate below 6/10.';
        }
      } else if (!needVision) {
        order = ranked;
        method = 'deterministic';
        reason = `Deterministic score ${best.scores.score.toFixed(2)} ≥ threshold ${threshold}.`;
      } else if (best.scores.text >= MIN_RELEVANCE) {
        order = ranked.filter((r) => r.scores.text >= MIN_RELEVANCE);
        method = 'deterministic';
        reason = `Below the threshold but relevant (text ${best.scores.text.toFixed(2)}); no vision ranking available.`;
      } else {
        reason = 'No candidate is relevant enough.';
      }
    }
    if (!hit || cached.ratings !== hit.value.ratings)
      await ctx.cache.set(key, cached, CACHE_TTL_MS.images);

    let chosen: { candidate: ImageCandidate; path: string; width: number; height: number } | null =
      null;
    for (const r of order.slice(0, 3)) {
      try {
        const file = await ops.download(
          r.candidate,
          `scene-${String(sceneIndex + 1).padStart(2, '0')}.jpg`,
          { signal: ctx.signal },
        );
        chosen = { candidate: r.candidate, ...file };
        break;
      } catch (error) {
        ctx.log({
          stage: 'images',
          message: `Download failed for ${r.candidate.id}`,
          data: { error: String(error) },
        });
      }
    }

    if (chosen) {
      used.add(chosen.candidate.id);
      const analysis = await ops.analyze(chosen.path).catch(() => null);
      scenes.push({
        visual: {
          type: 'image',
          src: chosen.path,
          width: chosen.width,
          height: chosen.height,
          credit: creditFor(chosen.candidate),
          ...(analysis ? { subject: analysis.subject } : {}),
        },
        captionPlacement: captionPlacementFor(input.captionPosition, analysis),
        analysis,
      });
    } else {
      if (order.length > 0) {
        method = 'fallback';
        reason = 'Every chosen image failed to download.';
      }
      scenes.push({
        visual: { type: 'typographic', text: typographicText(scene) },
        captionPlacement: 'bottom',
        analysis: null,
      });
    }
    decisions.push({
      sceneIndex,
      query,
      method: chosen ? method : 'fallback',
      bestScore: best?.scores.score ?? null,
      chosenId: chosen?.candidate.id ?? null,
      reason,
      candidatesConsidered: ranked.length,
    });
  }
  return { scenes, decisions };
};
