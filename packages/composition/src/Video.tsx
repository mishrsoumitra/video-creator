import { TransitionSeries } from '@remotion/transitions';
import { buildTimeline, type CompositionProps } from '@vc/config';
import React, { useMemo } from 'react';
import { AbsoluteFill, isHtmlInCanvasSupported, useVideoConfig } from 'remotion';
import { PreviewAudio } from './audio';
import { Captions } from './captions';
import { Grain, Letterbox, LightLeaks, Vignette } from './overlays';
import { buildPresentation, buildTiming } from './presentations';
import { SceneView } from './scenes';

/** The one composition. Everything about its look comes from `config`; everything it shows comes from `plan`. */
export const VideoComposition: React.FC<CompositionProps> = ({ config, plan }) => {
  const { fps, width, height } = useVideoConfig();
  const timeline = useMemo(
    () => buildTimeline({ scenes: plan.scenes, durationMs: plan.durationMs, fps, config }),
    [plan.scenes, plan.durationMs, fps, config],
  );
  const palette = useMemo(
    () =>
      config.backdrop.palette.source === 'image' && plan.palette
        ? plan.palette
        : config.backdrop.palette.colors,
    [config.backdrop.palette, plan.palette],
  );
  const htmlInCanvas = isHtmlInCanvasSupported();
  const transitionAfter = useMemo(
    () => new Map(timeline.transitions.map((t) => [t.afterScene, t])),
    [timeline.transitions],
  );

  return (
    <AbsoluteFill style={{ backgroundColor: palette[0] }}>
      <TransitionSeries>
        {timeline.sequences.flatMap((seq, i) => {
          const slot = timeline.scenes[i]!;
          const scene = plan.scenes[slot.sceneIndexes[0]!]!;
          const items: React.ReactNode[] = [
            <TransitionSeries.Sequence
              key={`scene-${scene.id}`}
              durationInFrames={seq.durationInFrames}
              name={`Scene ${i + 1}`}
            >
              <SceneView
                scene={scene}
                slotIndex={i}
                sequenceFrames={seq.durationInFrames}
                config={config}
                palette={palette}
              />
            </TransitionSeries.Sequence>,
          ];
          const t = transitionAfter.get(i);
          if (t) {
            items.push(
              <TransitionSeries.Transition
                key={`cut-${scene.id}`}
                presentation={buildPresentation({
                  name: t.name,
                  direction: t.direction,
                  width,
                  height,
                  htmlInCanvasSupported: htmlInCanvas,
                })}
                timing={buildTiming({
                  kind: t.timing,
                  durationInFrames: t.durationInFrames,
                  config,
                })}
              />,
            );
          }
          return items;
        })}
      </TransitionSeries>
      <LightLeaks overlays={timeline.overlays} config={config} />
      {config.backdrop.vignette.enabled ? <Vignette {...config.backdrop.vignette} /> : null}
      {config.backdrop.grain.enabled ? (
        <Grain {...config.backdrop.grain} speed={config.simple.animationSpeed} />
      ) : null}
      <Captions config={config} plan={plan} />
      {config.backdrop.letterbox.enabled ? (
        <Letterbox ratio={config.backdrop.letterbox.ratio} />
      ) : null}
      <PreviewAudio config={config} plan={plan} />
    </AbsoluteFill>
  );
};
