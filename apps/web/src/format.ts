import { TRANSITION_CATALOG, type Easing, type JobStatus, type TransitionName } from '@vc/config';

/** Money: estimates read best at cents; ledger entries need four decimals. */
export const formatUsd = (value: number, precise = false): string => {
  if (!Number.isFinite(value)) return '—';
  if (precise) return `$${value.toFixed(value !== 0 && Math.abs(value) < 1 ? 4 : 2)}`;
  if (value > 0 && value < 0.01) return '< $0.01';
  return `$${value.toFixed(2)}`;
};

export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
};

export const formatSpeed = (speed: number) => `${Number(speed.toFixed(2))}×`;

const LABELS: Record<string, string> = {
  calm: 'Calm',
  documentary: 'Documentary',
  dynamic: 'Dynamic',
  cinematic: 'Cinematic',
  minimal: 'Minimal',
  dark: 'Dark',
  light: 'Light',
  gradient: 'Gradient',
  'blurred-image': 'Blurred image',
  textured: 'Textured',
  'kinetic-words': 'Kinetic words',
  'phrase-cards': 'Phrase cards',
  'underline-highlight': 'Underline-highlight',
  off: 'Off',
  'push-in': 'Push in',
  'pull-out': 'Pull out',
  'drift-lr': 'Drift left/right',
  'drift-ud': 'Drift up/down',
  none: 'None',
  'lower-third': 'Lower third',
  auto: 'Auto (per scene)',
  'follow-subject': 'Follow subject',
  in: 'In',
  out: 'Out',
  'in-out': 'In and out',
  linear: 'Linear',
  spring: 'Spring',
  disable: 'Disable',
  'if-possible': 'If possible',
  required: 'Required',
  cover: 'Full-bleed',
  card: 'Card',
  contain: 'Whole image over a blur',
  custom: 'Custom',
  image: 'From image',
  library: 'Library',
  upload: 'Upload',
  shrink: 'Shrink',
  wrap: 'Wrap',
  colour: 'Colour',
  scale: 'Scale',
  underline: 'Underline',
  box: 'Box',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  ease: 'Ease',
  quad: 'Quad',
  cubic: 'Cubic',
  sin: 'Sine',
  exp: 'Exponential',
  circle: 'Circle',
  back: 'Back',
  bounce: 'Bounce',
  elastic: 'Elastic',
  bezier: 'Bezier',
};

/** Human label for an enum value; technical values (codecs, pixel formats) stay as they are. */
export const optionLabel = (value: string | number | null): string => {
  if (value === null) return 'Default';
  const v = String(value);
  if (v in TRANSITION_CATALOG) return TRANSITION_CATALOG[v as TransitionName].label;
  if (LABELS[v]) return LABELS[v];
  if (/^from-/.test(v)) return `From ${v.slice(5).replace(/-/g, ' ')}`;
  return v;
};

export const describeEasing = (e: Easing): string => {
  if (e.type === 'linear') return 'Linear';
  if (e.type === 'bezier') return `Bezier (${e.x1}, ${e.y1}, ${e.x2}, ${e.y2})`;
  return `${optionLabel(e.type)} ${optionLabel(e.direction).toLowerCase()}`;
};

/** A field value as shown in "Default: …". */
export const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return optionLabel(value);
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every((v) => typeof v === 'number'))
      return `(${value.join(', ')})`;
    return value.map((v) => formatValue(v)).join(', ');
  }
  if (typeof value === 'object' && 'type' in value) return describeEasing(value as Easing);
  return JSON.stringify(value);
};

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  review: 'Ready for review',
  rendering: 'Rendering',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export const statusLabel = (status: JobStatus) => STATUS_LABELS[status] ?? status;

const STAGE_LABELS: Record<string, string> = {
  research: 'Research',
  script: 'Script',
  voice: 'Voice',
  timing: 'Word timing',
  scenes: 'Scene timing',
  images: 'Images',
  captions: 'Captions',
  render: 'Render',
  stitch: 'Stitch & mix',
  credits: 'Credits',
  checks: 'Final checks',
};
export const stageLabel = (stage: string) => STAGE_LABELS[stage] ?? stage;

const ROLE_LABELS: Record<string, string> = {
  text: 'Text',
  search: 'Web search',
  voice: 'Voice',
  align: 'Word timing',
  vision: 'Vision',
};
export const roleLabel = (role: string) => ROLE_LABELS[role] ?? role;

const n = (value: number) => value.toLocaleString('en-US');
const count = (value: number, one: string, many: string) =>
  `${n(value)} ${value === 1 ? one : many}`;

export const formatUnits = (units: Record<string, number | undefined>): string => {
  const parts: string[] = [];
  if (units.inputTokens !== undefined || units.outputTokens !== undefined)
    parts.push(`${n(units.inputTokens ?? 0)} in / ${n(units.outputTokens ?? 0)} out tokens`);
  if (units.characters) parts.push(`${n(units.characters)} chars`);
  if (units.searches) parts.push(count(units.searches, 'search', 'searches'));
  if (units.audioSeconds) parts.push(`${n(Math.round(units.audioSeconds))} s audio`);
  if (units.images) parts.push(count(units.images, 'image', 'images'));
  return parts.join(', ') || '—';
};

export const formatDateTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
