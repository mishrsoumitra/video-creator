import {
  ROLE_IDS,
  type CatalogProvider,
  type RoleId,
  type RoleSlot,
  type RoleTestResult,
  type SetupState,
} from '@vc/config';
import { useId, useState } from 'react';
import { api, errorMessage } from '../api';
import { useLoad } from '../hooks';

type RoleInfo = {
  title: string;
  blurb: string;
  providerChoice: string;
  offChoice?: string;
  local?: string;
};

const ROLE_INFO: Record<RoleId, RoleInfo> = {
  text: {
    title: 'Text',
    blurb: 'Writes the fact sheet and the script.',
    providerChoice: 'Use a text model',
  },
  search: {
    title: 'Web search',
    blurb: 'Fetches sources for the research stage.',
    providerChoice: 'Use a search provider',
    offChoice: "Off — I'll paste my own source text",
  },
  voice: {
    title: 'Voice',
    blurb: 'Narration audio.',
    providerChoice: 'Use a voice provider',
    offChoice: "I'll upload recordings",
    local: 'Use local (Kokoro, runs on this machine)',
  },
  align: {
    title: 'Word timing',
    blurb: 'Start and end time of every spoken word, for captions and scene cuts.',
    providerChoice: 'Use a word-timing provider',
    offChoice: "Use the voice's own timings",
    local: 'Use local (whisper.cpp, runs on this machine)',
  },
  vision: {
    title: 'Vision',
    blurb: 'Ranks candidate images; optional frame check at the end.',
    providerChoice: 'Use a vision model',
    offChoice: 'Off',
  },
};

type OptionProperty = {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
};

const optionEntries = (schema: Record<string, unknown> | undefined) => {
  const properties = (schema?.properties ?? {}) as Record<string, OptionProperty>;
  const required = new Set((schema?.required ?? []) as string[]);
  return Object.entries(properties).map(([name, prop]) => ({
    name,
    prop,
    required: required.has(name),
  }));
};

const humanize = (name: string) =>
  name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

