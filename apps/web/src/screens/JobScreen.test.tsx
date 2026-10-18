import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLIENT_HEADER, initialConfig, mergeConfig, type JobDetail } from '@vc/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogResponse, estimateResponse, jobDetail, presetsResponse } from '../test/fixtures';
import { FakeEventSource, mockApi } from '../test/mock-api';
import { JobScreen } from './JobScreen';

vi.mock('@remotion/player', () => ({
  Player: (props: {
    inputProps: { config: { simple: unknown }; plan: { fonts: unknown } };
    compositionWidth: number;
    compositionHeight: number;
    fps: number;
    durationInFrames: number;
    style?: { width?: string };
  }) => (
    <pre data-testid="player">
      {JSON.stringify({
        simple: props.inputProps.config.simple,
        font: props.inputProps.plan.fonts,
        size: [props.compositionWidth, props.compositionHeight, props.fps, props.durationInFrames],
        width: props.style?.width,
      })}
    </pre>
  ),
}));

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.instances = [];
});
afterEach(() => vi.unstubAllGlobals());

const routes = (job: JobDetail, extra: Record<string, unknown> = {}) => ({
  'GET /api/jobs/:id': job,
  'GET /api/presets': presetsResponse(),
  'GET /api/catalog': catalogResponse(),
  ...extra,
});

const player = () => JSON.parse(screen.getByTestId('player').textContent!);

