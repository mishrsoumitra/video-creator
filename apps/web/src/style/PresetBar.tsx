import { validatePresetName, type Preset } from '@vc/config';
import { useId, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import type { StyleEditorModel } from './useStyleEditor';

/** Named looks that set many fields at once; users can save their own ("my channel look"). */
export const PresetBar = ({
  editor,
  presets,
  onPresetsChange,
}: {
  editor: StyleEditorModel;
  presets: readonly Preset[];
  onPresetsChange: (presets: Preset[]) => void;
}) => {
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const problem = validatePresetName(
      name,
      presets.filter((p) => !p.builtIn).map((p) => p.name),
    );
    if (problem) return setError(problem);
    try {
      const preset = await api.createPreset({ name: name.trim(), config: editor.validConfig });
      onPresetsChange([...presets, preset]);
      editor.selectPreset(preset);
      setSaving(false);
      setName('');
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="presets">
      <div role="group" aria-label="Style presets" className="preset-list">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            className="preset"
            aria-pressed={editor.presetId === p.id}
            title={p.description}
            onClick={() => editor.selectPreset(p)}
          >
            {p.name}
          </button>
        ))}
        <button type="button" className="link" onClick={() => setSaving((v) => !v)}>
          Save as preset
        </button>
      </div>
      {saving ? (
        <form className="row save-preset" onSubmit={save}>
          <label htmlFor={`${id}-name`}>Preset name</label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit">Save preset</button>
          {error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
};
