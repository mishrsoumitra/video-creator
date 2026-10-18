import { z } from 'zod';
import { ATOMIC_PATHS, SCHEMA_DEFAULTS, deepEqual, isPlainObject } from './defaults';
import { VideoConfigSchema, type VideoConfig } from './schema';

export type Tier = 'simple' | 'advanced' | 'output';
export type GroupId =
  'simple' | 'motion' | 'transitions' | 'captions' | 'backdrop' | 'audio' | 'output';

export type Control =
  | 'select'
  | 'segmented'
  | 'slider'
  | 'number'
  | 'toggle'
  | 'color'
  | 'font'
  | 'text'
  | 'multi-select'
  | 'easing'
  | 'palette'
  | 'uv'
  | 'nullable-number'
  | 'concurrency'
  | 'track'
  | 'upload';

export type FieldMeta = {
  readonly path: string;
  readonly label: string;
  /** One line shown under the control. */
  readonly note: string;
  readonly group: GroupId;
  readonly tier: Tier;
  readonly control: Control;
  /** Sub-heading inside a group (e.g. "spring", "vignette"), derived from the path. */
  readonly subgroup: string | null;
  readonly unit?: string;
  readonly step?: number;
};

export type GroupMeta = {
  readonly id: Exclude<GroupId, 'simple'>;
  readonly label: string;
  readonly tier: Tier;
};

/** Advanced panel groups, in display order. Output sits behind one more click (tier "output"). */
export const GROUPS: readonly GroupMeta[] = Object.freeze([
  { id: 'motion', label: 'Motion', tier: 'advanced' },
  { id: 'transitions', label: 'Transitions', tier: 'advanced' },
  { id: 'captions', label: 'Captions', tier: 'advanced' },
  { id: 'backdrop', label: 'Backdrop and effects', tier: 'advanced' },
  { id: 'audio', label: 'Audio', tier: 'advanced' },
  { id: 'output', label: 'Output', tier: 'output' },
]);

export const SUBGROUP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  spring: 'Spring (caption words and spring transitions)',
  motionBlur: 'Motion blur',
  palette: 'Palette',
  card: 'Image card',
  blur: 'Blurred-image backdrop',
  linearGradient: 'Linear gradient',
  tint: 'Tint',
  rings: 'Rings',
  gridlines: 'Gridlines',
  checkerboard: 'Checkerboard',
  zigzag: 'Zigzag',
  tile: 'Tile',
  lightLeaks: 'Light leaks',
  starburst: 'Starburst',
  vignette: 'Vignette',
  grain: 'Grain',
  letterbox: 'Letterbox',
  music: 'Music',
  ducking: 'Ducking',
});

type Spec = [
  path: string,
  label: string,
  note: string,
  control: Control,
  extra?: { unit?: string; step?: number },
];

