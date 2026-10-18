import { parseExpertJson, stringifyConfig, type FieldError } from '@vc/config';
import { useState } from 'react';
import type { StyleEditorModel } from './useStyleEditor';

/** Expert: the whole config as raw JSON, validated against the schema before it is accepted. */
export const ExpertEditor = ({ editor }: { editor: StyleEditorModel }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const text = draft ?? stringifyConfig(editor.validConfig);

  const apply = () => {
    const result = parseExpertJson(text);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    setDraft(null);
    editor.replaceConfig(result.config);
  };

  return (
    <section className="expert">
      <h3>
        <label htmlFor="expert-json">Expert JSON</label>
      </h3>
      <p className="note">The whole config. Changes apply only after they pass the schema.</p>
      <textarea
        id="expert-json"
        rows={18}
        spellCheck={false}
        value={text}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="row">
        <button type="button" onClick={apply}>
          Apply JSON
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(null);
            setErrors([]);
          }}
          disabled={draft === null}
        >
          Discard edits
        </button>
      </div>
      {errors.length > 0 ? (
        <div role="alert" className="error">
          <ul>
            {errors.map((e, i) => (
              <li key={i}>
                {e.path ? <code>{e.path}</code> : 'JSON'}: {e.message}
                {e.line ? ` (line ${e.line}, column ${e.column ?? 1})` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
};
