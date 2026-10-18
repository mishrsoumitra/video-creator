import {
  imageMoveForScene,
  type BackdropConfig,
  type LetterboxRatio,
  type VideoConfig,
  type WordTiming,
} from '@vc/config';

/** Share of the frame height kept for captions below an image card. */
export const CAPTION_BAND = 0.22;

const RATIO: Record<LetterboxRatio, number> = { '2.39:1': 2.39, '2:1': 2, '1.85:1': 1.85 };

export const letterboxBarHeight = (
  width: number,
  height: number,
  ratio: LetterboxRatio,
): number => {
  const pictureHeight = width / RATIO[ratio];
  return pictureHeight >= height ? 0 : Math.round((height - pictureHeight) / 2);
};

export type Rect = { x: number; y: number; width: number; height: number };

/** The image card: centred horizontally, above the caption band, inside the margins. */
export const cardRect = ({
  width,
  height,
  margin,
  captionBand,
}: {
  width: number;
  height: number;
  margin: number;
  captionBand: number;
}): Rect => {
  const pad = Math.round(Math.min(width, height) * margin);
  const available = {
    width: width - 2 * pad,
    height: Math.round(height * (1 - captionBand)) - 2 * pad,
  };
  return {
    x: pad,
    y: pad,
    width: Math.max(1, available.width),
    height: Math.max(1, available.height),
  };
};

/** Where the caption block sits, in frame pixels. */
export const captionBox = ({
  width,
  height,
  placement,
  mode,
  letterbox,
}: {
  width: number;
  height: number;
  placement: 'top' | 'middle' | 'bottom';
  mode: BackdropConfig['imageFit'];
  letterbox: number;
}): Rect => {
  const sidePad = Math.round(width * 0.08);
  const boxWidth = width - 2 * sidePad;
  if (mode === 'card') {
    const top = Math.round(height * (1 - CAPTION_BAND));
    const bottom = height - Math.max(letterbox, Math.round(height * 0.03));
    return { x: sidePad, y: top, width: boxWidth, height: Math.max(1, bottom - top) };
  }
  const safeTop = Math.max(letterbox, Math.round(height * 0.06));
  const safeBottom = height - Math.max(letterbox, Math.round(height * 0.06));
  const boxHeight = Math.round((safeBottom - safeTop) * 0.28);
  const y =
    placement === 'top'
      ? safeTop
      : placement === 'middle'
        ? Math.round((safeTop + safeBottom - boxHeight) / 2)
        : safeBottom - boxHeight;
  return { x: sidePad, y, width: boxWidth, height: boxHeight };
};

export type Interval = { startMs: number; endMs: number };

export const speakingIntervals = (words: readonly WordTiming[], mergeGapMs = 250): Interval[] => {
  const out: Interval[] = [];
  for (const w of words) {
    const last = out.at(-1);
    if (last && w.startMs - last.endMs <= mergeGapMs) last.endMs = Math.max(last.endMs, w.endMs);
    else out.push({ startMs: w.startMs, endMs: w.endMs });
  }
  return out;
};

/**
 * Preview-only music volume with ducking, so the browser preview sounds like the final mix (which
 * ffmpeg makes with a sidechain compressor). Linear attack and release ramps in dB.
 */
export const duckedMusicVolume = (
  ms: number,
  intervals: readonly Interval[],
  musicVolume: number,
  ducking: { enabled: boolean; depthDb: number; attackMs: number; releaseMs: number },
): number => {
  if (!ducking.enabled || ducking.depthDb === 0) return musicVolume;
  let reduction = 0;
  for (const { startMs, endMs } of intervals) {
    if (ms < startMs - ducking.attackMs || ms > endMs + ducking.releaseMs) continue;
    let r: number;
    if (ms < startMs) r = (ms - (startMs - ducking.attackMs)) / ducking.attackMs;
    else if (ms <= endMs) r = 1;
    else r = 1 - (ms - endMs) / ducking.releaseMs;
    reduction = Math.max(reduction, Math.min(1, Math.max(0, r)));
  }
  return musicVolume * 10 ** ((-ducking.depthDb * reduction) / 20);
};

/** Camera motion blur for a scene, or null: only moving images are blurred, since every sample re-renders the frame. */
export const motionBlurFor = (
  config: VideoConfig,
  sceneIndex: number,
): { samples: number; shutterAngle: number } | null => {
  const { enabled, samples, shutterAngle } = config.motion.motionBlur;
  return enabled && imageMoveForScene(config, sceneIndex) !== 'none'
    ? { samples, shutterAngle }
    : null;
};
