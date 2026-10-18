import { CameraMotionBlur } from '@remotion/motion-blur';
import { Starburst } from '@remotion/starburst';
import { tint } from '@remotion/effects/tint';
import { fitText } from '@remotion/layout-utils';
import { deriveMotion, imageMotionAt, type PlanScene, type VideoConfig } from '@vc/config';
import React, { useMemo } from 'react';
import { AbsoluteFill, Img, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop } from './backdrop';
import { CAPTION_BAND, cardRect, motionBlurFor } from './layout';

type SceneProps = {
  scene: PlanScene;
  /** Index of the timeline slot (drives the image-move cycle). */
  slotIndex: number;
  sequenceFrames: number;
  config: VideoConfig;
  palette: readonly string[];
};

const useImageTransform = (config: VideoConfig, slotIndex: number, sequenceFrames: number) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const m = imageMotionAt(config, {
    sceneIndex: slotIndex,
    frame,
    sceneFrames: sequenceFrames,
    fps,
  });
  return `translate(${(m.translateX * 100).toFixed(4)}%, ${(m.translateY * 100).toFixed(4)}%) scale(${m.scale.toFixed(5)})`;
};

const MovingImage: React.FC<{
  src: string;
  fit: 'cover' | 'contain';
  config: VideoConfig;
  slotIndex: number;
  sequenceFrames: number;
}> = ({ src, fit, config, slotIndex, sequenceFrames }) => {
  const transform = useImageTransform(config, slotIndex, sequenceFrames);
  const effects = useMemo(
    () =>
      config.backdrop.tint.enabled
        ? [tint({ color: config.backdrop.tint.color, amount: config.backdrop.tint.amount })]
        : [],
    [config.backdrop.tint.enabled, config.backdrop.tint.color, config.backdrop.tint.amount],
  );
  const image = (
    <Img
      src={src}
      effects={effects}
      style={{
        width: '100%',
        height: '100%',
        objectFit: fit,
        transform,
        transformOrigin: '50% 50%',
      }}
    />
  );
  const blur = motionBlurFor(config, slotIndex);
  if (!blur) return image;
  return (
    <CameraMotionBlur samples={blur.samples} shutterAngle={blur.shutterAngle}>
      {image}
    </CameraMotionBlur>
  );
};

const ImageScene: React.FC<SceneProps & { src: string }> = ({
  src,
  config,
  palette,
  slotIndex,
  sequenceFrames,
}) => {
  const { width, height } = useVideoConfig();
  const { imageFit, card, blur } = config.backdrop;

  if (imageFit === 'cover') {
    return (
      <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: palette[0] }}>
        <MovingImage
          src={src}
          fit="cover"
          config={config}
          slotIndex={slotIndex}
          sequenceFrames={sequenceFrames}
        />
      </AbsoluteFill>
    );
  }

  if (imageFit === 'contain') {
    return (
      <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: palette[0] }}>
        <AbsoluteFill style={{ transform: 'scale(1.15)' }}>
          <Img
            src={src}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: `blur(${blur.radius}px) brightness(${1 - blur.darken})`,
            }}
          />
        </AbsoluteFill>
        <AbsoluteFill style={{ overflow: 'hidden' }}>
          <MovingImage
            src={src}
            fit="contain"
            config={config}
            slotIndex={slotIndex}
            sequenceFrames={sequenceFrames}
          />
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  const rect = cardRect({ width, height, margin: card.margin, captionBand: CAPTION_BAND });
  return (
    <AbsoluteFill>
      <Backdrop config={config} palette={palette} />
      <div
        style={{
          position: 'absolute',
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          borderRadius: card.radius,
          overflow: 'hidden',
          boxShadow: `0 ${Math.round(height * 0.02)}px ${Math.round(height * 0.06)}px rgba(0, 0, 0, ${card.shadow})`,
          backgroundColor: palette[1],
        }}
      >
        <MovingImage
          src={src}
          fit="cover"
          config={config}
          slotIndex={slotIndex}
          sequenceFrames={sequenceFrames}
        />
      </div>
    </AbsoluteFill>
  );
};

const TypographicScene: React.FC<SceneProps & { text: string }> = ({ text, config, palette }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { captionSpring, speed } = deriveMotion(config, fps);
  const enter = spring({ frame, fps, config: captionSpring });
  const fontFamily = 'Inter, "Helvetica Neue", Arial, sans-serif';
  const maxWidth = width * 0.8;
  const fontSize = useMemo(() => {
    try {
      return Math.min(
        height * 0.12,
        fitText({
          text,
          withinWidth: maxWidth,
          fontFamily,
          fontWeight: 800,
          validateFontIsLoaded: false,
        }).fontSize,
      );
    } catch {
      return height * 0.08;
    }
  }, [text, maxWidth, height]);
  const { starburst } = config.backdrop;
  return (
    <AbsoluteFill>
      <Backdrop config={config} palette={palette} />
      {starburst.enabled ? (
        <AbsoluteFill style={{ opacity: starburst.intensity }}>
          <Starburst
            rays={starburst.rays}
            colors={[palette[2]!, palette[1]!]}
            rotation={(frame / fps) * starburst.rotationPerSecond * speed}
            width={width}
            height={height}
          />
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div
          style={{
            maxWidth,
            textAlign: 'center',
            fontFamily,
            fontWeight: 800,
            fontSize,
            lineHeight: 1.1,
            color: palette[3],
            opacity: enter,
            transform: `scale(${0.92 + 0.08 * enter})`,
          }}
        >
          {text}
          <div
            style={{
              margin: `${Math.round(fontSize * 0.25)}px auto 0`,
              width: `${Math.round(30 * enter)}%`,
              height: Math.max(4, fontSize * 0.06),
              backgroundColor: palette[2],
            }}
          />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const SceneView: React.FC<SceneProps> = (props) =>
  props.scene.visual.type === 'image' ? (
    <ImageScene {...props} src={props.scene.visual.src} />
  ) : (
    <TypographicScene {...props} text={props.scene.visual.text} />
  );
