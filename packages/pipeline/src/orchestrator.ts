import {
  ScenePlanSchema,
  containerFor,
  groupCaptions,
  toSrt,
  type ScenePlan,
  type VideoConfig,
} from '@vc/config';
import { runFinalChecks, type CaptionOverflow, type Check, type ClippingReport } from './checks';
import { PipelineError, type MediaOps, type StageContext } from './context';
import { buildCredits, type Credits, type MusicCredit } from './credits';
import { runImages, type ImageDecision, type ImageOps, type SceneText } from './images';
import type { Stage } from './ledger';
import { runResearch, type FactSheet, type ResearchResult } from './research';
import type { ProviderSet, VisionImage, VisionProvider } from './roles';
import { runScript, type Script } from './script';
import type { ImageSource, PageFetcher } from './services';
import { runTiming, runVoice, type TimingResult, type VoiceResult } from './voice';

const step = async <T>(ctx: StageContext, stage: Stage, fn: () => Promise<T>): Promise<T> => {
  ctx.onStage?.(stage, 'running');
  try {
    const result = await fn();
    ctx.onStage?.(stage, 'done');
    return result;
  } catch (error) {
    ctx.onStage?.(stage, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
};

export type PrepareInput = {
  topic: string;
  lengthSeconds: number;
  config: VideoConfig;
  sourceText?: string | undefined;
  recordingPath?: string | undefined;
};

export type PrepareDeps = {
  providers: ProviderSet;
  fetcher: PageFetcher;
  imageSource: ImageSource;
  imageOps: ImageOps;
  media: MediaOps;
  /** Vision ranking on every scene (Settings). */
  visionAlways: boolean;
  /** URL the Player and the renderer load a local file from. */
  assetUrl(path: string): string;
  /** @remotion/google-fonts FontInfo for the caption font, or null. */
  fontInfo(family: string): Promise<Record<string, unknown> | null>;
  /** Local path of the music bed for this config and length, or null. */
  musicPath(config: VideoConfig, durationMs: number): Promise<string | null>;
};

export type PrepareResult = {
  plan: ScenePlan;
  factSheet: FactSheet;
  droppedFacts: ResearchResult['droppedFacts'];
  script: Script;
  voice: VoiceResult;
  timing: TimingResult;
  images: ImageDecision[];
  srt: string;
  warnings: string[];
};

/**
 * Everything up to the review screen: research → script → voice → word timing → scene timing →
 * images → captions → plan. The plan is what @remotion/player previews and the renderer renders.
 */
export const prepareJob = async (
  ctx: StageContext,
  input: PrepareInput,
  deps: PrepareDeps,
): Promise<PrepareResult> => {
  const { config } = input;
  const { providers } = deps;

  const research = await step(ctx, 'research', () =>
    runResearch(ctx, {
      topic: input.topic,
      lengthSeconds: input.lengthSeconds,
      sourceText: input.sourceText,
      search: providers.search,
      text: providers.text,
      fetcher: deps.fetcher,
    }),
  );
  const { script, warnings: scriptWarnings } = await step(ctx, 'script', () =>
    runScript(ctx, {
      topic: input.topic,
      lengthSeconds: input.lengthSeconds,
      animationKind: config.simple.animationKind,
      factSheet: research.factSheet,
      text: providers.text,
    }),
  );
  const voice = await step(ctx, 'voice', () =>
    runVoice(ctx, {
      script,
      recordingPath: input.recordingPath,
      voice: providers.voice,
      media: deps.media,
    }),
  );
  const playbackRate = config.audio.unlockPlaybackRate ? config.audio.narrationPlaybackRate : 1;
  const timing = await step(ctx, 'timing', () =>
    runTiming(ctx, { script, voice, align: providers.align, playbackRate, media: deps.media }),
  );

  const spanScenes: SceneText[] = timing.spans.map((span) => {
    const parts = span.sceneIndexes.map((i) => script.scenes[i]!);
    return {
      narration: parts.map((p) => p.narration).join(' '),
      imageQuery: parts[0]!.imageQuery,
      keywords: [...new Set(parts.flatMap((p) => p.keywords))],
    };
  });
  const images = await step(ctx, 'images', () =>
    runImages(ctx, {
      scenes: spanScenes,
      aspect: config.simple.aspect,
      captionPosition: config.captions.position,
      source: deps.imageSource,
      ops: deps.imageOps,
      vision: providers.vision,
      visionAlways: deps.visionAlways,
    }),
  );

  const plan = await step(ctx, 'captions', async () => {
    const firstImage = images.scenes.find((s) => s.visual.type === 'image');
    const palette =
      config.backdrop.palette.source === 'image' && firstImage?.visual.type === 'image'
        ? await deps.imageOps.palette(firstImage.visual.src).catch(() => null)
        : null;
    const music = await deps.musicPath(config, timing.durationMs);
    const candidate = {
      version: 1 as const,
      title: script.title,
      durationMs: timing.durationMs,
      scenes: timing.spans.map((span, i) => {
        const sv = images.scenes[i]!;
        return {
          id: `s${i + 1}`,
          startMs: span.startMs,
          endMs: span.endMs,
          narration: spanScenes[i]!.narration,
          visual:
            sv.visual.type === 'image'
              ? { ...sv.visual, src: deps.assetUrl(sv.visual.src) }
              : sv.visual,
          captionPlacement: sv.captionPlacement,
        };
      }),
      words: timing.words.map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs })),
      audio: {
        narrationSrc: deps.assetUrl(voice.audioPath),
        musicSrc: music ? deps.assetUrl(music) : null,
      },
      palette,
      fonts: { caption: await deps.fontInfo(config.captions.fontFamily) },
    };
    const parsed = ScenePlanSchema.safeParse(candidate);
    if (!parsed.success)
      throw new PipelineError(
        'captions',
        `The scene plan is invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`,
      );
    return parsed.data;
  });

  const srt = toSrt(groupCaptions(plan.words, config.captions));
  await ctx.files.write('plan.json', JSON.stringify(plan, null, 2));
  await ctx.files.write('captions.srt', srt);
  await ctx.files.write('factsheet.json', JSON.stringify(research.factSheet, null, 2));
  await ctx.files.write('script.json', JSON.stringify(script, null, 2));

  const fallbacks = images.decisions.filter((d) => d.method === 'fallback').length;
  const warnings = [
    ...scriptWarnings,
    ...timing.warnings,
    ...(script.truncated
      ? [
          `The script came back over budget twice and was cut at a sentence boundary to ${script.wordCount} words.`,
        ]
      : []),
    ...(research.droppedFacts.length > 0
      ? [
          `${research.droppedFacts.length} fact(s) were dropped because their quotes were not found in the sources.`,
        ]
      : []),
    ...(fallbacks > 0
      ? [`${fallbacks} scene(s) use a typographic card because no image passed.`]
      : []),
  ];
  return {
    plan,
    factSheet: research.factSheet,
    droppedFacts: research.droppedFacts,
    script,
    voice,
    timing,
    images: images.decisions,
    srt,
    warnings,
  };
};

