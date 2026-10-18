import { Player } from '@remotion/player';
import { VideoComposition, calculateVideoMetadata } from '@vc/composition';
import {
  deepEqual,
  getPreviewNotes,
  type CatalogResponse,
  type FontInfo,
  type JobDetail,
  type Preset,
  type RenderEstimate,
  type ScenePlan,
  type VideoConfig,
} from '@vc/config';
import { useEffect, useMemo, useState } from 'react';
import { isHtmlInCanvasSupported } from 'remotion';
import { api, errorMessage } from '../api';
import { RenderEstimateLine } from '../components/EstimatePanel';
import { useDebouncedEffect, useLoad } from '../hooks';
import { StyleEditor } from '../style/StyleEditor';
import { useStyleEditor } from '../style/useStyleEditor';

type ReviewData = { presets: Preset[]; catalog: CatalogResponse };

/** Caption FontInfo per family: the plan's own, then fetched once per Google Font the user picks. */
const useFontInfo = (
  plan: ScenePlan,
  initialFamily: string,
  family: string,
  knownFonts: readonly string[],
) => {
  const [fonts, setFonts] = useState<Record<string, FontInfo | null>>(() => ({
    [initialFamily]: plan.fonts.caption,
  }));
  const missing = !(family in fonts) && knownFonts.includes(family);
  useEffect(() => {
    if (!missing) return;
    let alive = true;
    api.getFont(family).then(
      (info) => alive && setFonts((f) => ({ ...f, [family]: info })),
      () => alive && setFonts((f) => ({ ...f, [family]: null })),
    );
    return () => {
      alive = false;
    };
  }, [family, missing]);
  return fonts[family] ?? null;
};

/** The server's estimate for the reviewed style; an edited style is re-estimated once edits settle. */
const useRenderEstimate = (
  config: VideoConfig,
  job: JobDetail,
  delayMs: number,
): RenderEstimate | null => {
  const edited = !deepEqual(config, job.config);
  const [fresh, setFresh] = useState<RenderEstimate | null>(null);
  useDebouncedEffect(
    () => {
      if (!edited) return;
      let alive = true;
      api.estimateJobRender(job.id, config).then(
        (res) => alive && setFresh(res.render),
        () => undefined,
      );
      return () => {
        alive = false;
      };
    },
    JSON.stringify(config),
    delayMs,
  );
  return edited ? (fresh ?? job.render.estimate) : job.render.estimate;
};

type ReviewProps = {
  job: JobDetail;
  plan: ScenePlan;
  data: ReviewData;
  estimateDelayMs: number;
  onRendered: () => void;
};

const Review = ({ job, plan, data, estimateDelayMs, onRendered }: ReviewProps) => {
  const [presets, setPresets] = useState(data.presets);
  const editor = useStyleEditor({
    initial: job.config,
    presetId: job.config.basedOnPreset,
    presets,
    timedTransitions: data.catalog.timedTransitions,
    defaultTrackId: data.catalog.musicTracks[0]?.id,
  });
  const config = editor.validConfig;
  const font = useFontInfo(
    plan,
    job.config.captions.fontFamily,
    config.captions.fontFamily,
    data.catalog.fonts,
  );
  const previewPlan = useMemo<ScenePlan>(
    () => ({ ...plan, fonts: { caption: font } }),
    [plan, font],
  );
  const meta = calculateVideoMetadata({ config, plan: previewPlan });
  const notes = useMemo(() => getPreviewNotes(config, isHtmlInCanvasSupported()), [config]);
  const estimate = useRenderEstimate(config, job, estimateDelayMs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const render = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.renderJob(job.id, config);
      onRendered();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel review" aria-label="Review">
      <h2>Review</h2>
      <div className="review-grid">
        <div className="player">
          <Player
            component={VideoComposition}
            inputProps={{ config, plan: previewPlan }}
            durationInFrames={meta.durationInFrames}
            fps={meta.fps}
            compositionWidth={meta.width}
            compositionHeight={meta.height}
            controls
            acknowledgeRemotionLicense
            style={{
              // Fit the screen as well as the column: a 9:16 preview would otherwise be ~1000 px tall.
              width: `min(100%, calc((100vh - 8rem) * ${+(meta.width / meta.height).toFixed(4)}))`,
              aspectRatio: `${meta.width} / ${meta.height}`,
              margin: '0 auto',
            }}
          />
          {notes.length > 0 ? (
            <ul className="notes">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          <p className="muted small">
            Changes here redraw the preview in your browser; only the final render goes to the
            queue.
          </p>
        </div>
        <div className="review-controls">
          <StyleEditor
            editor={editor}
            catalog={data.catalog}
            presets={presets}
            onPresetsChange={setPresets}
          />
          <div className="render-bar">
            <RenderEstimateLine estimate={estimate} />
            {error ? (
              <p role="alert" className="error">
                {error}
              </p>
            ) : null}
            <button
              type="button"
              className="primary large"
              disabled={busy || !editor.isValid}
              onClick={() => void render()}
            >
              {job.status === 'done' ? 'Render again' : 'Render video'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};

/** The review screen: the same composition in @remotion/player, restyled locally before the final render. */
export const ReviewSection = ({
  job,
  estimateDelayMs = 400,
  onRendered,
}: {
  job: JobDetail;
  estimateDelayMs?: number;
  onRendered: () => void;
}) => {
  const data = useLoad(async (): Promise<ReviewData> => {
    const [presets, catalog] = await Promise.all([api.getPresets(), api.getCatalog()]);
    return { presets, catalog };
  });
  if (!job.plan) return null;
  if (data.status === 'loading') return <p className="muted">Loading the preview…</p>;
  if (data.status === 'error') return <p className="error">{data.error}</p>;
  return (
    <Review
      job={job}
      plan={job.plan}
      data={data.data}
      estimateDelayMs={estimateDelayMs}
      onRendered={onRendered}
    />
  );
};
