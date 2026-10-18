import {
  EASING_DIRECTIONS,
  EASING_TYPES,
  TRANSITION_NAMES,
  crfRangeFor,
  defaultCrfFor,
  getFieldConstraints,
  type CatalogResponse,
  type Codec,
  type Easing,
  type FieldMeta,
} from '@vc/config';
import { useState, type ReactNode } from 'react';
import { api, errorMessage } from '../api';
import { optionLabel } from '../format';
import { EasingPreview } from './previews';

export type ControlProps = {
  field: FieldMeta;
  id: string;
  value: unknown;
  /** The current codec: the CRF range depends on it. */
  codec: Codec;
  disabled: boolean;
  catalog: CatalogResponse;
  onChange: (value: unknown) => void;
};

type Option = string | number | null;

/** Options for enum-like fields: from the schema, or generated from a small integer range. */
export const optionsFor = (path: string): Option[] => {
  const c = getFieldConstraints(path);
  if (c.kind === 'enum') return [...(c.nullable ? [null] : []), ...c.options];
  if (c.kind === 'number' && c.min !== undefined && c.max !== undefined) {
    const step = c.multipleOf ?? 1;
    const out: Option[] = [];
    for (let v = c.min; v <= c.max + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
    return out;
  }
  return [];
};

const parseNumber = (raw: string) => (raw.trim() === '' ? Number.NaN : Number(raw));
const asNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : '';

export const SelectControl = ({ field, id, value, disabled, onChange }: ControlProps) => {
  const options = optionsFor(field.path);
  return (
    <select
      id={id}
      disabled={disabled}
      value={value === null ? '' : String(value)}
      onChange={(e) =>
        onChange(options.find((o) => (o === null ? '' : String(o)) === e.target.value) ?? null)
      }
    >
      {options.map((o) => (
        <option key={String(o)} value={o === null ? '' : String(o)}>
          {optionLabel(o)}
        </option>
      ))}
    </select>
  );
};

export const SegmentedControl = ({ field, id, value, onChange }: ControlProps) => (
  <div className="segmented">
    {optionsFor(field.path).map((o) => (
      <label key={String(o)}>
        <input type="radio" name={id} checked={value === o} onChange={() => onChange(o)} />
        <span>{optionLabel(o)}</span>
      </label>
    ))}
  </div>
);

export const SliderControl = (props: ControlProps) => {
  const { field, id, value, disabled, onChange } = props;
  const c = getFieldConstraints(field.path);
  const min = c.kind === 'number' ? c.min : undefined;
  const max = c.kind === 'number' ? c.max : undefined;
  if (min === undefined || max === undefined) return <NumberControl {...props} />;
  return (
    <div className="slider">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={field.step ?? 'any'}
        disabled={disabled}
        value={asNumber(value)}
        aria-valuetext={
          typeof value === 'number' ? `${value}${field.unit ? ` ${field.unit}` : ''}` : undefined
        }
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="readout">
        {typeof value === 'number' ? value : '—'}
        {field.unit ? ` ${field.unit}` : ''}
      </span>
    </div>
  );
};

export const NumberControl = ({ field, id, value, disabled, onChange }: ControlProps) => {
  const c = getFieldConstraints(field.path);
  return (
    <input
      id={id}
      type="number"
      disabled={disabled}
      min={c.kind === 'number' ? c.min : undefined}
      max={c.kind === 'number' ? c.max : undefined}
      step={field.step ?? 'any'}
      value={asNumber(value)}
      onChange={(e) => onChange(parseNumber(e.target.value))}
    />
  );
};

export const NullableNumberControl = ({
  field,
  id,
  value,
  codec,
  disabled,
  onChange,
}: ControlProps) => {
  const crf = field.path === 'output.crf';
  const range = crf ? crfRangeFor(codec) : null;
  const fallback = crf ? defaultCrfFor(codec) : null;
  return (
    <input
      id={id}
      type="number"
      disabled={disabled}
      min={range?.min}
      max={range?.max}
      step={field.step ?? 1}
      placeholder={crf ? `Codec default${fallback === null ? '' : ` (${fallback})`}` : 'Off'}
      value={typeof value === 'number' ? value : ''}
      onChange={(e) => onChange(e.target.value.trim() === '' ? null : Number(e.target.value))}
    />
  );
};

export const ToggleControl = ({ id, value, disabled, onChange }: ControlProps) => (
  <input
    id={id}
    type="checkbox"
    className="toggle"
    disabled={disabled}
    checked={Boolean(value)}
    onChange={(e) => onChange(e.target.checked)}
  />
);

const HEX = /^#[0-9a-f]{6}$/i;

export const ColorInput = ({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) => (
  <span className="color">
    <input
      type="color"
      aria-label={`${label} picker`}
      disabled={disabled}
      value={HEX.test(value) ? value : '#000000'}
      onChange={(e) => onChange(e.target.value.toUpperCase())}
    />
    <input
      id={id}
      type="text"
      disabled={disabled}
      value={value}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  </span>
);

export const ColorControl = ({ field, id, value, disabled, onChange }: ControlProps) => (
  <ColorInput
    id={id}
    label={field.label}
    value={typeof value === 'string' ? value : ''}
    disabled={disabled}
    onChange={onChange}
  />
);

export const TextControl = ({ id, value, disabled, onChange, catalog, field }: ControlProps) => (
  <>
    <input
      id={id}
      type="text"
      disabled={disabled}
      list={field.control === 'font' ? 'vc-fonts' : undefined}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
    />
    {field.control === 'font' ? (
      <datalist id="vc-fonts">
        {catalog.fonts.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    ) : null}
  </>
);

export const ConcurrencyControl = ({ id, value, disabled, onChange }: ControlProps) => (
  <input
    id={id}
    type="text"
    disabled={disabled}
    placeholder="Remotion default"
    value={value === null || value === undefined ? '' : String(value)}
    onChange={(e) => {
      const raw = e.target.value.trim();
      onChange(raw === '' ? null : /^\d+$/.test(raw) ? Number(raw) : raw);
    }}
  />
);

export const TrackControl = ({ id, value, disabled, catalog, onChange }: ControlProps) => (
  <select
    id={id}
    disabled={disabled}
    value={typeof value === 'string' ? value : ''}
    onChange={(e) => onChange(e.target.value || null)}
  >
    {value === null ? <option value="">None</option> : null}
    {catalog.musicTracks.map((t) => (
      <option key={t.id} value={t.id}>
        {t.label} ({t.mood})
      </option>
    ))}
  </select>
);

export const UploadControl = ({ id, value, disabled, onChange }: ControlProps) => {
  const [status, setStatus] = useState<string | null>(null);
  return (
    <div className="upload">
      <input
        id={id}
        type="file"
        accept="audio/*"
        disabled={disabled}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setStatus('Uploading…');
          try {
            const res = await api.upload('music', file);
            onChange(res.id);
            setStatus(`${res.name} uploaded`);
          } catch (error) {
            setStatus(errorMessage(error));
          }
        }}
      />
      <span className="muted small">
        {status ?? (typeof value === 'string' ? `Current: ${value}` : 'No file')}
      </span>
    </div>
  );
};

/** Ordered multi-select (image moves, presentations): the order is the cycle order. */
export const MultiSelectControl = ({ field, value, onChange, catalog }: ControlProps) => {
  const selected = Array.isArray(value) ? (value as string[]) : [];
  const c = getFieldConstraints(field.path);
  const all = c.kind === 'array' && c.options ? c.options.map(String) : [];
  const options =
    field.path === 'transitions.presentations'
      ? TRANSITION_NAMES.filter(
          (n) => catalog.exposedTransitions.includes(n) || selected.includes(n),
        )
      : all;
  return (
    <div className="multi">
      <div className="multi-options">
        {options.map((o) => {
          const checked = selected.includes(o);
          return (
            <label key={o}>
              <input
                type="checkbox"
                checked={checked}
                disabled={checked && selected.length === 1}
                onChange={() =>
                  onChange(checked ? selected.filter((s) => s !== o) : [...selected, o])
                }
              />
              <span>{optionLabel(o)}</span>
            </label>
          );
        })}
      </div>
      <p className="muted small">Order: {selected.map((s) => optionLabel(s)).join(' → ')}</p>
    </div>
  );
};

const defaultEasing = (type: Easing['type'], previous: Easing): Easing => {
  const direction = 'direction' in previous ? previous.direction : 'in-out';
  switch (type) {
    case 'linear':
      return { type };
    case 'bezier':
      return { type, x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
    case 'back':
      return { type, direction, overshoot: 1.70158 };
    case 'elastic':
      return { type, direction, bounciness: 1 };
    default:
      return { type, direction };
  }
};

export const EasingControl = ({ id, value, onChange }: ControlProps) => {
  const easing = value as Easing;
  const set = (patch: Record<string, unknown>) => onChange({ ...easing, ...patch });
  const num = (key: string, label: string, step = 0.01) => (
    <label className="inline">
      {label}
      <input
        type="number"
        step={step}
        value={asNumber((easing as Record<string, unknown>)[key])}
        onChange={(e) => set({ [key]: parseNumber(e.target.value) })}
      />
    </label>
  );
  return (
    <div className="easing">
      <div className="row">
        <label className="inline" htmlFor={`${id}-type`}>
          Type
        </label>
        <select
          id={`${id}-type`}
          value={easing.type}
          onChange={(e) => onChange(defaultEasing(e.target.value as Easing['type'], easing))}
        >
          {EASING_TYPES.map((t) => (
            <option key={t} value={t}>
              {optionLabel(t)}
            </option>
          ))}
        </select>
        {'direction' in easing ? (
          <select
            aria-label="Easing direction"
            value={easing.direction}
            onChange={(e) => set({ direction: e.target.value })}
          >
            {EASING_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {optionLabel(d)}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="row">
        {easing.type === 'back' ? num('overshoot', 'Overshoot') : null}
        {easing.type === 'elastic' ? num('bounciness', 'Bounciness') : null}
        {easing.type === 'bezier' ? (
          <>
            {num('x1', 'x1')}
            {num('y1', 'y1')}
            {num('x2', 'x2')}
            {num('y2', 'y2')}
          </>
        ) : null}
      </div>
      <EasingPreview easing={easing} />
    </div>
  );
};

const PALETTE_ROLES = ['Background', 'Second background', 'Accent', 'Text', 'Extra accent'];

export const PaletteControl = ({ id, value, onChange }: ControlProps) => {
  const colors = Array.isArray(value) ? (value as string[]) : [];
  return (
    <div className="palette">
      {PALETTE_ROLES.map((role, i) => (
        <div className="palette-row" key={role}>
          <label htmlFor={`${id}-${i}`}>{role}</label>
          <ColorInput
            id={`${id}-${i}`}
            label={role}
            value={colors[i] ?? ''}
            disabled={false}
            onChange={(v) => onChange(colors.map((c, j) => (j === i ? v : c)))}
          />
        </div>
      ))}
    </div>
  );
};

export const UvControl = ({ field, value, onChange }: ControlProps) => {
  const pair = Array.isArray(value) ? (value as number[]) : [0, 0];
  return (
    <div className="row">
      {(['x', 'y'] as const).map((axis, i) => (
        <label key={axis} className="inline">
          {axis}
          <input
            type="number"
            aria-label={`${field.label} ${axis}`}
            min={0}
            max={1}
            step={0.01}
            value={asNumber(pair[i])}
            onChange={(e) =>
              onChange(pair.map((v, j) => (j === i ? parseNumber(e.target.value) : v)))
            }
          />
        </label>
      ))}
    </div>
  );
};

/** Controls that render several inputs; their field is a fieldset named by its legend. */
export const GROUP_CONTROLS = new Set(['segmented', 'multi-select', 'easing', 'palette', 'uv']);

export const CONTROLS: Record<FieldMeta['control'], (props: ControlProps) => ReactNode> = {
  select: SelectControl,
  segmented: SegmentedControl,
  slider: SliderControl,
  number: NumberControl,
  toggle: ToggleControl,
  color: ColorControl,
  font: TextControl,
  text: TextControl,
  'multi-select': MultiSelectControl,
  easing: EasingControl,
  palette: PaletteControl,
  uv: UvControl,
  'nullable-number': NullableNumberControl,
  concurrency: ConcurrencyControl,
  track: TrackControl,
  upload: UploadControl,
};
