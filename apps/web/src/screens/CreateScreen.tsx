import {
  DEFAULT_PRESET_ID,
  LENGTH_PRESETS_SECONDS,
  initialConfig,
  type CatalogResponse,
  type FieldError,
  type Preset,
  type Settings,
  type UploadResponse,
} from '@vc/config';
import { useId, useState, type FormEvent } from 'react';
import { ApiRequestError, api, errorMessage } from '../api';
import { EstimatePanel } from '../components/EstimatePanel';
import { formatDuration } from '../format';
import { useLoad } from '../hooks';
import { navigate } from '../router';
import { StyleEditor } from '../style/StyleEditor';
import { useStyleEditor } from '../style/useStyleEditor';

const lengthLabel = (seconds: number) => formatDuration(seconds);

const topicValid = (topic: string) => topic.trim().length >= 3 && topic.trim().length <= 200;

type CreateData = { presets: Preset[]; catalog: CatalogResponse; settings: Settings };

const CreateForm = ({
  data,
  setupComplete,
  estimateDelayMs,
}: {
  data: CreateData;
  setupComplete: boolean;
  estimateDelayMs: number;
}) => {
  const id = useId();
  const [presets, setPresets] = useState(data.presets);
  const start =
    data.presets.find((p) => p.id === data.settings.defaultPresetId) ??
    data.presets.find((p) => p.id === DEFAULT_PRESET_ID) ??
    null;
  const editor = useStyleEditor({
    initial: start ? structuredClone(start.config) : initialConfig(),
    presetId: start?.id ?? null,
    presets,
    timedTransitions: data.catalog.timedTransitions,
    defaultTrackId: data.catalog.musicTracks[0]?.id,
  });
  const [topic, setTopic] = useState('');
  const [lengthSeconds, setLengthSeconds] = useState(60);
  const [sourceText, setSourceText] = useState('');
  const [recording, setRecording] = useState<UploadResponse | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; fields: FieldError[] } | null>(null);

  const canGenerate = setupComplete && topicValid(topic) && editor.isValid && !submitting;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploadStatus('Uploading…');
    try {
      setRecording(await api.upload('recording', file));
      setUploadStatus(null);
    } catch (e) {
      setUploadStatus(errorMessage(e));
    }
  };

  const generate = async (event: FormEvent) => {
    event.preventDefault();
    if (!canGenerate) return;
    setSubmitting(true);
    setError(null);
    try {
      const job = await api.createJob({
        topic: topic.trim(),
        lengthSeconds,
        config: editor.validConfig,
        ...(sourceText.trim() ? { sourceText } : {}),
        ...(recording ? { recordingUploadId: recording.id } : {}),
      });
      navigate(`/jobs/${encodeURIComponent(job.id)}`);
    } catch (e) {
      setError({ message: errorMessage(e), fields: e instanceof ApiRequestError ? e.fields : [] });
      setSubmitting(false);
    }
  };

  return (
    <form className="create" onSubmit={generate}>
      <section className="panel basics">
        <label htmlFor={`${id}-topic`}>Topic</label>
        <input
          id={`${id}-topic`}
          className="topic"
          placeholder="e.g. How the Apollo program reached the Moon"
          value={topic}
          maxLength={200}
          onChange={(e) => setTopic(e.target.value)}
        />
        <fieldset className="lengths">
          <legend>Length</legend>
          <div className="segmented">
            {LENGTH_PRESETS_SECONDS.map((s) => (
              <label key={s}>
                <input
                  type="radio"
                  name={`${id}-length`}
                  value={s}
                  checked={lengthSeconds === s}
                  onChange={() => setLengthSeconds(s)}
                />
                <span>{lengthLabel(s)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="panel">
        <h2>Style</h2>
        <StyleEditor
          editor={editor}
          catalog={data.catalog}
          presets={presets}
          onPresetsChange={setPresets}
        />
      </section>

      <section className="panel sources">
        <h2>Your own sources</h2>
        <label htmlFor={`${id}-sources`}>Paste your own source text (optional)</label>
        <textarea
          id={`${id}-sources`}
          rows={5}
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          placeholder="Research is skipped when you paste sources."
        />
        <label htmlFor={`${id}-recording`}>Your own recording (optional)</label>
        <input
          id={`${id}-recording`}
          type="file"
          accept="audio/*"
          onChange={(e) => void upload(e.target.files?.[0])}
        />
        {recording ? (
          <p className="muted small">
            Using {recording.name} ({formatDuration(recording.durationMs / 1000)}); no TTS needed.{' '}
            <button type="button" className="link" onClick={() => setRecording(null)}>
              Remove
            </button>
          </p>
        ) : null}
        {uploadStatus ? <p className="muted small">{uploadStatus}</p> : null}
      </section>

      <section className="panel generate">
        <EstimatePanel
          lengthSeconds={lengthSeconds}
          config={editor.validConfig}
          sourceTextProvided={sourceText.trim().length > 0}
          recordingProvided={recording !== null}
          delayMs={estimateDelayMs}
        />
        {error ? (
          <div role="alert" className="error">
            <p>{error.message}</p>
            {error.fields.length > 0 ? (
              <ul>
                {error.fields.map((f) => (
                  <li key={`${f.path}-${f.message}`}>
                    {f.path}: {f.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <button type="submit" className="primary large" disabled={!canGenerate}>
          {submitting ? 'Starting…' : 'Generate'}
        </button>
        {!setupComplete ? <p className="muted small">Finish provider setup first.</p> : null}
      </section>
    </form>
  );
};

export const CreateScreen = ({
  setupComplete,
  estimateDelayMs = 400,
}: {
  setupComplete: boolean;
  estimateDelayMs?: number;
}) => {
  const data = useLoad(async (): Promise<CreateData> => {
    const [presets, catalog, settings] = await Promise.all([
      api.getPresets(),
      api.getCatalog(),
      api.getSettings(),
    ]);
    return { presets, catalog, settings };
  });
  return (
    <div className="create-screen">
      <h1>Create a video</h1>
      {data.status === 'loading' ? <p className="muted">Loading…</p> : null}
      {data.status === 'error' ? (
        <>
          <p className="error">{data.error}</p>
          <button type="button" onClick={data.reload}>
            Retry
          </button>
        </>
      ) : null}
      {data.status === 'ready' ? (
        <CreateForm
          data={data.data}
          setupComplete={setupComplete}
          estimateDelayMs={estimateDelayMs}
        />
      ) : null}
    </div>
  );
};