describe('JobScreen', () => {
  it('shows status, stages, warnings and estimated vs actual cost', async () => {
    mockApi(routes(jobDetail()));
    render(<JobScreen id="job1" />);
    expect(await screen.findByRole('heading', { name: 'The Apollo program' })).toBeInTheDocument();
    expect(screen.getByText('Ready for review')).toBeInTheDocument();
    const stages = screen.getByRole('list', { name: 'Stages' });
    expect(within(stages).getByText('Research')).toBeInTheDocument();
    expect(
      screen.getByText('1 scene(s) use a typographic card because no image passed.'),
    ).toBeInTheDocument();
    const cost = screen.getByRole('region', { name: 'Cost' });
    expect(within(cost).getByText('$0.0523')).toBeInTheDocument();
    expect(within(cost).getByText('$0.0126')).toBeInTheDocument();
    expect(within(cost).getByText('$2.00')).toBeInTheDocument();
  });

  it('lists where AI was used, why, and what it cost', async () => {
    mockApi(routes(jobDetail()));
    render(<JobScreen id="job1" />);
    const table = await screen.findByRole('table', { name: 'Where AI was used' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent(
      'Writing narration to a word budget with a story shape needs a language model.',
    );
    expect(rows[1]).toHaveTextContent('openai / gpt-6.1-sol-2026-09-01');
    expect(rows[1]).toHaveTextContent('1,800 in / 400 out tokens');
    expect(rows[1]).toHaveTextContent('$0.0076');
    expect(rows[0]).toHaveTextContent('not AI');
    expect(rows[2]).toHaveTextContent('Skipped (cost cap)');
  });

  it('shows image decisions', async () => {
    mockApi(routes(jobDetail()));
    render(<JobScreen id="job1" />);
    const table = await screen.findByRole('table', { name: 'Images' });
    expect(within(table).getByText('Saturn V rocket launch')).toBeInTheDocument();
    expect(within(table).getByText('Typographic fallback')).toBeInTheDocument();
  });

  it('previews the plan with the same composition, sized from the config', async () => {
    mockApi(routes(jobDetail()));
    render(<JobScreen id="job1" />);
    await screen.findByTestId('player');
    expect(player().size).toEqual([1920, 1080, 30, 180]);
    expect(player().simple).toEqual(initialConfig().simple);
  });

  it('updates the preview from the style controls with no server round trip', async () => {
    const m = mockApi(routes(jobDetail()));
    render(<JobScreen id="job1" />);
    await screen.findByTestId('player');
    const before = m.calls.length;
    await userEvent.selectOptions(screen.getByLabelText('Animation'), 'dynamic');
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Aspect' })).getByRole('radio', { name: '1:1' }),
    );
    expect(player().simple).toMatchObject({ animationKind: 'dynamic', aspect: '1:1' });
    expect(player().size.slice(0, 2)).toEqual([1080, 1080]);
    // A tall preview is sized to fit the screen, never wider than its column.
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Aspect' })).getByRole('radio', { name: '9:16' }),
    );
    expect(player().width).toBe('min(100%, calc((100vh - 8rem) * 0.5625))');
    expect(m.calls.slice(before).filter((c) => c.path !== '/api/jobs/job1/estimate')).toEqual([]);
  });

  it('re-estimates the render time for an edited style without holding up the preview', async () => {
    const reviewed = estimateResponse().render;
    const m = mockApi(
      routes(
        jobDetail({ render: { estimate: reviewed, elapsedMs: null, progress: null, renders: 0 } }),
        {
          'POST /api/jobs/job1/estimate': () => ({
            render: { ...reviewed, seconds: 400, lowSeconds: 300, highSeconds: 500 },
          }),
        },
      ),
    );
    render(<JobScreen id="job1" estimateDelayMs={0} />);
    await screen.findByTestId('player');
    expect(screen.getByText(/render time about 1 min 35 s/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Backdrop' }), 'light');
    expect(player().simple.backdropKind).toBe('light');
    expect(await screen.findByText(/render time about 6 min 40 s/i)).toBeInTheDocument();
    // Estimated against this job's real plan (its length and scene count are known on the server).
    const calls = m.callsTo('POST', '/api/jobs/job1/estimate');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      config: expect.objectContaining({
        simple: expect.objectContaining({ backdropKind: 'light' }),
      }),
    });
    expect(m.callsTo('POST', '/api/estimate')).toEqual([]);
  });

  it('notes which shader transitions the browser previews with a stand-in', async () => {
    const job = jobDetail({
      config: mergeConfig(initialConfig(), { transitions: { presentations: ['dissolve'] } }),
    });
    mockApi(routes(job));
    render(<JobScreen id="job1" />);
    expect(await screen.findByText(/Dissolve is previewed as fade/)).toBeInTheDocument();
  });

  it('keeps review edits when a live update arrives', async () => {
    mockApi(routes(jobDetail()));
    render(<JobScreen id="job1" />);
    await screen.findByTestId('player');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Backdrop' }), 'light');
    act(() => FakeEventSource.instances[0]!.emit({ type: 'job', job: jobDetail() }));
    expect(player().simple.backdropKind).toBe('light');
  });

  it('fetches the font info when the caption font changes', async () => {
    const m = mockApi(
      routes(jobDetail(), {
        'GET /api/fonts/:family': { fontFamily: 'Roboto', importName: 'Roboto' },
      }),
    );
    render(<JobScreen id="job1" />);
    await screen.findByTestId('player');
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    const font = screen.getByRole('combobox', { name: 'Font' });
    await userEvent.clear(font);
    await userEvent.type(font, 'Roboto');
    await waitFor(() =>
      expect(player().font).toEqual({ caption: { fontFamily: 'Roboto', importName: 'Roboto' } }),
    );
    expect(m.callsTo('GET', '/api/fonts/:family')[0]!.path).toBe('/api/fonts/Roboto');
  });

  it('renders with the reviewed config', async () => {
    let job = jobDetail();
    const m = mockApi(
      routes(job, {
        'GET /api/jobs/:id': () => job,
        'POST /api/jobs/:id/render': () => {
          job = { ...job, status: 'rendering', render: { ...job.render, progress: 0 } };
          return { id: job.id };
        },
      }),
    );
    render(<JobScreen id="job1" />);
    await screen.findByTestId('player');
    await userEvent.selectOptions(screen.getByLabelText('Backdrop'), 'light');
    await userEvent.click(screen.getByRole('button', { name: 'Render video' }));
    await waitFor(() => expect(m.callsTo('POST', '/api/jobs/:id/render')).toHaveLength(1));
    const call = m.callsTo('POST', '/api/jobs/:id/render')[0]!;
    expect(call.path).toBe('/api/jobs/job1/render');
    expect(call.headers.get(CLIENT_HEADER)).toBe('web');
    expect(
      (call.body as { config: { simple: { backdropKind: string } } }).config.simple.backdropKind,
    ).toBe('light');
    expect(await screen.findByText('Rendering')).toBeInTheDocument();
  });

  it('follows live updates over server-sent events', async () => {
    mockApi(routes(jobDetail()));
    render(<JobScreen id="job1" />);
    await screen.findByRole('heading', { name: 'The Apollo program' });
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/jobs/job1/events');
    act(() =>
      source.emit({
        type: 'job',
        job: jobDetail({
          status: 'rendering',
          render: { estimate: null, elapsedMs: null, progress: 0.4, renders: 0 },
        }),
      }),
    );
    expect(await screen.findByRole('progressbar', { name: 'Render progress' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
    act(() => source.emit({ type: 'progress', stage: 'render', progress: 0.75 }));
    expect(screen.getByRole('progressbar', { name: 'Render progress' })).toHaveAttribute(
      'aria-valuenow',
      '75',
    );
  });

  it('shows downloads, checks and render time when done', async () => {
    const job = jobDetail({
      status: 'done',
      outputs: {
        video: '/api/jobs/job1/files/video.mp4',
        srt: '/api/jobs/job1/files/captions.srt',
        credits: '/api/jobs/job1/files/credits.txt',
        contactSheet: null,
      },
      checks: [
        {
          id: 'duration',
          label: 'Duration matches the narration',
          status: 'pass',
          detail: 'Rendered 60.00 s.',
        },
        {
          id: 'caption-overflow',
          label: 'Captions fit',
          status: 'warn',
          detail: '1 caption page(s) overflowed.',
        },
      ],
      render: { estimate: null, elapsedMs: 62_000, progress: 1, renders: 1 },
    });
    mockApi(routes(job));
    render(<JobScreen id="job1" />);
    expect(await screen.findByRole('link', { name: 'Download video' })).toHaveAttribute(
      'href',
      '/api/jobs/job1/files/video.mp4',
    );
    expect(screen.getByRole('link', { name: 'Captions (.srt)' })).toHaveAttribute(
      'href',
      '/api/jobs/job1/files/captions.srt',
    );
    expect(screen.getByRole('link', { name: 'Credits' })).toHaveAttribute(
      'href',
      '/api/jobs/job1/files/credits.txt',
    );
    const checks = screen.getByRole('list', { name: 'Checks' });
    expect(within(checks).getByText('Captions fit')).toBeInTheDocument();
    expect(screen.getByText(/1 min 2 s/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Render again' })).toBeInTheDocument();
  });

  it('shows a failure with its stage', async () => {
    mockApi(
      routes(
        jobDetail({
          status: 'failed',
          plan: null,
          error: { stage: 'script', message: 'The per-job cost cap of $2.00 would be exceeded.' },
        }),
      ),
    );
    render(<JobScreen id="job1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'script: The per-job cost cap of $2.00 would be exceeded.',
    );
    expect(screen.queryByTestId('player')).not.toBeInTheDocument();
  });

  it('polls when server-sent events are unavailable', async () => {
    vi.stubGlobal('EventSource', undefined);
    let calls = 0;
    mockApi(
      routes(jobDetail(), {
        'GET /api/jobs/:id': () =>
          ++calls > 1
            ? jobDetail({ status: 'rendering' })
            : jobDetail({ status: 'preparing', plan: null }),
      }),
    );
    render(<JobScreen id="job1" pollMs={20} />);
    expect(await screen.findByText('Rendering')).toBeInTheDocument();
  });
});
