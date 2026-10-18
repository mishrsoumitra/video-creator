import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import {
  BACKDROP_KINDS,
  SCHEMA_DEFAULTS,
  applyBackdropKind,
  initialConfig,
  mergeConfig,
  type TransitionName,
  type VideoConfig,
} from '@vc/config';
import { probeMedia } from '@vc/media';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPTION_OVERFLOW_TAG } from './constants';
import { COMPOSITION_ID } from './metadata';

/*
 * Real Remotion renders of the composition (headless Chrome). Slow: run with `npm run test:render`.
 * The demo plan (Root defaultProps) supplies the scenes and assets; tests vary only the config.
 */

const root = new URL('..', import.meta.url).pathname;
let serveUrl: string;
let out: string;

beforeAll(async () => {
  await ensureBrowser();
  serveUrl = await bundle({
    entryPoint: join(root, 'src/entry.ts'),
    publicDir: join(root, 'public'),
  });
  out = await mkdtemp(join(tmpdir(), 'vc-render-'));
});

afterAll(async () => {
  if (out) await rm(out, { recursive: true, force: true });
});

const compositionFor = (config: VideoConfig) =>
  selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps: { config } });

describe('composition renders with Remotion', () => {
  it('renders the demo end to end at the narration length', async () => {
    const config = initialConfig();
    const composition = await compositionFor(config);
    expect(composition).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 360,
    });
    const output = join(out, 'demo.mp4');
    await renderMedia({
      serveUrl,
      composition,
      inputProps: { config },
      codec: 'h264',
      outputLocation: output,
      muted: true,
      scale: 0.25,
      logLevel: 'error',
    });
    const probe = await probeMedia(output);
    expect(probe.durationMs).toBeGreaterThan(11_900);
    expect(probe.durationMs).toBeLessThan(12_100);
    const video = probe.streams.find((s) => s.type === 'video')!;
    expect([video.width, video.height]).toEqual([480, 270]);
  });

  it.each(['9:16', '1:1'] as const)(
    'lays out the %s aspect from the same composition',
    async (aspect) => {
      const config = mergeConfig(initialConfig(), { simple: { aspect } });
      const composition = await compositionFor(config);
      const output = join(out, `aspect-${aspect.replace(':', 'x')}.png`);
      await renderStill({
        serveUrl,
        composition,
        inputProps: { config },
        frame: 45,
        output,
        scale: 0.25,
        logLevel: 'error',
      });
      expect((await stat(output)).size).toBeGreaterThan(1000);
      expect(composition.width / composition.height).toBeCloseTo(aspect === '9:16' ? 9 / 16 : 1, 5);
    },
  );

  it.each(BACKDROP_KINDS)('renders the %s backdrop', async (kind) => {
    const config = applyBackdropKind(initialConfig(), kind);
    const composition = await compositionFor(config);
    const output = join(out, `backdrop-${kind}.png`);
    // Frame 120 shows the typographic scene, where the backdrop is visible.
    await renderStill({
      serveUrl,
      composition,
      inputProps: { config },
      frame: 120,
      output,
      scale: 0.25,
      logLevel: 'error',
    });
    expect((await stat(output)).size).toBeGreaterThan(1000);
  });

  const SHADERS: TransitionName[] = [
    'dissolve',
    'zoom-in-out',
    'cross-zoom',
    'zoom-blur',
    'linear-blur',
    'blur-slide',
    'dreamy-zoom',
    'swap',
    'book-flip',
    'crosswarp',
    'ripple',
    'film-burn',
  ];
  const timings: Record<string, number> = {};

  it.each(SHADERS)(
    'renders the %s shader transition at a cut (HTML-in-canvas is enabled for renders)',
    async (name) => {
      const config = mergeConfig(SCHEMA_DEFAULTS, {
        transitions: { presentations: [name], durationInFrames: 20 },
      });
      const composition = await compositionFor(config);
      const output = join(out, `transition-${name}.png`);
      const t0 = Date.now();
      await renderStill({
        serveUrl,
        composition,
        inputProps: { config },
        frame: 90,
        output,
        scale: 0.25,
        logLevel: 'error',
      });
      timings[name] = Date.now() - t0;
      expect((await stat(output)).size).toBeGreaterThan(1000);
    },
  );

  it('reports caption overflow through the browser log', async () => {
    const config = mergeConfig(initialConfig(), {
      captions: {
        fontSize: 200,
        minFontSize: 200,
        maxCharsPerLine: 80,
        maxLines: 1,
        fitMode: 'shrink',
      },
    });
    const composition = await compositionFor(config);
    const logs: string[] = [];
    await renderStill({
      serveUrl,
      composition,
      inputProps: { config },
      frame: 60,
      output: join(out, 'overflow.png'),
      scale: 0.25,
      logLevel: 'error',
      onBrowserLog: (log) => logs.push(log.text),
    });
    const overflow = logs.find((l) => l.startsWith(CAPTION_OVERFLOW_TAG));
    expect(overflow).toBeDefined();
    expect(JSON.parse(overflow!.slice(CAPTION_OVERFLOW_TAG.length))).toMatchObject({
      fontSize: 200,
    });
  });

  afterAll(() => {
    if (Object.keys(timings).length > 0)
      console.log('shader transition still timings (ms):', timings);
  });
});
