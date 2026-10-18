import { BASE_DIMENSIONS, type ScenePlan, type VideoConfig } from '@vc/config';

export { COMPOSITION_ID } from './constants';

/**
 * Frame size from the aspect (always the 1080p layout; Remotion's `scale` makes 720p and 4K), fps
 * from the output settings, and length from the narration.
 */
export const calculateVideoMetadata = ({
  config,
  plan,
}: {
  config: VideoConfig;
  plan: Pick<ScenePlan, 'durationMs'>;
}) => {
  const { width, height } = BASE_DIMENSIONS[config.simple.aspect];
  const fps = config.output.fps;
  return {
    fps,
    width,
    height,
    durationInFrames: Math.max(1, Math.ceil((plan.durationMs * fps) / 1000 - 1e-9)),
  };
};