const SPECS: Spec[] = [
  // Simple (always visible)
  ['simple.animationKind', 'Animation', 'How images move and how scenes join.', 'select'],
  [
    'simple.backdropKind',
    'Backdrop',
    'What sits behind the images and typographic scenes.',
    'select',
  ],
  [
    'simple.animationSpeed',
    'Animation speed',
    'Scales motion inside each scene; never changes narration timing.',
    'slider',
    { unit: '×', step: 0.05 },
  ],
  ['simple.captionStyle', 'Captions', 'How the spoken words appear on screen.', 'select'],
  ['simple.aspect', 'Aspect', 'One responsive layout; only the frame size changes.', 'segmented'],

  // Motion
  ['motion.imageMoves', 'Image moves', 'Cycled scene by scene, in this order.', 'multi-select'],
  [
    'motion.zoomAmount',
    'Zoom amount',
    'Largest scale an image reaches (1.0 = no zoom).',
    'slider',
    { step: 0.01 },
  ],
  [
    'motion.zoomPerSecond',
    'Zoom per second',
    'How fast images zoom at 1× speed; capped by zoom amount.',
    'slider',
    { step: 0.005 },
  ],
  [
    'motion.holdSeconds',
    'Hold at scene start',
    'Still time before an image starts to move.',
    'slider',
    { unit: 's', step: 0.05 },
  ],
  ['motion.easing', 'Easing', 'Shape of image moves and linear transitions.', 'easing'],
  [
    'motion.spring.mass',
    'Mass',
    'Heavier springs move slower and overshoot more.',
    'number',
    { step: 0.1 },
  ],
  [
    'motion.spring.damping',
    'Damping',
    'Higher damping settles with less bounce.',
    'number',
    { step: 1 },
  ],
  ['motion.spring.stiffness', 'Stiffness', 'Higher stiffness snaps faster.', 'number', { step: 1 }],
  [
    'motion.spring.overshootClamping',
    'Clamp overshoot',
    'Stop at the target instead of bouncing past it.',
    'toggle',
  ],
  [
    'motion.motionBlur.enabled',
    'Motion blur',
    'Blurs fast moves; multiplies render time by the sample count.',
    'toggle',
  ],
  [
    'motion.motionBlur.samples',
    'Samples',
    'More samples look smoother and render slower.',
    'number',
    { step: 1 },
  ],
  [
    'motion.motionBlur.shutterAngle',
    'Shutter angle',
    '180° is the film standard; larger means longer trails.',
    'slider',
    { unit: '°', step: 1 },
  ],

  // Transitions
  [
    'transitions.presentations',
    'Presentations',
    'Cycled cut by cut; "none" is a hard cut.',
    'multi-select',
  ],
  [
    'transitions.timing',
    'Timing',
    'Linear uses the easing; spring uses the spring settings.',
    'segmented',
  ],
  [
    'transitions.durationInFrames',
    'Duration',
    'At 1× speed and the output fps; clamped to fit short scenes.',
    'slider',
    { unit: 'frames', step: 1 },
  ],
  [
    'transitions.direction',
    'Direction',
    'Used by slide, wipe, flip, book-flip and blur-slide.',
    'select',
  ],

  // Captions
  [
    'captions.combineTokensWithinMilliseconds',
    'Combine words within',
    'Words spoken within this window share a caption page.',
    'slider',
    { unit: 'ms', step: 50 },
  ],
  [
    'captions.breakOnSilenceAfterMilliseconds',
    'Break on silence after',
    'A pause this long starts a new page; empty = never.',
    'nullable-number',
    { unit: 'ms', step: 50 },
  ],
  ['captions.fontFamily', 'Font', 'Any Google Font.', 'font'],
  ['captions.fontWeight', 'Weight', '100 (thin) to 900 (black).', 'select'],
  [
    'captions.fontSize',
    'Size',
    'Largest size at 1080p; text shrinks to fit, never overflows.',
    'slider',
    { unit: 'px', step: 1 },
  ],
  [
    'captions.minFontSize',
    'Minimum size',
    'Text never shrinks below this; it wraps instead.',
    'slider',
    { unit: 'px', step: 1 },
  ],
  [
    'captions.maxCharsPerLine',
    'Line length cap',
    'Longest caption line, in characters.',
    'slider',
    { step: 1 },
  ],
  ['captions.maxLines', 'Lines per page', 'A page longer than this is split.', 'segmented'],
  ['captions.fitMode', 'Text fit', 'Shrink to one line, or wrap onto several lines.', 'segmented'],
  ['captions.textColor', 'Text colour', 'Colour of words not yet spoken.', 'color'],
  ['captions.highlightColor', 'Highlight colour', 'Colour of the word being spoken.', 'color'],
  [
    'captions.highlightAnimation',
    'Highlight animation',
    'How the spoken word is marked.',
    'select',
  ],
  ['captions.outlineColor', 'Outline colour', 'Keeps captions readable over busy images.', 'color'],
  [
    'captions.outlineWidth',
    'Outline width',
    '0 = no outline.',
    'slider',
    { unit: 'px', step: 0.5 },
  ],
  [
    'captions.position',
    'Position',
    'Fixed lower third, per-scene auto, or beside the subject.',
    'select',
  ],
  [
    'captions.burnIn',
    'Burn in',
    'Draw captions into the video. The .srt file is always written.',
    'toggle',
  ],

  // Backdrop and effects
  [
    'backdrop.palette.source',
    'Palette source',
    'Your five colours, or pulled from the first image.',
    'segmented',
  ],
  [
    'backdrop.palette.colors',
    'Palette',
    'Background, second background, accent, text, extra accent.',
    'palette',
  ],
  [
    'backdrop.imageFit',
    'Image fit',
    'Full-bleed, a card on the backdrop, or whole image over a blur.',
    'segmented',
  ],
  [
    'backdrop.card.radius',
    'Corner radius',
    'Rounding of the image card.',
    'slider',
    { unit: 'px', step: 1 },
  ],
  ['backdrop.card.shadow', 'Shadow', 'Strength of the soft card shadow.', 'slider', { step: 0.01 }],
  [
    'backdrop.card.margin',
    'Margin',
    'Space around the card, as a share of the frame.',
    'slider',
    { step: 0.01 },
  ],
  [
    'backdrop.blur.radius',
    'Blur radius',
    'How soft the background copy of the image is.',
    'slider',
    { unit: 'px', step: 1 },
  ],
  [
    'backdrop.blur.darken',
    'Darken',
    'Dims the blurred copy so the sharp image stands out.',
    'slider',
    { step: 0.01 },
  ],
  [
    'backdrop.linearGradient.enabled',
    'Gradient',
    'Two-colour gradient from palette colours 1 and 2.',
    'toggle',
  ],
  [
    'backdrop.linearGradient.start',
    'Start point',
    'Where colour 1 is strongest (0..1 on each axis).',
    'uv',
  ],
  [
    'backdrop.linearGradient.end',
    'End point',
    'Where colour 2 is strongest (0..1 on each axis).',
    'uv',
  ],
  ['backdrop.tint.enabled', 'Tint', 'Washes every image toward one colour.', 'toggle'],
  ['backdrop.tint.color', 'Tint colour', 'Colour images are tinted toward.', 'color'],
  ['backdrop.tint.amount', 'Tint amount', '0 = none, 1 = fully tinted.', 'slider', { step: 0.01 }],
  ['backdrop.rings.enabled', 'Rings', 'Concentric rings in the palette colours.', 'toggle'],
  [
    'backdrop.rings.thickness',
    'Ring thickness',
    'Width of each ring.',
    'slider',
    { unit: 'px', step: 0.5 },
  ],
  ['backdrop.rings.gap', 'Ring gap', 'Space between rings.', 'slider', { unit: 'px', step: 0.5 }],
  [
    'backdrop.rings.opacity',
    'Ring opacity',
    'Keep low so the pattern stays subtle.',
    'slider',
    { step: 0.01 },
  ],
  ['backdrop.gridlines.enabled', 'Gridlines', 'A fine grid in the text colour.', 'toggle'],
  [
    'backdrop.gridlines.gridSize',
    'Grid size',
    'Distance between lines.',
    'slider',
    { unit: 'px', step: 1 },
  ],
  [
    'backdrop.gridlines.lineWidth',
    'Line width',
    'Thickness of each line.',
    'slider',
    { unit: 'px', step: 0.5 },
  ],
  [
    'backdrop.gridlines.opacity',
    'Grid opacity',
    'Keep low so the grid stays subtle.',
    'slider',
    { step: 0.01 },
  ],
  [
    'backdrop.checkerboard.enabled',
    'Checkerboard',
    'Alternating squares in the palette colours.',
    'toggle',
  ],
  [
    'backdrop.checkerboard.cellSize',
    'Cell size',
    'Width of each square.',
    'slider',
    { unit: 'px', step: 1 },
  ],
  [
    'backdrop.checkerboard.gap',
    'Cell gap',
    'Space between squares.',
    'slider',
    { unit: 'px', step: 0.5 },
  ],
  [
    'backdrop.checkerboard.angle',
    'Angle',
    'Rotation of the pattern.',
    'slider',
    { unit: '°', step: 1 },
  ],
  [
    'backdrop.checkerboard.opacity',
    'Checker opacity',
    'Keep low so the pattern stays subtle.',
    'slider',
    { step: 0.01 },
  ],
  ['backdrop.zigzag.enabled', 'Zigzag', 'Zigzag stripes in the palette colours.', 'toggle'],
  ['backdrop.zigzag.direction', 'Zigzag direction', 'Horizontal or vertical stripes.', 'segmented'],
  [
    'backdrop.zigzag.thickness',
    'Stripe thickness',
    'Width of each stripe.',
    'slider',
    { unit: 'px', step: 0.5 },
  ],
  [
    'backdrop.zigzag.gap',
    'Stripe gap',
    'Space between stripes.',
    'slider',
    { unit: 'px', step: 0.5 },
  ],
  [
    'backdrop.zigzag.opacity',
    'Zigzag opacity',
    'Keep low so the pattern stays subtle.',
    'slider',
    { step: 0.01 },
  ],
  ['backdrop.tile.enabled', 'Tile', 'Repeats the backdrop pattern as tiles.', 'toggle'],
  ['backdrop.tile.horizontal', 'Tile horizontally', 'Repeat across the frame.', 'toggle'],
  ['backdrop.tile.vertical', 'Tile vertically', 'Repeat down the frame.', 'toggle'],
  [
    'backdrop.lightLeaks.enabled',
    'Light leaks',
    'Warm film light leaks at scene cuts; adds render time.',
    'toggle',
  ],
  [
    'backdrop.lightLeaks.intensity',
    'Leak intensity',
    'Opacity of the light leaks.',
    'slider',
    { step: 0.01 },
  ],
  [
    'backdrop.lightLeaks.hueShift',
    'Leak hue',
    'Rotates the leak colours.',
    'slider',
    { unit: '°', step: 1 },
  ],
  ['backdrop.lightLeaks.seed', 'Leak seed', 'Changes the leak shapes.', 'number', { step: 1 }],
  ['backdrop.starburst.enabled', 'Starburst', 'Rotating rays behind typographic scenes.', 'toggle'],
  [
    'backdrop.starburst.intensity',
    'Starburst intensity',
    'Opacity of the rays.',
    'slider',
    { step: 0.01 },
  ],
  ['backdrop.starburst.rays', 'Rays', 'Number of rays.', 'slider', { step: 1 }],
  [
    'backdrop.starburst.rotationPerSecond',
    'Ray rotation',
    'Degrees per second at 1× speed.',
    'slider',
    { unit: '°/s', step: 1 },
  ],
  ['backdrop.vignette.enabled', 'Vignette', 'Darkens the frame edges.', 'toggle'],
  [
    'backdrop.vignette.amount',
    'Vignette amount',
    'How dark the edges get.',
    'slider',
    { step: 0.01 },
  ],
  [
    'backdrop.vignette.radius',
    'Vignette radius',
    'Size of the untouched centre.',
    'slider',
    { step: 0.01 },
  ],
  [
    'backdrop.vignette.feather',
    'Vignette feather',
    'Softness of the edge.',
    'slider',
    { step: 0.01 },
  ],
  ['backdrop.grain.enabled', 'Grain', 'Subtle film grain over the whole frame.', 'toggle'],
  [
    'backdrop.grain.amount',
    'Grain amount',
    'Heavy grain makes files larger.',
    'slider',
    { step: 0.01 },
  ],
  [
    'backdrop.grain.size',
    'Grain size',
    'Size of each grain particle.',
    'slider',
    { unit: 'px', step: 0.5 },
  ],
  ['backdrop.grain.animated', 'Animate grain', 'New grain every frame, like film.', 'toggle'],
  ['backdrop.letterbox.enabled', 'Letterbox', 'Cinema bars above and below.', 'toggle'],
  ['backdrop.letterbox.ratio', 'Letterbox ratio', 'Picture shape inside the bars.', 'segmented'],

  // Audio
  ['audio.music.source', 'Music', 'No music, a library track, or your own upload.', 'segmented'],
  ['audio.music.trackId', 'Library track', 'Royalty-free tracks generated locally.', 'track'],
  ['audio.music.uploadId', 'Uploaded track', 'An audio file you uploaded.', 'upload'],
  [
    'audio.music.volume',
    'Music volume',
    'Before ducking; 0.25 is a quiet bed.',
    'slider',
    { step: 0.01 },
  ],
  [
    'audio.ducking.enabled',
    'Ducking',
    'Lowers music while the narrator speaks (ffmpeg sidechain).',
    'toggle',
  ],
  [
    'audio.ducking.depthDb',
    'Ducking depth',
    'How far music drops under speech.',
    'slider',
    { unit: 'dB', step: 1 },
  ],
  [
    'audio.ducking.attackMs',
    'Attack',
    'How quickly music drops when speech starts.',
    'slider',
    { unit: 'ms', step: 5 },
  ],
  [
    'audio.ducking.releaseMs',
    'Release',
    'How quickly music returns after speech.',
    'slider',
    { unit: 'ms', step: 10 },
  ],
  [
    'audio.loudnessTargetLufs',
    'Loudness target',
    'Integrated loudness after mixing (ffmpeg loudnorm); -14 suits YouTube.',
    'slider',
    { unit: 'LUFS', step: 1 },
  ],
  [
    'audio.narrationVolume',
    'Narration volume',
    'Before loudness normalisation.',
    'slider',
    { step: 0.05 },
  ],
  [
    'audio.narrationPlaybackRate',
    'Narration rate',
    'Locked at 1.0: changing it breaks the word timings.',
    'slider',
    { unit: '×', step: 0.05 },
  ],
  [
    'audio.unlockPlaybackRate',
    'Unlock narration rate',
    'Re-times every word and scene if you change the rate.',
    'toggle',
  ],

  // Output
  ['output.codec', 'Codec', 'h264 plays everywhere; ProRes is for editing.', 'select'],
  [
    'output.crf',
    'CRF',
    'Lower is better quality and larger files; empty = codec default.',
    'nullable-number',
    { step: 1 },
  ],
  ['output.proResProfile', 'ProRes profile', 'Quality tier for ProRes.', 'select'],
  ['output.fps', 'Frame rate', 'Frames per second.', 'segmented', { unit: 'fps' }],
  [
    'output.resolution',
    'Resolution',
    'Rendered with Remotion’s scale option from a 1080p layout.',
    'segmented',
  ],
  ['output.x264Preset', 'x264 preset', 'h264 only: slower presets make smaller files.', 'select'],
  ['output.pixelFormat', 'Pixel format', 'yuv420p plays everywhere.', 'select'],
  [
    'output.colorSpace',
    'Colour space',
    'Leave on default unless you grade for a specific target.',
    'select',
  ],
  [
    'output.imageFormat',
    'Frame format',
    'JPEG renders faster; PNG is needed for transparency.',
    'segmented',
  ],
  [
    'output.jpegQuality',
    'JPEG quality',
    'Quality of each rendered frame, 0..100.',
    'slider',
    { step: 1 },
  ],
  [
    'output.concurrency',
    'Concurrency',
    'Browser tabs rendering in parallel; empty = Remotion default.',
    'concurrency',
  ],
  [
    'output.hardwareAcceleration',
    'Hardware acceleration',
    'Uses the GPU encoder; cannot be combined with CRF.',
    'segmented',
  ],
];

