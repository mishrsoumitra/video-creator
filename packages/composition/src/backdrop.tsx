import { checkerboard, gridlines, linearGradient, rings, tile, zigzag } from '@remotion/effects';
import type { VideoConfig } from '@vc/config';
import React, { useMemo } from 'react';
import { AbsoluteFill, Solid, useVideoConfig, type EffectsProp } from 'remotion';

/**
 * Flat palette colour, optional two-colour gradient, and pattern layers drawn with @remotion/effects
 * on <Solid> (2D/WebGL2 canvas, so it works in the browser preview too).
 */
export const Backdrop: React.FC<{ config: VideoConfig; palette: readonly string[] }> = ({
  config,
  palette,
}) => {
  const { width, height } = useVideoConfig();
  const {
    linearGradient: gradient,
    rings: r,
    gridlines: g,
    checkerboard: c,
    zigzag: z,
    tile: t,
  } = config.backdrop;
  const tiling = useMemo<EffectsProp>(
    () => (t.enabled ? [tile({ horizontal: t.horizontal, vertical: t.vertical })] : []),
    [t.enabled, t.horizontal, t.vertical],
  );

  const layers = useMemo(() => {
    const out: Array<{ key: string; opacity: number; effects: EffectsProp }> = [];
    if (gradient.enabled) {
      out.push({
        key: 'gradient',
        opacity: 1,
        effects: [
          linearGradient({
            start: gradient.start,
            end: gradient.end,
            startColor: palette[0],
            endColor: palette[1],
          }),
        ],
      });
    }
    if (r.enabled)
      out.push({
        key: 'rings',
        opacity: r.opacity,
        effects: [
          rings({ colors: [palette[2]!, palette[4]!], thickness: r.thickness, gap: r.gap }),
          ...tiling,
        ],
      });
    if (g.enabled)
      out.push({
        key: 'gridlines',
        opacity: g.opacity,
        effects: [
          gridlines({ gridSize: g.gridSize, lineWidth: g.lineWidth, lineColor: palette[3] }),
          ...tiling,
        ],
      });
    if (c.enabled)
      out.push({
        key: 'checkerboard',
        opacity: c.opacity,
        effects: [
          checkerboard({
            colors: [palette[1]!, palette[2]!],
            cellSize: c.cellSize,
            gap: c.gap,
            angle: c.angle,
          }),
          ...tiling,
        ],
      });
    if (z.enabled)
      out.push({
        key: 'zigzag',
        opacity: z.opacity,
        effects: [
          zigzag({
            colors: [palette[2]!, palette[4]!],
            direction: z.direction,
            thickness: z.thickness,
            gap: z.gap,
          }),
          ...tiling,
        ],
      });
    return out;
  }, [gradient, r, g, c, z, palette, tiling]);

  return (
    <AbsoluteFill style={{ backgroundColor: palette[0] }}>
      {layers.map((layer) => (
        <AbsoluteFill key={layer.key} style={{ opacity: layer.opacity }}>
          <Solid width={width} height={height} color="transparent" effects={layer.effects} />
        </AbsoluteFill>
      ))}
    </AbsoluteFill>
  );
};
