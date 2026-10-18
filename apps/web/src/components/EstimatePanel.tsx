import type { EstimateResponse, RenderEstimate, VideoConfig } from '@vc/config';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import { formatDuration, formatUsd } from '../format';
import { useDebouncedEffect } from '../hooks';

export const RenderEstimateLine = ({ estimate }: { estimate: RenderEstimate | null }) => {
  if (!estimate || estimate.status === 'uncalibrated' || estimate.seconds === null) {
    return (
      <p>
        Render time not measured yet. Calibrate it in Settings, or it learns from your first render.
      </p>
    );
  }
  return (
    <>
      <p>
        Render time about {formatDuration(estimate.seconds)}
        {estimate.lowSeconds !== null && estimate.highSeconds !== null
          ? ` (${formatDuration(estimate.lowSeconds)} – ${formatDuration(estimate.highSeconds)})`
          : ''}
        , from {estimate.sampleCount} measured render{estimate.sampleCount === 1 ? '' : 's'}.
      </p>
      {estimate.unmeasured.length > 0 ? (
        <p className="warning">
          Not measured yet, so not included: {estimate.unmeasured.join(', ')}.
        </p>
      ) : null}
    </>
  );
};

/** Cost and render-time estimates shown next to Generate, refreshed after edits settle. */
export const EstimatePanel = ({
  lengthSeconds,
  config,
  sourceTextProvided,
  recordingProvided,
  delayMs,
}: {
  lengthSeconds: number;
  config: VideoConfig;
  sourceTextProvided: boolean;
  recordingProvided: boolean;
  delayMs: number;
}) => {
  const [result, setResult] = useState<{ data: EstimateResponse | null; error: string | null }>({
    data: null,
    error: null,
  });
  const key = JSON.stringify([lengthSeconds, config, sourceTextProvided, recordingProvided]);

  useDebouncedEffect(
    () => {
      let alive = true;
      api.estimate({ lengthSeconds, config, sourceTextProvided, recordingProvided }).then(
        (data) => alive && setResult({ data, error: null }),
        (error: unknown) =>
          alive && setResult((r) => ({ data: r.data, error: errorMessage(error) })),
      );
      return () => {
        alive = false;
      };
    },
    key,
    delayMs,
  );

  const { data, error } = result;
  return (
    <section className="estimate" aria-label="Estimate">
      {data ? (
        <>
          <p>
            <strong>{formatUsd(data.cost.totalUsd)}</strong> estimated AI cost, up to{' '}
            {formatUsd(data.cost.maxUsd)} (cap {formatUsd(data.cost.capUsd)})
          </p>
          {data.cost.unpriced.length > 0 ? (
            <p className="warning">
              No price known for {data.cost.unpriced.join(', ')}; not counted.
            </p>
          ) : null}
          <RenderEstimateLine estimate={data.render} />
        </>
      ) : (
        <p className="muted">{error ? `Estimate unavailable: ${error}` : 'Estimating…'}</p>
      )}
    </section>
  );
};