const groupOf = (path: string): GroupId => path.split('.')[0] as GroupId;
const tierOf = (group: GroupId): Tier =>
  group === 'simple' ? 'simple' : group === 'output' ? 'output' : 'advanced';

export const FIELDS: readonly FieldMeta[] = Object.freeze(
  SPECS.map(([path, label, note, control, extra]) => {
    const group = groupOf(path);
    const segments = path.split('.');
    return Object.freeze({
      path,
      label,
      note,
      group,
      tier: tierOf(group),
      control,
      subgroup: segments.length >= 3 ? segments[1]! : null,
      ...(extra ?? {}),
    });
  }),
);

const FIELD_BY_PATH = new Map(FIELDS.map((f) => [f.path, f]));

export const getField = (path: string): FieldMeta => {
  const field = FIELD_BY_PATH.get(path);
  if (!field) throw new Error(`Unknown field: ${path}`);
  return field;
};

/* ------------------------------------------------------------ path helpers */

export const listLeafPaths = (value: unknown, prefix = ''): string[] => {
  if (!isPlainObject(value) || ATOMIC_PATHS.has(prefix)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, child]) =>
    listLeafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
};

export const getAtPath = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        isPlainObject(node) || Array.isArray(node)
          ? (node as Record<string, unknown>)[key]
          : undefined,
      value,
    );

