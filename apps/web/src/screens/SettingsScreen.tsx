import type { CredentialSummary, Preset, Settings, SetupState, UnitPricesSchema } from '@vc/config';
import type { z } from 'zod';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, errorMessage, type RenderStats } from '../api';
import { formatUsd } from '../format';
import { useLoad } from '../hooks';
import { Link } from '../router';

type UnitPrices = z.output<typeof UnitPricesSchema>;
type SettingsData = { settings: Settings; presets: Preset[]; stats: RenderStats | null };

const CredentialRow = ({
  credential,
  onChanged,
}: {
  credential: CredentialSummary;
  onChanged: () => Promise<void>;
}) => {
  const id = useId();
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const replace = async () => {
    try {
      await api.putCredential(credential.id, key.trim());
      setKey('');
      setReplacing(false);
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const remove = async () => {
    try {
      await api.deleteCredential(credential.id);
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <li aria-label={credential.label} className="credential-row">
      <span>{credential.label}</span>
      <code>{credential.masked}</code>
      {replacing ? (
        <span className="row">
          <label htmlFor={`${id}-key`} className="visually-hidden">
            New {credential.label}
          </label>
          <input
            id={`${id}-key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button type="button" disabled={!key.trim()} onClick={() => void replace()}>
            Save key
          </button>
        </span>
      ) : (
        <span className="row">
          <button type="button" onClick={() => setReplacing(true)}>
            Replace
          </button>
          <button type="button" className="danger" onClick={() => void remove()}>
            Delete
          </button>
        </span>
      )}
      {error ? <span className="error">{error}</span> : null}
    </li>
  );
};

const PRICE_FIELDS: Array<[keyof UnitPrices, string]> = [
  ['inputPerMTok', 'Input $ per 1M tokens'],
  ['outputPerMTok', 'Output $ per 1M tokens'],
  ['perSearch', '$ per search'],
  ['perMChars', '$ per 1M characters'],
  ['perAudioMinute', '$ per audio minute'],
  ['perImage', '$ per image'],
];

const PricingOverrides = ({
  settings,
  save,
}: {
  settings: Settings;
  save: (patch: Partial<Settings>) => Promise<void>;
}) => {
  const id = useId();
  const [key, setKey] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const add = async (event: FormEvent) => {
    event.preventDefault();
    const prices: Record<string, number> = {};
    for (const [field] of PRICE_FIELDS) {
      const raw = values[field]?.trim();
      if (raw) prices[field] = Number(raw);
    }
    if (!key.includes('/') || Object.keys(prices).length === 0) return;
    await save({ pricingOverrides: { ...settings.pricingOverrides, [key.trim()]: prices } });
    setKey('');
    setValues({});
  };
  const remove = (k: string) => {
    const next = { ...settings.pricingOverrides };
    delete next[k];
    void save({ pricingOverrides: next });
  };
  return (
    <section className="panel" aria-label="Pricing overrides">
      <h2>Pricing overrides</h2>
      <p className="muted">
        Replace the built-in price table for a provider and model, e.g. when your plan has different
        rates.
      </p>
      {Object.keys(settings.pricingOverrides).length > 0 ? (
        <ul>
          {Object.entries(settings.pricingOverrides).map(([k, p]) => (
            <li key={k}>
              <code>{k}</code>{' '}
              {PRICE_FIELDS.filter(([f]) => p[f] !== undefined)
                .map(([f, label]) => `${label}: ${p[f]}`)
                .join(', ')}{' '}
              <button type="button" className="link" onClick={() => remove(k)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="grid-form" onSubmit={(e) => void add(e)}>
        <label htmlFor={`${id}-key`}>Provider / model</label>
        <input
          id={`${id}-key`}
          placeholder="openai/gpt-6.1-sol"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        {PRICE_FIELDS.map(([field, label]) => (
          <span key={field} className="contents">
            <label htmlFor={`${id}-${field}`}>{label}</label>
            <input
              id={`${id}-${field}`}
              type="number"
              min={0}
              step="any"
              value={values[field] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
            />
          </span>
        ))}
        <button type="submit">Add override</button>
      </form>
    </section>
  );
};

type SettingsProps = { setup: SetupState; onSetupChange: (s: SetupState) => void; pollMs?: number };

const SettingsForm = ({
  data,
  setup,
  onSetupChange,
  pollMs,
}: SettingsProps & { data: SettingsData; pollMs: number }) => {
  const id = useId();
  const [settings, setSettings] = useState(data.settings);
  const [presets, setPresets] = useState(data.presets);
  const [stats, setStats] = useState(data.stats);
  const [cap, setCap] = useState(String(data.settings.costCapUsd));
  const [message, setMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const calibrating = starting || (stats?.calibrating ?? false);

  useEffect(() => {
    if (!stats?.calibrating) return;
    let alive = true;
    const timer = setTimeout(() => {
      api.getRenderStats().then(
        (next) => alive && setStats(next),
        () => alive && setStats({ ...stats }),
      );
    }, pollMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [stats, pollMs]);

  const save = async (patch: Partial<Settings>) => {
    const previous = settings;
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await api.putSettings(next);
      setMessage('Saved.');
    } catch (e) {
      setSettings(previous);
      setMessage(errorMessage(e));
    }
  };
  const capValue = Number(cap);
  const capValid =
    cap.trim() !== '' && Number.isFinite(capValue) && capValue >= 0 && capValue <= 1000;
  const refreshSetup = async () => onSetupChange(await api.getSetup());
  const calibrate = async () => {
    setStarting(true);
    try {
      await api.calibrate();
      setStats(await api.getRenderStats());
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="settings">
      <h1>Settings</h1>
      {message ? (
        <p className="muted" aria-live="polite">
          {message}
        </p>
      ) : null}

      <section className="panel" aria-label="API keys">
        <h2>AI providers and keys</h2>
        <p className="muted">
          {setup.vault.backend === 'memory'
            ? 'Keys are kept in memory only and forgotten when the server stops.'
            : `Keys are stored only on this machine (${setup.vault.backend === 'keychain' ? 'system keychain' : 'encrypted file'}).`}{' '}
          Only the last four characters are shown.
        </p>
        <ul className="credentials">
          {setup.credentials.map((c) => (
            <CredentialRow key={c.id} credential={c} onChanged={refreshSetup} />
          ))}
        </ul>
        <Link to="/setup">Change AI providers</Link>
      </section>

      <section className="panel" aria-label="Spending">
        <h2>Spending</h2>
        <label htmlFor={`${id}-cap`}>Per-job cost cap (USD)</label>
        <div className="row">
          <input
            id={`${id}-cap`}
            type="number"
            min={0}
            max={1000}
            step="0.5"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
          <button
            type="button"
            onClick={() => void save({ costCapUsd: capValue })}
            disabled={!capValid}
          >
            Save cost cap
          </button>
        </div>
        <p className="muted small">
          A job stops before an AI call would take it past {formatUsd(settings.costCapUsd)};
          optional calls are skipped instead.
        </p>
      </section>

      <section className="panel" aria-label="Vision">
        <h2>Vision</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.visionRankAlways}
            onChange={(e) => void save({ visionRankAlways: e.target.checked })}
          />
          Rank every scene&apos;s images with the vision model (otherwise only when the
          deterministic score is low)
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.visionFinalCheck}
            onChange={(e) => void save({ visionFinalCheck: e.target.checked })}
          />
          Vision frame check after rendering (12-frame contact sheet; off by default)
        </label>
      </section>

      <PricingOverrides settings={settings} save={save} />

      <section className="panel" aria-label="Your presets">
        <h2>Your presets</h2>
        {presets.filter((p) => !p.builtIn).length === 0 ? (
          <p className="muted">Save a look from the Create screen to reuse it here.</p>
        ) : null}
        <ul>
          {presets
            .filter((p) => !p.builtIn)
            .map((p) => (
              <li key={p.id}>
                {p.name}{' '}
                <button
                  type="button"
                  className="danger"
                  aria-label={`Delete ${p.name}`}
                  onClick={async () => {
                    try {
                      await api.deletePreset(p.id);
                      setPresets((list) => list.filter((x) => x.id !== p.id));
                    } catch (e) {
                      setMessage(errorMessage(e));
                    }
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
        </ul>
      </section>

      <section className="panel" aria-label="Default style">
        <h2>Default style</h2>
        <label htmlFor={`${id}-default`}>Default style for new videos</label>
        <select
          id={`${id}-default`}
          value={settings.defaultPresetId}
          onChange={(e) => void save({ defaultPresetId: e.target.value })}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </section>

      <section className="panel" aria-label="Render estimates">
        <h2>Render estimates</h2>
        {stats && stats.sampleCount > 0 ? (
          <p>
            Based on {stats.sampleCount} measured renders.{' '}
            {stats.timedTransitions.length > 0
              ? `Timed transitions: ${stats.timedTransitions.join(', ')}.`
              : ''}
          </p>
        ) : (
          <p className="muted">
            No renders measured yet. Calibrating renders short test clips to time each effect and
            the shader transitions.
          </p>
        )}
        {calibrating ? (
          <p className="muted small">
            Calibration runs in the background; you can leave this page.
          </p>
        ) : null}
        <button type="button" onClick={() => void calibrate()} disabled={calibrating}>
          {calibrating ? 'Calibrating…' : 'Calibrate render estimates'}
        </button>
      </section>
    </div>
  );
};

export const SettingsScreen = ({ setup, onSetupChange, pollMs = 2000 }: SettingsProps) => {
  const data = useLoad(async (): Promise<SettingsData> => {
    const [settings, presets, stats] = await Promise.all([
      api.getSettings(),
      api.getPresets(),
      api.getRenderStats().catch(() => null),
    ]);
    return { settings, presets, stats };
  });
  if (data.status === 'loading') return <p className="muted">Loading…</p>;
  if (data.status === 'error') {
    return (
      <div>
        <h1>Settings</h1>
        <p className="error">{data.error}</p>
        <button type="button" onClick={data.reload}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <SettingsForm data={data.data} setup={setup} onSetupChange={onSetupChange} pollMs={pollMs} />
  );
};
