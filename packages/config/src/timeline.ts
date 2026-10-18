import { deriveMotion } from './derive';
import type { TimingKind, TransitionDirection, TransitionName } from './enums';
import type { VideoConfig } from './schema';
import { resolveTransitionDirection } from './transitions';

/** A transition may use at most this share of the shorter neighbouring scene. */
export const TRANSITION_MAX_SCENE_FRACTION = 0.5;
/** Length of a light-leak overlay at 1× speed. */
export const LIGHT_LEAK_SECONDS = 1.2;

export const msToFrame = (ms: number, fps: number): number => Math.round((ms * fps) / 1000);

export type SceneSpan = { startMs: number; endMs: number };

export type TimelineScene = {
  index: number;
  startFrame: number;
  endFrame: number;
  frames: number;
  /** Plan scenes shown in this slot (several when a scene rounded to zero frames). */
  sceneIndexes: number[];
};

export type TimelineSequence = { sceneIndex: number; from: number; durationInFrames: number };

export type TimelineTransition = {
  afterScene: number;
  /** Frame of the narration cut the transition is centred on. */
  atFrame: number;
  name: TransitionName;
  durationInFrames: number;
  requestedFrames: number;
  clamped: boolean;
  direction: TransitionDirection | null;
  timing: TimingKind;
};

export type TimelineOverlay = {
  kind: 'light-leak';
  atCut: number;
  from: number;
  durationInFrames: number;
};

export type Timeline = {
  fps: number;
  totalFrames: number;
  scenes: TimelineScene[];
  sequences: TimelineSequence[];
  transitions: TimelineTransition[];
  overlays: TimelineOverlay[];
};

const validateScenes = (scenes: readonly SceneSpan[], durationMs: number) => {
  if (scenes.length === 0) throw new Error('A timeline needs at least one scene.');
  if (scenes[0]!.startMs !== 0) throw new Error('The first scene must start at 0 ms.');
  scenes.forEach((scene, i) => {
    if (!(scene.endMs > scene.startMs))
      throw new Error(`Scene ${i} must have a positive duration.`);
    if (i > 0 && scene.startMs !== scenes[i - 1]!.endMs) {
      throw new Error(
        `Scenes must be contiguous: scene ${i} starts at ${scene.startMs} ms, the previous ends at ${scenes[i - 1]!.endMs} ms.`,
      );
    }
  });
  if (scenes.at(-1)!.endMs > durationMs)
    throw new Error('The last scene ends after the narration duration.');
};

/**
 * Turns the voice-fixed scene boundaries into Remotion sequences and transitions. Transitions are
 * centred on each cut, so Σ sequence lengths − Σ transition lengths equals the narration length at
 * every animation speed; the style config can only move inside the boundaries.
 */
export const buildTimeline = ({
  scenes,
  durationMs,
  fps,
  config,
}: {
  scenes: readonly SceneSpan[];
  durationMs: number;
  fps: number;
  config: VideoConfig;
}): Timeline => {
  validateScenes(scenes, durationMs);
  const totalFrames = Math.max(1, Math.ceil((durationMs * fps) / 1000 - 1e-9));

  // Frame slots; a scene that rounds to zero frames joins the next slot (or the previous one at the end).
  const slots: Array<{ startFrame: number; sceneIndexes: number[] }> = [];
  let pending: number[] = [];
  scenes.forEach((scene, i) => {
    const start = i === 0 ? 0 : msToFrame(scene.startMs, fps);
    const end = i + 1 < scenes.length ? msToFrame(scenes[i + 1]!.startMs, fps) : totalFrames;
    if (end <= start) {
      pending.push(i);
      return;
    }
    slots.push({ startFrame: start, sceneIndexes: [...pending, i] });
    pending = [];
  });
  if (pending.length > 0) slots.at(-1)!.sceneIndexes.push(...pending);

  const timelineScenes: TimelineScene[] = slots.map((slot, index) => {
    const endFrame = index + 1 < slots.length ? slots[index + 1]!.startFrame : totalFrames;
    return {
      index,
      startFrame: slot.startFrame,
      endFrame,
      frames: endFrame - slot.startFrame,
      sceneIndexes: slot.sceneIndexes,
    };
  });

  const { transitionFrames, speed } = deriveMotion(config, fps);
  const { presentations, direction, timing } = config.transitions;
  const transitions: TimelineTransition[] = [];
  for (let k = 0; k < timelineScenes.length - 1; k++) {
    const name = presentations[k % presentations.length]!;
    if (name === 'none') continue;
    const before = timelineScenes[k]!;
    const after = timelineScenes[k + 1]!;
    const maxAllowed = Math.floor(
      Math.min(before.frames, after.frames) * TRANSITION_MAX_SCENE_FRACTION,
    );
    const durationInFrames = Math.min(transitionFrames, maxAllowed);
    if (durationInFrames < 1) continue;
    transitions.push({
      afterScene: k,
      atFrame: after.startFrame,
      name,
      durationInFrames,
      requestedFrames: transitionFrames,
      clamped: durationInFrames < transitionFrames,
      direction: resolveTransitionDirection(name, direction),
      timing,
    });
  }

  const transitionAfter = new Map(transitions.map((t) => [t.afterScene, t.durationInFrames]));
  const sequences: TimelineSequence[] = timelineScenes.map((scene, i) => {
    const tIn = transitionAfter.get(i - 1) ?? 0;
    const tOut = transitionAfter.get(i) ?? 0;
    const from = scene.startFrame - Math.ceil(tIn / 2);
    const end = scene.endFrame + Math.floor(tOut / 2);
    return { sceneIndex: i, from, durationInFrames: end - from };
  });

  const overlays: TimelineOverlay[] = [];
  if (config.backdrop.lightLeaks.enabled) {
    const wanted = Math.max(2, Math.round((LIGHT_LEAK_SECONDS * fps) / speed));
    for (let k = 0; k < timelineScenes.length - 1; k++) {
      const cut = timelineScenes[k + 1]!.startFrame;
      const limit = Math.min(timelineScenes[k]!.frames, timelineScenes[k + 1]!.frames);
      const durationInFrames = Math.min(wanted, limit);
      const from = Math.max(
        0,
        Math.min(cut - Math.floor(durationInFrames / 2), totalFrames - durationInFrames),
      );
      overlays.push({ kind: 'light-leak', atCut: k, from, durationInFrames });
    }
  }

  return { fps, totalFrames, scenes: timelineScenes, sequences, transitions, overlays };
};
