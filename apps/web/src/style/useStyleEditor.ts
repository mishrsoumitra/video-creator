import {
  VideoConfigSchema,
  applyAnimationKind,
  applyAspect,
  applyBackdropKind,
  applyCaptionStyle,
  applySpeed,
  crfRangeFor,
  deepEqual,
  diffConfig,
  getAtPath,
  isTransparentPixelFormat,
  pixelFormatsFor,
  setAtPath,
  supportsHardwareAcceleration,
  type AnimationKind,
  type Aspect,
  type BackdropKind,
  type CaptionStyle,
  type Preset,
  type VideoConfig,
} from '@vc/config';
import { useCallback, useMemo, useState } from 'react';

export type Picker =
  | { kind: 'animationKind'; value: AnimationKind }
  | { kind: 'backdropKind'; value: BackdropKind }
  | { kind: 'captionStyle'; value: CaptionStyle }
  | { kind: 'aspect'; value: Aspect }
  | { kind: 'speed'; value: number };

type State = {
  config: VideoConfig;
  /** Last config that passed the schema. */
  valid: VideoConfig;
  errors: Record<string, string>;
  presetId: string | null;
  /** Fields the user changed by hand (Advanced or Expert) since the last preset. */
  touched: string[];
  undo: { count: number; config: VideoConfig; touched: string[] } | null;
};

export type StyleEditorModel = {
  /** The draft, possibly invalid while the user is typing. */
  config: VideoConfig;
  /** The last config that passed the schema: what the preview and Generate use. */
  validConfig: VideoConfig;
  isValid: boolean;
  /** Schema errors by path. */
  errors: Record<string, string>;
  presetId: string | null;
  /** The selected preset's config, for "changed" markers. */
  baseline: VideoConfig | null;
  timedTransitions: ReadonlySet<string>;
  undo: { count: number } | null;
  applyPicker: (picker: Picker) => void;
  selectPreset: (preset: Preset) => void;
  setField: (path: string, value: unknown) => void;
  replaceConfig: (next: VideoConfig) => void;
  undoReset: () => void;
  dismissUndo: () => void;
};

/** Keeps codec-dependent output options consistent after a change (the UI never builds an invalid combination). */
const normalize = (config: VideoConfig, path: string, defaultTrackId: string): VideoConfig => {
  let out = config;
  const set = (p: string, v: unknown) => {
    out = setAtPath(out, p, v);
  };
  if (path === 'output.codec') {
    const { codec, crf, x264Preset, pixelFormat, hardwareAcceleration } = out.output;
    const range = crfRangeFor(codec);
    if (crf !== null && (!range || crf < range.min || crf > range.max)) set('output.crf', null);
    if (codec !== 'h264' && x264Preset !== null) set('output.x264Preset', null);
    if (!pixelFormatsFor(codec).includes(pixelFormat)) set('output.pixelFormat', 'yuv420p');
    if (hardwareAcceleration === 'required' && !supportsHardwareAcceleration(codec))
      set('output.hardwareAcceleration', 'disable');
  }
  if (
    path === 'output.imageFormat' &&
    out.output.imageFormat === 'jpeg' &&
    isTransparentPixelFormat(out.output.pixelFormat)
  )
    set('output.pixelFormat', 'yuv420p');
  if (path === 'audio.unlockPlaybackRate' && !out.audio.unlockPlaybackRate)
    set('audio.narrationPlaybackRate', 1);
  if (
    path === 'audio.music.source' &&
    out.audio.music.source === 'library' &&
    out.audio.music.trackId === null
  )
    set('audio.music.trackId', defaultTrackId);
  return out;
};

const validate = (
  config: VideoConfig,
  previous: VideoConfig,
): Pick<State, 'config' | 'valid' | 'errors'> => {
  const result = VideoConfigSchema.safeParse(config);
  if (result.success) return { config, valid: result.data, errors: {} };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues)
    errors[issue.path.map(String).join('.')] ??= issue.message;
  return { config, valid: previous, errors };
};

const pick = (
  config: VideoConfig,
  picker: Picker,
  timedTransitions: ReadonlySet<string>,
): VideoConfig => {
  switch (picker.kind) {
    case 'animationKind':
      return applyAnimationKind(config, picker.value, { timedTransitions });
    case 'backdropKind':
      return applyBackdropKind(config, picker.value);
    case 'captionStyle':
      return applyCaptionStyle(config, picker.value);
    case 'aspect':
      return applyAspect(config, picker.value);
    case 'speed':
      return applySpeed(config, picker.value);
  }
};

export const useStyleEditor = ({
  initial,
  presetId: initialPresetId,
  presets,
  timedTransitions: timedList,
  defaultTrackId = 'soft-pad',
}: {
  initial: VideoConfig;
  presetId: string | null;
  presets: readonly Preset[];
  timedTransitions: readonly string[];
  defaultTrackId?: string;
}): StyleEditorModel => {
  const [state, setState] = useState<State>(() => ({
    ...validate(initial, initial),
    presetId: initialPresetId,
    touched: [],
    undo: null,
  }));
  const timedKey = timedList.join(',');
  const timedTransitions = useMemo(() => new Set(timedKey ? timedKey.split(',') : []), [timedKey]);

  const applyPicker = useCallback(
    (picker: Picker) =>
      setState((s) => {
        let after: VideoConfig;
        try {
          after = pick(s.config, picker, timedTransitions);
        } catch {
          return s;
        }
        const overwritten = s.touched.filter(
          (path) => !deepEqual(getAtPath(s.config, path), getAtPath(after, path)),
        );
        return {
          ...validate(after, s.valid),
          presetId: s.presetId,
          touched: s.touched.filter((p) => !overwritten.includes(p)),
          undo:
            overwritten.length > 0
              ? { count: overwritten.length, config: s.config, touched: s.touched }
              : null,
        };
      }),
    [timedTransitions],
  );

  const selectPreset = useCallback(
    (preset: Preset) =>
      setState((s) => ({
        ...validate(structuredClone(preset.config), s.valid),
        presetId: preset.id,
        touched: [],
        undo: null,
      })),
    [],
  );

  const setField = useCallback(
    (path: string, value: unknown) =>
      setState((s) => ({
        ...s,
        ...validate(normalize(setAtPath(s.config, path, value), path, defaultTrackId), s.valid),
        touched: s.touched.includes(path) ? s.touched : [...s.touched, path],
        undo: null,
      })),
    [defaultTrackId],
  );

  const replaceConfig = useCallback(
    (next: VideoConfig) =>
      setState((s) => ({
        ...s,
        ...validate(next, s.valid),
        touched: [...new Set([...s.touched, ...diffConfig(s.config, next)])],
        undo: null,
      })),
    [],
  );

  const undoReset = useCallback(
    () =>
      setState((s) =>
        s.undo
          ? { ...s, ...validate(s.undo.config, s.valid), touched: s.undo.touched, undo: null }
          : s,
      ),
    [],
  );
  const dismissUndo = useCallback(() => setState((s) => ({ ...s, undo: null })), []);

  const baseline = useMemo(
    () => presets.find((p) => p.id === state.presetId)?.config ?? null,
    [presets, state.presetId],
  );

  return {
    config: state.config,
    validConfig: state.valid,
    isValid: Object.keys(state.errors).length === 0,
    errors: state.errors,
    presetId: state.presetId,
    baseline,
    timedTransitions,
    undo: state.undo ? { count: state.undo.count } : null,
    applyPicker,
    selectPreset,
    setField,
    replaceConfig,
    undoReset,
    dismissUndo,
  };
};
