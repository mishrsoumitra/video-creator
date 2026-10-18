import { z } from 'zod';
import {
  applyAnimationKind,
  applyAspect,
  applyBackdropKind,
  applyCaptionStyle,
  applySpeed,
} from './bundles';
import { SCHEMA_DEFAULTS, deepFreeze, mergeConfig } from './defaults';
import type { AnimationKind, Aspect, BackdropKind, CaptionStyle } from './enums';
import { VideoConfigSchema, type VideoConfig, type VideoConfigInput } from './schema';

export const PresetSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(200).default(''),
  builtIn: z.boolean(),
  config: VideoConfigSchema,
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Preset = z.output<typeof PresetSchema>;

type Picks = {
  animationKind: AnimationKind;
  backdropKind: BackdropKind;
  captionStyle: CaptionStyle;
  aspect: Aspect;
  speed: number;
};

/** Built-in looks are the simple pickers applied in order, plus tweaks that never touch motion or transitions. */
const buildPreset = (
  id: string,
  name: string,
  description: string,
  picks: Picks,
  tweaks: VideoConfigInput = {},
): Preset => {
  let config: VideoConfig = structuredClone(SCHEMA_DEFAULTS) as VideoConfig;
  config = applyAnimationKind(config, picks.animationKind, { timedTransitions: new Set() });
  config = applyBackdropKind(config, picks.backdropKind);
  config = applyCaptionStyle(config, picks.captionStyle);
  config = applyAspect(config, picks.aspect);
  config = applySpeed(config, picks.speed);
  config = VideoConfigSchema.parse(mergeConfig(config, { ...tweaks, basedOnPreset: id }));
  return { id, name, description, builtIn: true, config };
};

export const DEFAULT_PRESET_ID = 'documentary';

export const BUILT_IN_PRESETS: readonly Preset[] = deepFreeze([
  buildPreset(
    'documentary',
    'Documentary',
    'Push-ins and drifts over full-bleed images, wipes and slides, phrase captions.',
    {
      animationKind: 'documentary',
      backdropKind: 'dark',
      captionStyle: 'phrase-cards',
      aspect: '16:9',
      speed: 1,
    },
    {
      backdrop: { vignette: { enabled: true, amount: 0.3 } },
      audio: { music: { source: 'library', trackId: 'soft-pad', volume: 0.2 } },
    },
  ),
  buildPreset(
    'calm-explainer',
    'Calm Explainer',
    'Slow push-ins in soft cards on off-white, crossfades, hand-drawn underlines.',
    {
      animationKind: 'calm',
      backdropKind: 'light',
      captionStyle: 'underline-highlight',
      aspect: '16:9',
      speed: 0.9,
    },
    { audio: { music: { source: 'library', trackId: 'soft-pad', volume: 0.18 } } },
  ),
  buildPreset(
    'dynamic-shorts',
    'Dynamic Shorts',
    'Vertical, fast cuts and zooms on a bold gradient, word-by-word captions.',
    {
      animationKind: 'dynamic',
      backdropKind: 'gradient',
      captionStyle: 'kinetic-words',
      aspect: '9:16',
      speed: 1.25,
    },
    { audio: { music: { source: 'library', trackId: 'pulse', volume: 0.22 } } },
  ),
  buildPreset(
    'cinematic',
    'Cinematic',
    'Slow drifts, dissolves and light leaks, letterboxed, images over a blurred copy.',
    {
      animationKind: 'cinematic',
      backdropKind: 'blurred-image',
      captionStyle: 'phrase-cards',
      aspect: '16:9',
      speed: 0.85,
    },
    {
      backdrop: { vignette: { enabled: true, amount: 0.35 } },
      audio: { music: { source: 'library', trackId: 'drone', volume: 0.22 } },
    },
  ),
  buildPreset(
    'minimal-type',
    'Minimal Type',
    'No image motion, hard cuts, textured backdrop; the captions do the work.',
    {
      animationKind: 'minimal',
      backdropKind: 'textured',
      captionStyle: 'kinetic-words',
      aspect: '1:1',
      speed: 1,
    },
  ),
]);

export const getBuiltInPreset = (id: string): Preset | undefined =>
  BUILT_IN_PRESETS.find((p) => p.id === id);

/** What a user who touches nothing gets: a fresh, mutable copy of the default preset. */
export const initialConfig = (): VideoConfig =>
  structuredClone(getBuiltInPreset(DEFAULT_PRESET_ID)!.config) as VideoConfig;

const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

export const slugifyPresetName = (name: string): string => {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || `preset-${fnv1a(name)}`;
};

const norm = (name: string) => name.trim().toLowerCase();

/** Returns an error message, or null when the name can be used for a new user preset. */
export const validatePresetName = (
  name: string,
  existingNames: readonly string[],
): string | null => {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'A name is required.';
  if (trimmed.length > 60) return 'Names must be 60 characters or fewer.';
  if (BUILT_IN_PRESETS.some((p) => norm(p.name) === norm(trimmed)))
    return 'That name belongs to a built-in preset.';
  if (existingNames.some((n) => norm(n) === norm(trimmed)))
    return 'A preset with that name already exists.';
  return null;
};

export const createPresetRecord = (
  input: { name: string; description?: string; config: unknown },
  existingNames: readonly string[],
): Preset => {
  const error = validatePresetName(input.name, existingNames);
  if (error) throw new Error(error);
  const config = VideoConfigSchema.parse(input.config);
  return PresetSchema.parse({
    id: slugifyPresetName(input.name),
    name: input.name.trim(),
    description: input.description ?? '',
    builtIn: false,
    config,
  });
};
