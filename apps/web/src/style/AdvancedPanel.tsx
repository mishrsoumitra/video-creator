import {
  FIELDS,
  GROUPS,
  SUBGROUP_LABELS,
  deepEqual,
  getAtPath,
  getDisabledReason,
  type CatalogResponse,
  type ConfigWarning,
  type FieldMeta,
  type GroupMeta,
} from '@vc/config';
import { Fragment, useState } from 'react';
import { ExpertEditor } from './ExpertEditor';
import { FieldControl } from './FieldControl';
import { SpringPreview } from './previews';
import type { StyleEditorModel } from './useStyleEditor';

type Props = {
  editor: StyleEditorModel;
  catalog: CatalogResponse;
  warnings: readonly ConfigWarning[];
};

const NONE: readonly ConfigWarning[] = [];

const warningsFor = (warnings: readonly ConfigWarning[], path: string) => {
  const mine = warnings.filter((w) => w.fields.includes(path));
  return mine.length === 0 ? NONE : mine;
};

const errorFor = (errors: Record<string, string>, path: string) =>
  Object.entries(errors).find(([p]) => p === path || p.startsWith(`${path}.`))?.[1];

const FieldGroup = ({ group, editor, catalog, warnings }: Props & { group: GroupMeta }) => {
  const fields = FIELDS.filter((f) => f.group === group.id);
  return (
    <fieldset className="group">
      <legend>{group.label}</legend>
      {fields.map((field: FieldMeta, i) => {
        const heading =
          field.subgroup && field.subgroup !== fields[i - 1]?.subgroup ? field.subgroup : null;
        return (
          <Fragment key={field.path}>
            {heading ? (
              <div className="subgroup-head">
                <h4>{SUBGROUP_LABELS[heading] ?? heading}</h4>
                {heading === 'spring' ? (
                  <SpringPreview config={editor.config.motion.spring} />
                ) : null}
              </div>
            ) : null}
            <FieldControl
              field={field}
              value={getAtPath(editor.config, field.path)}
              reason={getDisabledReason(field.path, editor.config)}
              changed={
                editor.baseline !== null &&
                !deepEqual(
                  getAtPath(editor.baseline, field.path),
                  getAtPath(editor.config, field.path),
                )
              }
              error={errorFor(editor.errors, field.path)}
              warnings={warningsFor(warnings, field.path)}
              codec={editor.config.output.codec}
              catalog={catalog}
              setField={editor.setField}
            />
          </Fragment>
        );
      })}
    </fieldset>
  );
};

/** Advanced: the full schema, grouped and collapsed by default; Output and Expert sit behind one more click. */
export const AdvancedPanel = (props: Props) => {
  const [open, setOpen] = useState(false);
  const [output, setOutput] = useState(false);
  return (
    <section className="advanced">
      <button
        type="button"
        className="disclosure"
        aria-expanded={open}
        aria-controls="advanced-panel"
        onClick={() => setOpen((v) => !v)}
      >
        Advanced
      </button>
      {open ? (
        <div id="advanced-panel" className="advanced-body">
          {GROUPS.filter((g) => g.tier === 'advanced').map((group) => (
            <FieldGroup key={group.id} group={group} {...props} />
          ))}
          <button
            type="button"
            className="disclosure"
            aria-expanded={output}
            aria-controls="output-expert"
            onClick={() => setOutput((v) => !v)}
          >
            {output ? 'Hide output & expert' : 'Show output & expert'}
          </button>
          {output ? (
            <div id="output-expert">
              {GROUPS.filter((g) => g.tier === 'output').map((group) => (
                <FieldGroup key={group.id} group={group} {...props} />
              ))}
              <ExpertEditor editor={props.editor} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};
