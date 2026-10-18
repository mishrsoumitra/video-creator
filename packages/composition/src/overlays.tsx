import { LightLeak } from '@remotion/light-leaks';
import { noise3D } from '@remotion/noise';
import type { LetterboxRatio, TimelineOverlay, VideoConfig } from '@vc/config';
import React, { useLayoutEffect, useRef } from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { letterboxBarHeight } from './layout';

/** Film light leaks centred on scene cuts. */
export const LightLeaks: React.FC<{
  overlays: readonly TimelineOverlay[];
  config: VideoConfig;
}> = ({ overlays, config }) => {
  const { lightLeaks } = config.backdrop;
  if (!lightLeaks.enabled) return null;
  return (
    <>
      {overlays.map((o) => (
        <Sequence
          key={`leak-${o.atCut}`}
          from={o.from}
          durationInFrames={o.durationInFrames}
          name="Light leak"
        >
          <AbsoluteFill style={{ opacity: lightLeaks.intensity, mixBlendMode: 'screen' }}>
            <LightLeak seed={lightLeaks.seed + o.atCut} hueShift={lightLeaks.hueShift} />
          </AbsoluteFill>
        </Sequence>
      ))}
    </>
  );
};

export const Vignette: React.FC<{ amount: number; radius: number; feather: number }> = ({
  amount,
  radius,
  feather,
}) => {
  const inner = Math.round(radius * 100);
  const outer = Math.min(150, Math.round((radius + feather) * 100));
  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        background: `radial-gradient(ellipse at center, rgba(0,0,0,0) ${inner}%, rgba(0,0,0,${amount}) ${outer}%)`,
      }}
    />
  );
};

const TILE = 192;

/** Subtle film grain from @remotion/noise: a noise tile redrawn per frame, repeated across the frame. */
export const Grain: React.FC<{
  amount: number;
  size: number;
  animated: boolean;
  speed: number;
}> = ({ amount, size, animated, speed }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const canvas = useRef<HTMLCanvasElement>(null);
  const tileCanvas = useRef<HTMLCanvasElement | null>(null);
  const z = animated ? frame * 0.73 * speed : 0;

  useLayoutEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const tileEl = (tileCanvas.current ??= document.createElement('canvas'));
    tileEl.width = TILE;
    tileEl.height = TILE;
    const tctx = tileEl.getContext('2d');
    const ctx = target.getContext('2d');
    if (!tctx || !ctx) return;
    const img = tctx.createImageData(TILE, TILE);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const v = 128 + noise3D('grain', x * 0.9, y * 0.9, z) * 127;
        const i = (y * TILE + x) * 4;
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    tctx.putImageData(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.scale(size, size);
    const pattern = ctx.createPattern(tileEl, 'repeat');
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, target.width / size, target.height / size);
    }
  }, [z, size, width, height]);

  return (
    <canvas
      ref={canvas}
      width={width}
      height={height}
      style={{
        position: 'absolute',
        inset: 0,
        width,
        height,
        opacity: amount,
        mixBlendMode: 'overlay',
        pointerEvents: 'none',
      }}
    />
  );
};

export const Letterbox: React.FC<{ ratio: LetterboxRatio }> = ({ ratio }) => {
  const { width, height } = useVideoConfig();
  const bar = letterboxBarHeight(width, height, ratio);
  if (bar === 0) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: bar,
          backgroundColor: '#000',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: bar,
          backgroundColor: '#000',
        }}
      />
    </AbsoluteFill>
  );
};
