import type { JobDetail, JobEvent } from '@vc/config';
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { api, connectJobEvents, errorMessage } from '../api';
import { AiUsageTable, CheckList, ImageDecisionsTable, StageList } from '../components/JobTables';
import { formatDuration, formatUsd, statusLabel } from '../format';

// The Remotion player and composition load only when a job reaches review.
const ReviewSection = lazy(() =>
  import('./ReviewSection').then((m) => ({ default: m.ReviewSection })),
);

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

const Outputs = ({ job }: { job: JobDetail }) => (
  <section className="panel outputs" aria-label="Outputs">
    <h2>Your video</h2>
    <div className="row">
      {job.outputs.video ? (
        <a className="button primary" href={job.outputs.video} download>
          Download video
        </a>
      ) : null}
      {job.outputs.srt ? (
        <a className="button" href={job.outputs.srt} download>
          Captions (.srt)
        </a>
      ) : null}
      {job.outputs.credits ? (
        <a className="button" href={job.outputs.credits} download>
          Credits
        </a>
      ) : null}
      {job.outputs.contactSheet ? (
        <a className="button" href={job.outputs.contactSheet}>
          Contact sheet
        </a>
      ) : null}
    </div>
    {job.render.elapsedMs !== null ? (
      <p className="muted">Rendered in {formatDuration(job.render.elapsedMs / 1000)}.</p>
    ) : null}
    {job.checks.length > 0 ? (
      <>
        <h3>Final checks</h3>
        <CheckList checks={job.checks} />
      </>
    ) : null}
  </section>
);

export const JobScreen = ({
  id,
  pollMs = 2000,
  estimateDelayMs,
}: {
  id: string;
  pollMs?: number;
  estimateDelayMs?: number;
}) => {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [streaming, setStreaming] = useState(true);

  const refresh = useCallback(() => {
    api.getJob(id).then(
      (j) => {
        setJob(j);
        setError(null);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  }, [id]);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    const stop = connectJobEvents(
      id,
      (event: JobEvent) => {
        setStreaming(true);
        if (event.type === 'job') {
          setJob(event.job);
          setProgress(null);
        } else if (event.type === 'progress' && event.stage === 'render') {
          setProgress(event.progress);
        }
      },
      () => setStreaming(false),
    );
    if (!stop) {
      queueMicrotask(() => setStreaming(false));
      return;
    }
    return stop;
  }, [id]);

  const terminal = job ? TERMINAL.has(job.status) : false;
  useEffect(() => {
    if (streaming || terminal) return;
    const timer = setInterval(refresh, pollMs);
    return () => clearInterval(timer);
  }, [streaming, terminal, refresh, pollMs]);

  if (!job) {
    return error ? (
      <div>
        <p className="error">{error}</p>
        <button type="button" onClick={refresh}>
          Retry
        </button>
      </div>
    ) : (
      <p className="muted">Loading…</p>
    );
  }

  const renderProgress = progress ?? job.render.progress ?? 0;
  return (
    <article className="job">
      <header className="job-head">
        <h1>{job.topic}</h1>
        <span className={`status ${job.status}`}>{statusLabel(job.status)}</span>
      </header>
      {job.error ? (
        <p role="alert" className="error">
          {job.error.stage ? `${job.error.stage}: ` : ''}
          {job.error.message}
        </p>
      ) : null}
      {job.status === 'rendering' ? (
        <div
          className="progress"
          role="progressbar"
          aria-label="Render progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(renderProgress * 100)}
        >
          <div className="progress-bar" style={{ width: `${Math.round(renderProgress * 100)}%` }} />
        </div>
      ) : null}

      <div className="job-grid">
        <section className="panel" aria-label="Progress">
          <h2>Stages</h2>
          <StageList stages={job.stages} />
          {job.warnings.length > 0 ? (
            <>
              <h3>Warnings</h3>
              <ul className="warnings-list">
                {job.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
        <section className="panel" aria-label="Cost">
          <h2>Cost</h2>
          <dl className="facts">
            <dt>Estimated before Generate</dt>
            <dd>{job.cost.estimatedUsd === null ? '—' : formatUsd(job.cost.estimatedUsd, true)}</dd>
            <dt>Actual</dt>
            <dd>{formatUsd(job.cost.actualUsd, true)}</dd>
            <dt>Per-job cap</dt>
            <dd>{formatUsd(job.cost.capUsd, true)}</dd>
          </dl>
        </section>
      </div>

      {(job.status === 'review' || job.status === 'done') && job.plan ? (
        <Suspense fallback={<p className="muted">Loading the preview…</p>}>
          <ReviewSection job={job} estimateDelayMs={estimateDelayMs} onRendered={refresh} />
        </Suspense>
      ) : null}
      {job.status === 'done' ? <Outputs job={job} /> : null}

      <section className="panel">
        <AiUsageTable calls={job.aiCalls} />
      </section>
      {job.imageDecisions.length > 0 ? (
        <section className="panel">
          <ImageDecisionsTable decisions={job.imageDecisions} />
        </section>
      ) : null}
    </article>
  );
};
