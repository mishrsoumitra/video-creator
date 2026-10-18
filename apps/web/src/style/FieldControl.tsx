import {
  getFieldDefault,
  type CatalogResponse,
  type Codec,
  type ConfigWarning,
  type FieldMeta,
} from '@vc/config';
import { memo } from 'react';
import { formatValue } from '../format';
import { CONTROLS, GROUP_CONTROLS } from './controls';

const fieldId = (path: string) => `field-${path.replace(/\./g, '-')}`;

const formatDefault = (field: FieldMeta, value: unknown) => {
  if (value === null && field.path === 'output.crf') return 'codec default';
  if (value === null && field.path === 'output.concurrency') return 'Remotion default';
  if (value === null && field.path === 'captions.breakOnSilenceAfterMilliseconds') return 'never';
  return `${formatValue(value)}${field.unit && typeof value === 'number' ? ` ${field.unit}` : ''}`;
};

export type FieldControlProps = {
  field: FieldMeta;
  value: unknown;
  /** Why the control is disabled for the current config, or null. */
  reason: string | null;
  /** Differs from the selected preset. */
  changed: boolean;
  error: string | undefined;
  warnings: readonly ConfigWarning[];
  codec: Codec;
  catalog: CatalogResponse;
  setField: (path: string, value: unknown) => void;
};

/** One config field: control, default, one-line note, and why it is disabled, changed, invalid or risky. */
export const FieldControl = memo(
  ({
    field,
    value,
    reason,
    changed,
    error,
    warnings,
    codec,
    catalog,
    setField,
  }: FieldControlProps) => {
    const id = fieldId(field.path);
    const Control = CONTROLS[field.control];
    const control = (
      <Control
        field={field}
        id={id}
        value={value}
        codec={codec}
        disabled={reason !== null}
        catalog={catalog}
        onChange={(v) => setField(field.path, v)}
      />
    );
    const details = (
      <>
        <p className="note">{field.note}</p>
        <p className="default">Default: {formatDefault(field, getFieldDefault(field.path))}</p>
        {reason ? <p className="reason">{reason}</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {warnings.map((w) => (
          <p key={w.id} className="warning">
            {w.message}
          </p>
        ))}
      </>
    );
    const badge = changed ? <span className="badge">Changed</span> : null;

    if (GROUP_CONTROLS.has(field.control)) {
      return (
        <fieldset
          className={`field${changed ? ' changed' : ''}`}
          data-testid={`field-${field.path}`}
          disabled={reason !== null}
        >
          <legend>{field.label}</legend>
          {badge}
          {control}
          {details}
        </fieldset>
      );
    }
    return (
      <div className={`field${changed ? ' changed' : ''}`} data-testid={`field-${field.path}`}>
        <div className="field-head">
          <label htmlFor={id}>{field.label}</label>
          {badge}
        </div>
        {control}
        {details}
      </div>
    );
  },
);
FieldControl.displayName = 'FieldControl';
