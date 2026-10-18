import { loadFontFromInfo } from '@remotion/google-fonts/from-info';
import { measureText } from '@remotion/layout-utils';
import { Underline } from '@remotion/rough-notation';
import {
  contrastRatio,
  deriveMotion,
  groupCaptions,
  msToFrame,
  type CaptionPage,
  type CaptionToken,
  type CompositionProps,
  type VideoConfig,
} from '@vc/config';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useDelayRender, useVideoConfig } from 'remotion';
import { cardEntersAfterPause, chooseCaptionLayout, LINE_HEIGHT } from './caption-layout';
import { CAPTION_OVERFLOW_TAG } from './constants';
import { captionBox, letterboxBarHeight } from './layout';

const FALLBACK_STACK = 'Inter, "Helvetica Neue", Arial, sans-serif';

type FontInfo = Parameters<typeof loadFontFromInfo>[0];

/** Loads the caption Google Font from the plan's FontInfo; holds the render until it is ready. */
const useCaptionFont = (
  info: Record<string, unknown> | null,
  weight: number,
): { family: string; ready: boolean } => {
  const { delayRender, continueRender } = useDelayRender();
  const key = info ? `${String(info.importName)}:${weight}` : 'fallback';
  const [loadedKey, setLoadedKey] = useState<string | null>(info ? null : 'fallback');
  const handle = useRef<number | null>(null);
  const family = useMemo(() => {
    if (!info) return FALLBACK_STACK;
    try {
      return `"${loadFontFromInfo(info as FontInfo, 'normal', { weights: [String(weight)], subsets: ['latin'], ignoreTooManyRequestsWarning: true }).fontFamily}", ${FALLBACK_STACK}`;
    } catch {
      return FALLBACK_STACK;
    }
  }, [info, weight]);

  useLayoutEffect(() => {
    if (!info) return;
    const h = delayRender(`Loading caption font ${key}`);
    handle.current = h;
    let cancelled = false;
    const done = () => {
      if (!cancelled) setLoadedKey(key);
    };
    try {
      loadFontFromInfo(info as FontInfo, 'normal', {
        weights: [String(weight)],
        subsets: ['latin'],
        ignoreTooManyRequestsWarning: true,
      })
        .waitUntilDone()
        .then(done, done);
    } catch {
      done();
    }
    return () => {
      cancelled = true;
      if (handle.current === h) {
        continueRender(h);
        handle.current = null;
      }
    };
  }, [key, info, weight, delayRender, continueRender]);

  // Release the render only after the re-render with the loaded font has committed.
  useLayoutEffect(() => {
    if (loadedKey === key && handle.current !== null) {
      continueRender(handle.current);
      handle.current = null;
    }
  }, [loadedKey, key, continueRender]);

  return { family, ready: loadedKey === key };
};

const reported = new Set<string>();

const highlightStyle = (config: VideoConfig, active: boolean): React.CSSProperties => {
  if (!active) return {};
  const { highlightAnimation, highlightColor } = config.captions;
  switch (highlightAnimation) {
    case 'colour':
      return { color: highlightColor };
    case 'scale':
      return { color: highlightColor, display: 'inline-block', transform: 'scale(1.12)' };
    case 'box':
      return {
        backgroundColor: highlightColor,
        color:
          contrastRatio('#000000', highlightColor) >= contrastRatio('#FFFFFF', highlightColor)
            ? '#000000'
            : '#FFFFFF',
        WebkitTextStroke: '0px transparent',
        borderRadius: '0.15em',
        padding: '0 0.12em',
      };
    case 'underline':
      return {};
  }
};

const Token: React.FC<{
  token: CaptionToken;
  config: VideoConfig;
  ms: number;
  frame: number;
  fps: number;
  style: VideoConfig['simple']['captionStyle'];
}> = ({ token, config, ms, frame, fps, style }) => {
  const active = ms >= token.fromMs && ms < token.toMs;
  const upcoming = ms < token.fromMs;
  const { captionSpring } = deriveMotion(config, fps);
  const enter = spring({ frame: frame - msToFrame(token.fromMs, fps), fps, config: captionSpring });
  const kinetic = style === 'kinetic-words';
  const text = token.text.trim();
  const base: React.CSSProperties = kinetic
    ? {
        display: 'inline-block',
        opacity: upcoming ? 0 : enter,
        transform: `translateY(${(1 - enter) * 0.3}em) scale(${0.85 + 0.15 * enter})`,
      }
    : { display: 'inline-block' };
  const underline =
    active &&
    (style === 'underline-highlight' || config.captions.highlightAnimation === 'underline');
  const content = <span style={{ ...base, ...highlightStyle(config, active) }}>{text}</span>;
  return underline ? (
    <Underline
      progress={Math.min(1, enter)}
      color={config.captions.highlightColor}
      strokeWidth={3}
      seed={Math.round(token.fromMs)}
    >
      {content}
    </Underline>
  ) : (
    content
  );
};