const OptionInput = ({
  name,
  prop,
  required,
  value,
  onCommit,
}: {
  name: string;
  prop: OptionProperty;
  required: boolean;
  value: unknown;
  onCommit: (value: unknown) => void;
}) => {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const label = (
    <label htmlFor={id}>
      {humanize(name)}
      {required ? ' (required)' : ''}
    </label>
  );
  const current = value ?? prop.default;
  if (Array.isArray(prop.enum)) {
    return (
      <div className="option">
        {label}
        <select
          id={id}
          value={current === undefined ? '' : String(current)}
          required={required}
          onChange={(e) => onCommit(e.target.value === '' ? undefined : e.target.value)}
        >
          {required ? null : <option value="">Default</option>}
          {prop.enum.map((v) => (
            <option key={String(v)} value={String(v)}>
              {String(v)}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (prop.type === 'boolean') {
    return (
      <div className="option checkbox">
        <input
          id={id}
          type="checkbox"
          checked={Boolean(current)}
          onChange={(e) => onCommit(e.target.checked)}
        />
        {label}
      </div>
    );
  }
  const numeric = prop.type === 'number' || prop.type === 'integer';
  return (
    <div className="option">
      {label}
      <input
        id={id}
        type={numeric ? 'number' : 'text'}
        required={required}
        min={prop.minimum}
        max={prop.maximum}
        step={numeric ? 'any' : undefined}
        value={draft ?? (current === undefined ? '' : String(current))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return;
          const raw = draft.trim();
          setDraft(null);
          onCommit(raw === '' ? undefined : numeric ? Number(raw) : raw);
        }}
      />
    </div>
  );
};

const TestStatus = ({ result, slot }: { result: RoleTestResult | null; slot: RoleSlot }) => {
  if (result) {
    return result.ok ? (
      <p className="test ok">
        Passed — reached {result.model ?? 'the provider'} in {result.durationMs} ms. {result.detail}
      </p>
    ) : (
      <p className="test fail">Failed — {result.detail}</p>
    );
  }
  if (slot.test.status === 'passed')
    return <p className="test ok">Passed — reached {slot.test.model ?? 'the provider'}.</p>;
  if (slot.test.status === 'failed')
    return <p className="test fail">Failed — {slot.test.detail}</p>;
  return slot.mode === 'off' ? null : <p className="test muted">Not tested yet.</p>;
};

const RoleBlock = ({
  role,
  setup,
  providers,
  onSetupChange,
}: {
  role: RoleId;
  setup: SetupState;
  providers: CatalogProvider[];
  onSetupChange: (s: SetupState) => void;
}) => {
  const info = ROLE_INFO[role];
  const slot = setup.roles[role];
  const options = providers.filter((p) => p.roles[role]);
  const provider = options.find((p) => p.id === slot.providerId) ?? null;
  const roleInfo = provider?.roles[role];
  const id = useId();
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [result, setResult] = useState<RoleTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const credential = provider?.credential ?? null;
  const stored = credential ? setup.credentials.find((c) => c.id === credential.id) : undefined;
  const localProvider = options.find((p) => p.kind === 'local');
  const firstCloud = options.find((p) => p.kind === 'cloud');

  const save = async (body: Parameters<typeof api.putRole>[1]) => {
    setError(null);
    setResult(null);
    try {
      onSetupChange(await api.putRole(role, body));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const choose = (p: CatalogProvider | undefined) =>
    p
      ? save({
          mode: 'provider',
          providerId: p.id,
          model: p.roles[role]!.defaultModel,
          options: {},
        })
      : save({ mode: 'provider' });

  const saveKey = async () => {
    if (!credential || !key.trim()) return;
    setError(null);
    try {
      await api.putCredential(credential.id, key.trim());
      setKey('');
      setReplacing(false);
      onSetupChange(await api.getSetup());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const runTest = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.testRole(role));
      onSetupChange(await api.getSetup());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const commitOption = (name: string, value: unknown) => {
    if (!provider) return;
    const next = { ...slot.options };
    if (value === undefined) delete next[name];
    else next[name] = value;
    void save({
      mode: 'provider',
      providerId: provider.id,
      model: slot.model ?? roleInfo?.defaultModel,
      options: next,
    });
  };

  return (
    <section className="panel role" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{info.title}</h2>
      <p className="muted">{info.blurb}</p>

      {info.offChoice ? (
        <div className="choices" role="radiogroup" aria-label={`${info.title} mode`}>
          <label>
            <input
              type="radio"
              name={`${id}-mode`}
              checked={slot.mode === 'provider'}
              onChange={() => void (provider ? choose(provider) : save({ mode: 'provider' }))}
            />
            {info.providerChoice}
          </label>
          <label>
            <input
              type="radio"
              name={`${id}-mode`}
              checked={slot.mode === 'off'}
              onChange={() => void save({ mode: 'off' })}
            />
            {info.offChoice}
          </label>
        </div>
      ) : null}

      {slot.mode === 'provider' ? (
        <>
          {info.local && localProvider ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={provider?.kind === 'local'}
                onChange={(e) => void choose(e.target.checked ? localProvider : firstCloud)}
              />
              {info.local}
            </label>
          ) : null}
          <label htmlFor={`${id}-provider`}>Provider</label>
          <select
            id={`${id}-provider`}
            value={provider?.id ?? ''}
            onChange={(e) => void choose(options.find((p) => p.id === e.target.value))}
          >
            <option value="">Choose…</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {provider ? <p className="muted small">{provider.description}</p> : null}

          {provider && roleInfo ? (
            <>
              <label htmlFor={`${id}-model`}>Model</label>
              <input
                id={`${id}-model`}
                list={`${id}-models`}
                value={modelDraft ?? slot.model ?? roleInfo.defaultModel}
                onChange={(e) => setModelDraft(e.target.value)}
                onBlur={() => {
                  if (modelDraft === null) return;
                  const model = modelDraft.trim() || roleInfo.defaultModel;
                  setModelDraft(null);
                  if (model !== slot.model)
                    void save({
                      mode: 'provider',
                      providerId: provider.id,
                      model,
                      options: slot.options,
                    });
                }}
              />
              <datalist id={`${id}-models`}>
                {roleInfo.suggestedModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {optionEntries(roleInfo.optionsSchema).map(({ name, prop, required }) => (
                <OptionInput
                  key={`${provider.id}-${name}`}
                  name={name}
                  prop={prop}
                  required={required}
                  value={slot.options[name]}
                  onCommit={(v) => commitOption(name, v)}
                />
              ))}
            </>
          ) : null}

          {credential ? (
            stored && !replacing ? (
              <div className="credential">
                <p>{`Using your ${credential.label} ${stored.masked}`}</p>
                <button type="button" onClick={() => setReplacing(true)}>
                  Replace
                </button>
              </div>
            ) : (
              <div className="credential">
                <label htmlFor={`${id}-key`}>{credential.label}</label>
                <div className="row">
                  <input
                    id={`${id}-key`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                  <button type="button" onClick={() => void saveKey()} disabled={!key.trim()}>
                    Save key
                  </button>
                </div>
                <p className="muted small">
                  {credential.optional ? 'Optional: local servers usually need no key. ' : ''}
                  Stored only on this machine.{' '}
                  <a href={credential.helpUrl} target="_blank" rel="noreferrer">
                    Get a key
                  </a>
                </p>
              </div>
            )
          ) : null}

          <div className="row">
            <button type="button" onClick={() => void runTest()} disabled={!provider || busy}>
              {busy ? 'Testing…' : 'Test'}
            </button>
          </div>
        </>
      ) : null}

      <TestStatus result={result} slot={slot} />
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
};

/** First run: one provider per role, keys stored locally, every key proven by a test call. */
export const SetupScreen = ({
  setup,
  onSetupChange,
  onContinue,
}: {
  setup: SetupState;
  onSetupChange: (s: SetupState) => void;
  onContinue: () => void;
}) => {
  const providers = useLoad(api.getProviders);
  return (
    <div className="setup">
      <h1>Set up your AI providers</h1>
      <p className="muted">
        Pick a provider for each role and paste its key. One key can fill several roles. Keys stay
        on this machine and are only ever sent to the provider they belong to. Each role needs a
        passing test call before the first video.
      </p>
      {providers.status === 'loading' ? <p className="muted">Loading providers…</p> : null}
      {providers.status === 'error' ? (
        <p className="error">
          {providers.error}{' '}
          <button type="button" onClick={providers.reload}>
            Retry
          </button>
        </p>
      ) : null}
      {providers.status === 'ready'
        ? ROLE_IDS.map((role) => (
            <RoleBlock
              key={role}
              role={role}
              setup={setup}
              providers={providers.data}
              onSetupChange={onSetupChange}
            />
          ))
        : null}
      <footer className="panel setup-footer">
        {setup.complete ? (
          <p>Every required role has passed its test.</p>
        ) : (
          <ul className="missing">
            {setup.missing.map((m) => (
              <li key={m.role}>{m.reason}</li>
            ))}
          </ul>
        )}
        <button type="button" className="primary" disabled={!setup.complete} onClick={onContinue}>
          Continue
        </button>
      </footer>
    </div>
  );
};
