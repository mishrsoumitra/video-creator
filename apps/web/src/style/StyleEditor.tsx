import { getWarnings, type CatalogResponse, type ConfigWarning, type Preset } from '@vc/config';
import { useMemo } from 'react';
import { AdvancedPanel } from './AdvancedPanel';
import { PresetBar } from './PresetBar';
import { SimplePickers } from './SimplePickers';
import type { StyleEditorModel } from './useStyleEditor';

const Warnings = ({ warnings }: { warnings: readonly ConfigWarning[] }) =>
  warnings.length === 0 ? null : (
    <section className="warnings" aria-label="Warnings">
      <h3>Worth a second look</h3>
      <ul>
        {warnings.map((w) => (
          <li key={w.id}>{w.message}</li>
        ))}
      </ul>
      <p className="muted small">Warnings never block a render.</p>
    </section>
  );

/** The three layers of the style UI: simple pickers, presets, and the Advanced panel. */
export const StyleEditor = ({
  editor,
  catalog,
  presets,
  onPresetsChange,
}: {
  editor: StyleEditorModel;
  catalog: CatalogResponse;
  presets: readonly Preset[];
  onPresetsChange: (presets: Preset[]) => void;
}) => {
  const warnings = useMemo(
    () => getWarnings(editor.validConfig, { timedTransitions: editor.timedTransitions }),
    [editor.validConfig, editor.timedTransitions],
  );
  return (
    <div className="style-editor">
      <SimplePickers editor={editor} />
      <PresetBar editor={editor} presets={presets} onPresetsChange={onPresetsChange} />
      {editor.undo ? (
        <div role="status" className="notice">
          Reset {editor.undo.count} custom setting{editor.undo.count === 1 ? '' : 's'} —{' '}
          <button type="button" className="link" onClick={editor.undoReset}>
            Undo
          </button>
          <button type="button" className="link" aria-label="Dismiss" onClick={editor.dismissUndo}>
            ×
          </button>
        </div>
      ) : null}
      {!editor.isValid ? (
        <p className="error">Some settings are invalid; fix the highlighted fields.</p>
      ) : null}
      <Warnings warnings={warnings} />
      <AdvancedPanel editor={editor} catalog={catalog} warnings={warnings} />
    </div>
  );
};