/** Burned-in captions: pages from createTikTokStyleCaptions, sized with layout-utils so nothing overflows. */
export const Captions: React.FC<CompositionProps> = ({ config, plan }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { captions, simple, backdrop } = config;
  const font = useCaptionFont(plan.fonts.caption, captions.fontWeight);
  const pages = useMemo(() => groupCaptions(plan.words, captions), [plan.words, captions]);
  const ms = (frame / fps) * 1000;
  const pageIndex = pages.findIndex((p) => ms >= p.startMs && ms < p.startMs + p.durationMs);
  const page: CaptionPage | undefined = pages[pageIndex];
  const scene = page
    ? (plan.scenes.find((s) => page.startMs >= s.startMs && page.startMs < s.endMs) ??
      plan.scenes.at(-1))
    : undefined;
  const letterbox = backdrop.letterbox.enabled
    ? letterboxBarHeight(width, height, backdrop.letterbox.ratio)
    : 0;
  const mode =
    scene?.visual.type === 'typographic' && backdrop.imageFit !== 'card'
      ? 'cover'
      : backdrop.imageFit;
  const box = captionBox({
    width,
    height,
    placement: scene?.captionPlacement ?? 'bottom',
    mode,
    letterbox,
  });

  const layout = useMemo(() => {
    if (!page) return null;
    const cache = new Map<string, number>();
    const width100 = (text: string) => {
      let w = cache.get(text);
      if (w === undefined) {
        try {
          w = measureText({
            text,
            fontFamily: font.family,
            fontSize: 100,
            fontWeight: captions.fontWeight,
            validateFontIsLoaded: false,
          }).width;
        } catch {
          w = text.length * 55;
        }
        cache.set(text, w);
      }
      return w;
    };
    return chooseCaptionLayout({
      page,
      width100,
      box: { width: box.width, height: box.height },
      maxCharsPerLine: captions.maxCharsPerLine,
      maxLines: captions.maxLines,
      fitMode: captions.fitMode,
      maxSize: captions.fontSize,
      minSize: captions.minFontSize,
    });
    // font.ready re-measures once the real font has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, font.family, font.ready, captions, box.width, box.height]);

  if (simple.captionStyle === 'off' || !captions.burnIn || !page || !layout) return null;
  if (layout.overflowPx > 0 && font.ready) {
    const id = `${page.startMs}:${page.text}`;
    if (!reported.has(id)) {
      reported.add(id);
      console.log(
        `${CAPTION_OVERFLOW_TAG}${JSON.stringify({ pageText: page.text, fontSize: layout.fontSize, overflowPx: layout.overflowPx })}`,
      );
    }
  }

  const { captionSpring } = deriveMotion(config, fps);
  const cardEnter = cardEntersAfterPause(pages, pageIndex)
    ? spring({ frame: frame - msToFrame(page.startMs, fps), fps, config: captionSpring })
    : 1;
  const card = simple.captionStyle === 'phrase-cards';
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
          display: 'flex',
          alignItems:
            box.y > height / 2 ? 'flex-end' : box.y < height / 3 ? 'flex-start' : 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            fontFamily: font.family,
            fontWeight: captions.fontWeight,
            fontSize: layout.fontSize,
            lineHeight: LINE_HEIGHT,
            color: captions.textColor,
            textAlign: 'center',
            WebkitTextStroke:
              captions.outlineWidth > 0
                ? `${captions.outlineWidth}px ${captions.outlineColor}`
                : undefined,
            paintOrder: 'stroke fill',
            ...(card
              ? {
                  backgroundColor: 'rgba(0, 0, 0, 0.55)',
                  borderRadius: layout.fontSize * 0.35,
                  padding: `${layout.fontSize * 0.2}px ${layout.fontSize * 0.45}px`,
                  opacity: cardEnter,
                  transform: `translateY(${(1 - cardEnter) * 20}px)`,
                }
              : {}),
          }}
        >
          {layout.lines.map((line, i) => (
            <div key={i} style={{ whiteSpace: 'nowrap' }}>
              {line.map((token, j) => (
                <React.Fragment key={`${token.fromMs}-${j}`}>
                  {j > 0 ? ' ' : null}
                  <Token
                    token={token}
                    config={config}
                    ms={ms}
                    frame={frame}
                    fps={fps}
                    style={simple.captionStyle}
                  />
                </React.Fragment>
              ))}
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