export type FinalizeInput = {
  plan: ScenePlan;
  config: VideoConfig;
  requestedLengthSeconds: number;
  factSheet: FactSheet | null;
  /** A rerun of a finished job with only style changes: no AI at all. */
  isStyleRerun: boolean;
  narrationPath: string;
  musicPath: string | null;
  music: MusicCredit;
};

export type FinalizeDeps = {
  /** Remotion render of the muted video. */
  render(args: {
    plan: ScenePlan;
    config: VideoConfig;
    outputPath: string;
    signal?: AbortSignal;
  }): Promise<{ elapsedMs: number; captionOverflows: CaptionOverflow[] }>;
  mixAudio(args: {
    narrationPath: string;
    musicPath: string | null;
    audio: VideoConfig['audio'];
    outputPath: string;
  }): Promise<{ integratedLufs: number; truePeakDb: number }>;
  mux(args: {
    videoPath: string;
    audioPath: string;
    outputPath: string;
    container: 'mp4' | 'webm' | 'mov';
  }): Promise<void>;
  probeDurationMs(path: string): Promise<number>;
  measureClipping(path: string): Promise<ClippingReport>;
  contactSheet(videoPath: string, outputPath: string): Promise<VisionImage>;
  vision: VisionProvider | null;
  visionFinalCheck: boolean;
};

export type FinalizeResult = {
  videoPath: string;
  srtPath: string;
  creditsPath: string;
  credits: Credits;
  checks: Check[];
  passed: boolean;
  renderElapsedMs: number;
  audio: { integratedLufs: number; truePeakDb: number };
};

/** The final render goes through the queue: render → stitch/mix/mux → credits → final checks. No AI in the render path. */
export const finalizeJob = async (
  ctx: StageContext,
  input: FinalizeInput,
  deps: FinalizeDeps,
): Promise<FinalizeResult> => {
  const { plan, config } = input;
  const container = containerFor(config.output.codec);
  const renderPath = ctx.files.pathFor(`render.${container}`);

  const render = await step(ctx, 'render', async () => {
    try {
      return await deps.render({ plan, config, outputPath: renderPath, signal: ctx.signal });
    } catch (error) {
      throw new PipelineError(
        'render',
        `Rendering failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });

  const mixPath = ctx.files.pathFor('mix.wav');
  const videoPath = ctx.files.pathFor(`video.${container}`);
  const audio = await step(ctx, 'stitch', async () => {
    const report = await deps.mixAudio({
      narrationPath: input.narrationPath,
      musicPath: input.musicPath,
      audio: config.audio,
      outputPath: mixPath,
    });
    await deps.mux({ videoPath: renderPath, audioPath: mixPath, outputPath: videoPath, container });
    return report;
  });

  const { credits, creditsPath, srtPath } = await step(ctx, 'credits', async () => {
    const c = buildCredits({ scenes: plan.scenes, factSheet: input.factSheet, music: input.music });
    return {
      credits: c,
      creditsPath: await ctx.files.write('credits.txt', c.text),
      // The .srt is always written, whatever the caption style or burn-in setting.
      srtPath: await ctx.files.write(
        'captions.srt',
        toSrt(groupCaptions(plan.words, config.captions)),
      ),
    };
  });

  const result = await step(ctx, 'checks', async () =>
    runFinalChecks(ctx, {
      plan,
      fps: config.output.fps,
      renderedDurationMs: await deps.probeDurationMs(videoPath),
      requestedLengthSeconds: input.requestedLengthSeconds,
      captionOverflows: render.captionOverflows,
      clipping: await deps.measureClipping(mixPath),
      vision: deps.vision,
      visionFinalCheck: deps.visionFinalCheck,
      isStyleRerun: input.isStyleRerun,
      contactSheet: () => deps.contactSheet(videoPath, ctx.files.pathFor('contact-sheet.png')),
    }),
  );

  return {
    videoPath,
    srtPath,
    creditsPath,
    credits,
    checks: result.checks,
    passed: result.passed,
    renderElapsedMs: render.elapsedMs,
    audio,
  };
};