export const setAtPath = <T>(value: T, path: string, next: unknown): T => {
  const [head, ...rest] = path.split('.');
  const node = (isPlainObject(value) ? value : {}) as Record<string, unknown>;
  return {
    ...node,
    [head!]: rest.length === 0 ? next : setAtPath(node[head!], rest.join('.'), next),
  } as T;
};

/** Field paths whose values differ between two configs. */
export const diffConfig = (a: VideoConfig, b: VideoConfig): string[] => {
  const paths = new Set([...listLeafPaths(a), ...listLeafPaths(b)]);
  return [...paths].filter((p) => !deepEqual(getAtPath(a, p), getAtPath(b, p)));
};

export const getFieldDefault = (path: string): unknown =>
  structuredClone(getAtPath(SCHEMA_DEFAULTS, getField(path).path));

/* ------------------------------------------------------------- constraints */

export type FieldConstraints =
  | {
      kind: 'number';
      min?: number;
      max?: number;
      exclusiveMin?: boolean;
      integer?: boolean;
      multipleOf?: number;
      nullable?: true;
    }
  | { kind: 'enum'; options: Array<string | number>; nullable?: true }
  | { kind: 'boolean' }
  | { kind: 'string'; minLength?: number; maxLength?: number; nullable?: true }
  | { kind: 'array'; options?: Array<string | number>; minItems?: number; maxItems?: number }
  | { kind: 'tuple'; length: number; min?: number; max?: number }
  | { kind: 'union'; nullable?: true }
  | { kind: 'object' };

