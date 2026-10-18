import type { AiCallView, CheckView, ImageDecisionView, StageState } from '@vc/config';
import { formatUnits, formatUsd, roleLabel, stageLabel } from '../format';

const CALL_STATUS: Record<AiCallView['status'], string> = {
  ok: 'OK',
  error: 'Error',
  'skipped-cap': 'Skipped (cost cap)',
  'skipped-limit': 'Skipped (call limit)',
};

/** Every provider call, which stage asked for it and why the deterministic path was not enough. */
export const AiUsageTable = ({ calls }: { calls: readonly AiCallView[] }) => (
  <table className="data">
    <caption>Where AI was used</caption>
    <thead>
      <tr>
        <th scope="col">Stage</th>
        <th scope="col">Role</th>
        <th scope="col">Provider / model</th>
        <th scope="col">Reason</th>
        <th scope="col">Units</th>
        <th scope="col">Cost</th>
        <th scope="col">Status</th>
      </tr>
    </thead>
    <tbody>
      {calls.length === 0 ? (
        <tr>
          <td colSpan={7} className="muted">
            No provider calls yet.
          </td>
        </tr>
      ) : (
        calls.map((c) => (
          <tr key={c.id} className={c.ai ? undefined : 'not-ai'}>
            <td>{stageLabel(c.stage)}</td>
            <td>
              {roleLabel(c.role)}
              {c.ai ? null : <span className="badge">not AI</span>}
            </td>
            <td>
              {c.providerId} / {c.model}
            </td>
            <td>{c.reason}</td>
            <td>{formatUnits(c.units)}</td>
            <td>{c.priced ? formatUsd(c.costUsd, true) : 'unpriced'}</td>
            <td>
              {CALL_STATUS[c.status]}
              {c.error ? <span className="muted small"> {c.error}</span> : null}
            </td>
          </tr>
        ))
      )}
    </tbody>
  </table>
);

const METHOD: Record<ImageDecisionView['method'], string> = {
  deterministic: 'Deterministic',
  vision: 'Vision ranked',
  fallback: 'Typographic fallback',
};

export const ImageDecisionsTable = ({ decisions }: { decisions: readonly ImageDecisionView[] }) =>
  decisions.length === 0 ? null : (
    <table className="data">
      <caption>Images</caption>
      <thead>
        <tr>
          <th scope="col">Scene</th>
          <th scope="col">Query</th>
          <th scope="col">Method</th>
          <th scope="col">Best score</th>
          <th scope="col">Why</th>
        </tr>
      </thead>
      <tbody>
        {decisions.map((d) => (
          <tr key={d.sceneIndex}>
            <td>{d.sceneIndex + 1}</td>
            <td>{d.query}</td>
            <td>{METHOD[d.method]}</td>
            <td>{d.bestScore === null ? '—' : d.bestScore.toFixed(2)}</td>
            <td>{d.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

const STAGE_STATUS: Record<StageState['status'], string> = {
  pending: 'Waiting',
  running: 'Running',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
};

export const StageList = ({ stages }: { stages: readonly StageState[] }) => (
  <ol className="stages" aria-label="Stages">
    {stages.map((s) => (
      <li key={s.stage} className={`stage ${s.status}`}>
        <span className="stage-name">{stageLabel(s.stage)}</span>
        <span className="stage-status">{STAGE_STATUS[s.status]}</span>
        {s.detail ? <span className="muted small">{s.detail}</span> : null}
      </li>
    ))}
  </ol>
);

const CHECK_STATUS: Record<CheckView['status'], string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Fail',
  skipped: 'Skipped',
};

export const CheckList = ({ checks }: { checks: readonly CheckView[] }) => (
  <ul className="checks" aria-label="Checks">
    {checks.map((c) => (
      <li key={c.id} className={`check ${c.status}`}>
        <span className="check-status">{CHECK_STATUS[c.status]}</span>
        <span className="check-label">{c.label}</span>
        <span className="muted small">{c.detail}</span>
      </li>
    ))}
  </ul>
);
