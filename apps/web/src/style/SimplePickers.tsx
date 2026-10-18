import {
  ANIMATION_KINDS,
  ASPECTS,
  BACKDROP_KINDS,
  CAPTION_STYLES,
  MAX_SPEED,
  MIN_SPEED,
  getField,
  type AnimationKind,
  type BackdropKind,
  type CaptionStyle,
} from '@vc/config';
import { useId } from 'react';
import { formatSpeed, optionLabel } from '../format';
import type { StyleEditorModel } from './useStyleEditor';

const Select = <T extends string>({
  id,
  label,
  note,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  note: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) => (
  <div className="picker">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {optionLabel(o)}
        </option>
      ))}
    </select>
    <p className="note">{note}</p>
  </div>
);

/** The five simple controls; each applies a bundle of settings. */
export const SimplePickers = ({ editor }: { editor: StyleEditorModel }) => {
  const id = useId();
  const { simple } = editor.config;
  const meta = (path: string) => getField(path);
  return (
    <div className="pickers">
      <Select<AnimationKind>
        id={`${id}-animation`}
        label={meta('simple.animationKind').label}
        note={meta('simple.animationKind').note}
        value={simple.animationKind}
        options={ANIMATION_KINDS}
        onChange={(value) => editor.applyPicker({ kind: 'animationKind', value })}
      />
      <Select<BackdropKind>
        id={`${id}-backdrop`}
        label={meta('simple.backdropKind').label}
        note={meta('simple.backdropKind').note}
        value={simple.backdropKind}
        options={BACKDROP_KINDS}
        onChange={(value) => editor.applyPicker({ kind: 'backdropKind', value })}
      />
      <div className="picker">
        <label htmlFor={`${id}-speed`}>{meta('simple.animationSpeed').label}</label>
        <div className="slider">
          <input
            id={`${id}-speed`}
            type="range"
            min={MIN_SPEED}
            max={MAX_SPEED}
            step={0.05}
            value={simple.animationSpeed}
            aria-valuetext={formatSpeed(simple.animationSpeed)}
            onChange={(e) => editor.applyPicker({ kind: 'speed', value: Number(e.target.value) })}
          />
          <span className="readout">{formatSpeed(simple.animationSpeed)}</span>
        </div>
        <p className="note">{meta('simple.animationSpeed').note}</p>
      </div>
      <Select<CaptionStyle>
        id={`${id}-captions`}
        label={meta('simple.captionStyle').label}
        note={meta('simple.captionStyle').note}
        value={simple.captionStyle}
        options={CAPTION_STYLES}
        onChange={(value) => editor.applyPicker({ kind: 'captionStyle', value })}
      />
      <fieldset className="picker">
        <legend>{meta('simple.aspect').label}</legend>
        <div className="segmented">
          {ASPECTS.map((aspect) => (
            <label key={aspect}>
              <input
                type="radio"
                name={`${id}-aspect`}
                checked={simple.aspect === aspect}
                onChange={() => editor.applyPicker({ kind: 'aspect', value: aspect })}
              />
              <span>{aspect}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
};
