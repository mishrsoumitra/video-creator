import { contrastRatio } from './color';
import type { Codec, TransitionName } from './enums';
import type { VideoConfig } from './schema';
import { TRANSITION_CATALOG } from './transitions';

export type ConfigWarning = {
  readonly id: string;
  readonly severity: 'info' | 'warn';
  readonly message: string;
  /** Field paths involved, so the UI can show the warning next to them. */
  readonly fields: readonly string[];
};

export type WarningContext = { timedTransitions: ReadonlySet<string> };

/** Transitions whose wobble fights a bouncy easing at high speed. */
const WOBBLY_TRANSITIONS: readonly TransitionName[] = ['ripple', 'crosswarp', 'dreamy-zoom'];
const BOUNCY_EASINGS = new Set(['elastic', 'bounce']);
const CRF_COMFORT: Readonly<Partial<Record<Codec, { low: number; high: number }>>> = {
  h264: { low: 12, high: 35 },
  h265: { low: 14, high: 38 },
  vp8: { low: 6, high: 50 },
  vp9: { low: 15, high: 50 },
  av1: { low: 15, high: 50 },
};

/**
 * Some combinations are valid and still look bad, or cost a lot to render. These are warnings,
 * never errors: Advanced warns, it does not block. Curated presets produce none.
 */
export const getWarnings = (
  config: VideoConfig,
  { timedTransitions }: WarningContext,
): ConfigWarning[] => {
  const out: ConfigWarning[] = [];
  const add = (
    id: string,
    message: string,
    fields: string[],
    severity: ConfigWarning['severity'] = 'warn',
  ) => out.push({ id, severity, message, fields });

  const { simple, motion, transitions, captions, backdrop, audio, output } = config;
  const speed = simple.animationSpeed;
  const presentations = transitions.presentations;
  const moving = presentations.filter((p) => p !== 'none');

  if (
    BOUNCY_EASINGS.has(motion.easing.type) &&
    speed >= 1.75 &&
    presentations.some((p) => WOBBLY_TRANSITIONS.includes(p))
  ) {
    add(
      'jarring-combination',
      `${motion.easing.type} easing at ${speed}x with ${presentations.filter((p) => WOBBLY_TRANSITIONS.includes(p)).join('/')} transitions is valid but usually looks jarring.`,
      ['motion.easing', 'simple.animationSpeed', 'transitions.presentations'],
    );
  }

  if (output.resolution === '4k') {
    const culprits: string[] = [];
    if (backdrop.lightLeaks.enabled) culprits.push('backdrop.lightLeaks.enabled');
    if (motion.motionBlur.enabled) culprits.push('motion.motionBlur.enabled');
    if (presentations.some((p) => TRANSITION_CATALOG[p].blur))
      culprits.push('transitions.presentations');
    if (culprits.length > 0) {
      add(
        'render-cost',
        'Light leaks, blur transitions and motion blur multiply frame time, and 4K multiplies it again.',
        ['output.resolution', ...culprits],
      );
    }
  }

  if (motion.motionBlur.enabled && motion.motionBlur.samples > 16) {
    add(
      'motion-blur-samples',
      `${motion.motionBlur.samples} motion-blur samples render each frame that many times.`,
      ['motion.motionBlur.samples'],
    );
  }

  if (backdrop.letterbox.enabled && simple.aspect === '9:16') {
    add('letterbox-vertical', 'Letterbox bars on a vertical frame leave a thin strip of picture.', [
      'backdrop.letterbox.enabled',
      'simple.aspect',
    ]);
  }

  if (simple.captionStyle !== 'off' && captions.burnIn && backdrop.imageFit === 'card') {
    const behind = [
      backdrop.palette.colors[0]!,
      ...(backdrop.linearGradient.enabled ? [backdrop.palette.colors[1]!] : []),
    ];
    const worst = Math.min(...behind.map((bg) => contrastRatio(captions.textColor, bg)));
    if (worst < 4.5) {
      add(
        'caption-contrast',
        `Caption text has a contrast of ${worst.toFixed(1)}:1 against the backdrop; 4.5:1 is the readable minimum.`,
        ['captions.textColor', 'backdrop.palette.colors'],
      );
    }
  }

  if (
    audio.music.source !== 'none' &&
    audio.music.volume > 0.5 &&
    (!audio.ducking.enabled || audio.ducking.depthDb < 6)
  ) {
    add('music-masking', 'Loud music without enough ducking can bury the narration.', [
      'audio.music.volume',
      'audio.ducking.depthDb',
    ]);
  }

  if (moving.length > 0) {
    const seconds = transitions.durationInFrames / speed / output.fps;
    if (seconds > 1.5) {
      add(
        'long-transition',
        `Transitions last ${seconds.toFixed(1)} s and will be shortened on short scenes.`,
        ['transitions.durationInFrames', 'simple.animationSpeed'],
      );
    } else if (seconds < 0.15) {
      add(
        'short-transition',
        `Transitions last ${Math.round(seconds * 1000)} ms, which reads as a hard cut.`,
        ['transitions.durationInFrames', 'output.fps'],
      );
    }
  }

  const untimed = presentations.filter(
    (p) => TRANSITION_CATALOG[p].gated && !timedTransitions.has(p),
  );
  if (untimed.length > 0) {
    add(
      'untimed-transition',
      `${untimed.join(', ')} has not been timed on this machine yet, so its render cost is unknown.`,
      ['transitions.presentations'],
    );
  }

  const zoomRate = motion.zoomPerSecond * speed;
  if (zoomRate > 0.15 && motion.imageMoves.some((m) => m !== 'none')) {
    add(
      'fast-zoom',
      `Images zoom ${(zoomRate * 100).toFixed(0)}% per second, which can feel jittery.`,
      ['motion.zoomPerSecond', 'simple.animationSpeed'],
    );
  }

  const comfort = CRF_COMFORT[output.codec];
  if (comfort && output.crf !== null) {
    if (output.crf > comfort.high)
      add('crf-low-quality', `CRF ${output.crf} will show visible compression.`, ['output.crf']);
    if (output.crf < comfort.low)
      add('crf-huge-files', `CRF ${output.crf} makes very large files for little visible gain.`, [
        'output.crf',
      ]);
  }

  if (audio.unlockPlaybackRate && audio.narrationPlaybackRate !== 1) {
    add(
      'narration-rate',
      'The narration rate is changed: every word and scene will be re-timed to match.',
      ['audio.narrationPlaybackRate'],
    );
  }

  if (backdrop.grain.enabled && backdrop.grain.amount > 0.25) {
    add('heavy-grain', 'Heavy grain is hard to compress and makes files much larger.', [
      'backdrop.grain.amount',
    ]);
  }

  return out;
};

/** Notes for the review screen: which transitions the browser preview replaces with a CSS stand-in. */
export const getPreviewNotes = (config: VideoConfig, htmlInCanvasSupported: boolean): string[] =>
  htmlInCanvasSupported
    ? []
    : [
        ...new Set(
          config.transitions.presentations.filter(
            (p) => TRANSITION_CATALOG[p].renderer === 'shader',
          ),
        ),
      ].map(
        (p) =>
          `${TRANSITION_CATALOG[p].label} is previewed as ${TRANSITION_CATALOG[TRANSITION_CATALOG[p].cssStandIn].label.toLowerCase()}; the final render uses the real shader.`,
      );
