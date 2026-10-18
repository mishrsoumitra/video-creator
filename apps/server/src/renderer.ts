import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundle } from '@remotion/bundler';
import {
  ensureBrowser,
  makeCancelSignal,
  renderMedia,
  selectComposition,
} from '@remotion/renderer';
import { CAPTION_OVERFLOW_TAG, COMPOSITION_ID } from '@vc/composition/constants';
import type { VideoConfig } from '@vc/config';
import type { CaptionOverflow } from '@vc/pipeline';
import { renderOptionsFor } from './render-options';
import type { Calibrator, Renderer } from './services';

export type RemotionOptions = {
  /** A prebuilt `remotion bundle` folder (production). Without it the entry is bundled on first use. */
  bundleDir: string | null;
  entryPoint: string;
  publicDir: string;
};

/** Renders the composition with Remotion. Muted: ffmpeg mixes and muxes the audio afterwards. */
export const createRemotionRenderer = (
  options: RemotionOptions,
): Renderer & Calibrator & { warm(): Promise<string> } => {
  let serveUrl: Promise<string> | null = null;
  const getServeUrl = () =>
    (serveUrl ??= (async () => {
      await ensureBrowser();
      return (
        options.bundleDir ??
        bundle({ entryPoint: options.entryPoint, publicDir: options.publicDir })
      );
    })().catch((error: unknown) => {
      serveUrl = null;
      throw error;
    }));

  const renderOnce = async (args: {
    inputProps: Record<string, unknown>;
    config: VideoConfig;
    outputPath: string;
    signal?: AbortSignal;
    onProgress?: (progress: number) => void;
    frameRange?: [number, number];
  }) => {
    const url = await getServeUrl();
    const composition = await selectComposition({
      serveUrl: url,
      id: COMPOSITION_ID,
      inputProps: args.inputProps,
    });
    const { cancelSignal, cancel } = makeCancelSignal();
    args.signal?.addEventListener('abort', () => cancel(), { once: true });
    const overflows = new Map<string, CaptionOverflow>();
    const started = performance.now();
    await renderMedia({
      serveUrl: url,
      composition,
      inputProps: args.inputProps,
      outputLocation: args.outputPath,
      ...renderOptionsFor(args.config),
      cancelSignal,
      ...(args.frameRange ? { frameRange: args.frameRange } : {}),
      onProgress: ({ progress }) => args.onProgress?.(progress),
      onBrowserLog: (log) => {
        if (!log.text.startsWith(CAPTION_OVERFLOW_TAG)) return;
        try {
          const o = JSON.parse(log.text.slice(CAPTION_OVERFLOW_TAG.length)) as CaptionOverflow;
          overflows.set(`${o.pageText}:${o.fontSize}`, o);
        } catch {
          // not ours
        }
      },
      logLevel: 'error',
    });
    return { elapsedMs: performance.now() - started, captionOverflows: [...overflows.values()] };
  };

  return {
    warm: getServeUrl,
    render: ({ plan, config, outputPath, signal, onProgress }) =>
      renderOnce({
        inputProps: { config, plan },
        config,
        outputPath,
        ...(signal ? { signal } : {}),
        ...(onProgress ? { onProgress } : {}),
      }),
    /** Short renders of the demo plan with one feature switched on at a time. */
    async run(onSample, signal) {
      const { calibrationConfigs } = await import('./calibrate');
      const dir = await mkdtemp(join(tmpdir(), 'vc-calibrate-'));
      try {
        for (const config of calibrationConfigs()) {
          if (signal?.aborted) return;
          const fps = config.output.fps;
          // 3 s around the first cut of the demo plan (Root defaultProps): two scenes, one transition.
          const frameRange: [number, number] = [2 * fps, 5 * fps - 1];
          const result = await renderOnce({
            inputProps: { config },
            config,
            outputPath: join(
              dir,
              `sample.${config.output.codec === 'prores' ? 'mov' : config.output.codec.startsWith('vp') ? 'webm' : 'mp4'}`,
            ),
            frameRange,
            ...(signal ? { signal } : {}),
          });
          onSample(config, 3000, 2, result.elapsedMs);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
};