type JsonNode = Record<string, unknown>;

let jsonSchema: JsonNode | undefined;
const getJsonSchema = (): JsonNode =>
  (jsonSchema ??= z.toJSONSchema(VideoConfigSchema, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonNode);

const SAFE = Number.MAX_SAFE_INTEGER;

const describeNode = (node: JsonNode, nullable = false): FieldConstraints => {
  const nullableFlag = nullable ? ({ nullable: true } as const) : {};
  const variants = (node.anyOf ?? node.oneOf) as JsonNode[] | undefined;
  if (variants) {
    const nonNull = variants.filter((v) => v.type !== 'null');
    const isNullable = nullable || nonNull.length < variants.length;
    if (nonNull.length === 1) return describeNode(nonNull[0]!, isNullable);
    if (nonNull.every((v) => v.const !== undefined)) {
      return {
        kind: 'enum',
        options: nonNull.map((v) => v.const as string | number),
        ...(isNullable ? { nullable: true as const } : {}),
      };
    }
    return { kind: 'union', ...(isNullable ? { nullable: true as const } : {}) };
  }
  if (Array.isArray(node.enum))
    return { kind: 'enum', options: node.enum as Array<string | number>, ...nullableFlag };
  if (node.const !== undefined)
    return { kind: 'enum', options: [node.const as string | number], ...nullableFlag };
  switch (node.type) {
    case 'number':
    case 'integer': {
      const out: FieldConstraints & { kind: 'number' } = { kind: 'number', ...nullableFlag };
      const min = (node.minimum ?? node.exclusiveMinimum) as number | undefined;
      const max = (node.maximum ?? node.exclusiveMaximum) as number | undefined;
      if (min !== undefined && Math.abs(min) < SAFE) out.min = min;
      if (max !== undefined && Math.abs(max) < SAFE) out.max = max;
      if (node.exclusiveMinimum !== undefined) out.exclusiveMin = true;
      if (node.type === 'integer') out.integer = true;
      if (typeof node.multipleOf === 'number') out.multipleOf = node.multipleOf;
      return out;
    }
    case 'boolean':
      return { kind: 'boolean' };
    case 'string':
      return {
        kind: 'string',
        ...(typeof node.minLength === 'number' ? { minLength: node.minLength } : {}),
        ...(typeof node.maxLength === 'number' ? { maxLength: node.maxLength } : {}),
        ...nullableFlag,
      };
    case 'array': {
      if (Array.isArray(node.prefixItems)) {
        const first = (node.prefixItems as JsonNode[])[0] ?? {};
        return {
          kind: 'tuple',
          length: (node.prefixItems as unknown[]).length,
          ...(typeof first.minimum === 'number' ? { min: first.minimum } : {}),
          ...(typeof first.maximum === 'number' ? { max: first.maximum } : {}),
        };
      }
      const items = (node.items ?? {}) as JsonNode;
      return {
        kind: 'array',
        ...(Array.isArray(items.enum) ? { options: items.enum as Array<string | number> } : {}),
        ...(typeof node.minItems === 'number' ? { minItems: node.minItems } : {}),
        ...(typeof node.maxItems === 'number' ? { maxItems: node.maxItems } : {}),
      };
    }
    default:
      return { kind: 'object' };
  }
};

/** Ranges and options for a field, read from the Zod schema (via JSON Schema). */
export const getFieldConstraints = (path: string): FieldConstraints => {
  getField(path);
  let node: JsonNode | undefined = getJsonSchema();
  for (const key of path.split('.')) {
    const properties = node?.properties as Record<string, JsonNode> | undefined;
    node = properties?.[key];
  }
  if (!node) throw new Error(`Unknown field: ${path}`);
  return describeNode(node);
};

/* -------------------------------------------------------- disabled controls */

const TOGGLED_SUBGROUPS = new Set([
  'motion.motionBlur',
  'backdrop.linearGradient',
  'backdrop.tint',
  'backdrop.rings',
  'backdrop.gridlines',
  'backdrop.checkerboard',
  'backdrop.zigzag',
  'backdrop.tile',
  'backdrop.lightLeaks',
  'backdrop.starburst',
  'backdrop.vignette',
  'backdrop.grain',
  'backdrop.letterbox',
  'audio.ducking',
]);

/**
 * Why a control is disabled for the current config, or null when it is editable. Mirrors the
 * schema's cross-field rules so the UI never lets the user build an invalid combination.
 */
export const getDisabledReason = (path: string, config: VideoConfig): string | null => {
  const { output, audio, backdrop } = config;
  switch (path) {
    case 'output.crf':
      if (output.codec === 'prores') return 'ProRes uses a profile instead of CRF.';
      if (output.hardwareAcceleration !== 'disable')
        return 'Hardware acceleration is on, and it cannot be combined with CRF.';
      return null;
    case 'output.hardwareAcceleration':
      return output.crf !== null
        ? 'Clear the CRF first: CRF and hardware acceleration cannot be combined.'
        : null;
    case 'output.proResProfile':
      return output.codec === 'prores' ? null : 'Only used by the ProRes codec.';
    case 'output.x264Preset':
      return output.codec === 'h264' ? null : 'Only used by the h264 codec.';
    case 'output.jpegQuality':
      return output.imageFormat === 'jpeg'
        ? null
        : 'PNG frames are lossless; quality only applies to JPEG.';
    case 'audio.narrationPlaybackRate':
      return audio.unlockPlaybackRate
        ? null
        : 'Locked at 1.0 so word timings stay correct. Unlock it to change.';
    case 'audio.music.trackId':
      return audio.music.source === 'library' ? null : 'Only used for library music.';
    case 'audio.music.uploadId':
      return audio.music.source === 'upload' ? null : 'Only used for uploaded music.';
    case 'audio.music.volume':
      return audio.music.source === 'none' ? 'No music selected.' : null;
    case 'backdrop.palette.colors':
      return backdrop.palette.source === 'image'
        ? 'Colours are pulled from the first image.'
        : null;
  }
  if (path.startsWith('backdrop.card.') && backdrop.imageFit !== 'card')
    return 'Only used when images sit in a card.';
  if (path.startsWith('backdrop.blur.') && backdrop.imageFit !== 'contain')
    return 'Only used when the whole image sits over a blurred copy.';
  const parent = path.slice(0, path.lastIndexOf('.'));
  if (TOGGLED_SUBGROUPS.has(parent) && !path.endsWith('.enabled')) {
    const enabled = getAtPath(config, `${parent}.enabled`);
    if (enabled === false)
      return `${SUBGROUP_LABELS[parent.split('.')[1]!] ?? 'This effect'} is off.`;
  }
  return null;
};
