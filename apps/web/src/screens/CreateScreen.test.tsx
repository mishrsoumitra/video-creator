import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLIENT_HEADER, initialConfig } from '@vc/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  catalogResponse,
  estimateResponse,
  presetsResponse,
  settingsResponse,
} from '../test/fixtures';
import { apiError, mockApi } from '../test/mock-api';
import { CreateScreen } from './CreateScreen';

beforeEach(() => window.history.replaceState(null, '', '/create'));
afterEach(() => vi.unstubAllGlobals());

const routes = (extra: Record<string, unknown> = {}) => ({
  'GET /api/presets': presetsResponse(),
  'GET /api/catalog': catalogResponse(),
  'GET /api/settings': settingsResponse(),
  'POST /api/estimate': estimateResponse(),
  ...extra,
});

const ready = async () => screen.findByRole('heading', { name: /create a video/i });

describe('CreateScreen', () => {
  it('shows topic, length buttons and the simple pickers up front', async () => {
    mockApi(routes());
    render(<CreateScreen setupComplete estimateDelayMs={0} />);
    await ready();
    expect(screen.getByLabelText('Topic')).toBeInTheDocument();
    const lengths = screen.getByRole('group', { name: 'Length' });
    expect(
      within(lengths)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('value')),
    ).toEqual(['30', '60', '90', '180', '300']);
    expect(within(lengths).getByRole('radio', { name: '1 min' })).toBeChecked();
    expect(screen.getByLabelText('Animation')).toBeInTheDocument();
  });

  it('keeps Generate disabled until the topic is valid', async () => {
    mockApi(routes());
    render(<CreateScreen setupComplete estimateDelayMs={0} />);
    await ready();
    const generate = screen.getByRole('button', { name: 'Generate' });
    expect(generate).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Topic'), 'ab');
    expect(generate).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Topic'), 'c volcanoes');
    expect(generate).toBeEnabled();
  });

  it('keeps Generate disabled when setup is incomplete', async () => {
    mockApi(routes());
    render(<CreateScreen setupComplete={false} estimateDelayMs={0} />);
    await ready();
    await userEvent.type(screen.getByLabelText('Topic'), 'Volcanoes');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });

  it('shows the cost and render-time estimate next to Generate', async () => {
    const m = mockApi(routes());
    render(<CreateScreen setupComplete estimateDelayMs={0} />);
    await ready();
    const panel = await screen.findByRole('region', { name: 'Estimate' });
    expect(await within(panel).findByText('$0.05')).toBeInTheDocument();
    expect(within(panel).getByText(/up to \$0\.13/)).toBeInTheDocument();
    expect(within(panel).getByText(/about 1 min 35 s/)).toBeInTheDocument();
    const call = m.callsTo('POST', '/api/estimate').at(-1)!;
    expect(call.body).toMatchObject({
      lengthSeconds: 60,
      sourceTextProvided: false,
      recordingProvided: false,
    });
  });

  it('says when render time has not been measured yet, and flags unknown prices', async () => {
    mockApi(
      routes({
        'POST /api/estimate': estimateResponse({
          cost: { ...estimateResponse().cost, unpriced: ['mystery/model-x'] },
          render: {
            status: 'uncalibrated',
            seconds: null,
            lowSeconds: null,
            highSeconds: null,
            unmeasured: [],
            sampleCount: 0,
          },
        }),
      }),
    );
    render(<CreateScreen setupComplete estimateDelayMs={0} />);
    await ready();
    const panel = await screen.findByRole('region', { name: 'Estimate' });
    expect(await within(panel).findByText(/not measured yet/i)).toBeInTheDocument();
    expect(within(panel).getByText(/mystery\/model-x/)).toBeInTheDocument();
  });

  it('lists effects the render estimate has never measured', async () => {
    mockApi(
      routes({
        'POST /api/estimate': estimateResponse({
          render: {
            status: 'partial',
            seconds: 200,
            lowSeconds: 120,
            highSeconds: 300,
            unmeasured: ['lightLeaks'],
            sampleCount: 4,
          },
        }),
      }),
    );
    render(<CreateScreen setupComplete estimateDelayMs={0} />);
    await ready();
    const panel = await screen.findByRole('region', { name: 'Estimate' });
    expect(await within(panel).findByText(/lightLeaks/)).toBeInTheDocument();
  });

  it('creates the job with topic, length, config and pasted sources, then opens it', async () => {
    const m = mockApi(routes({ 'POST /api/jobs': { id: 'job9' } }));
    render(<CreateScreen setupComplete estimateDelayMs={0} />);
    await ready();
    await userEvent.type(screen.getByLabelText('Topic'), 'Volcanoes');
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Length' })).getByRole('radio', {
        name: '1 min 30 s',
      }),
    );
    fireEvent.change(screen.getByLabelText(/paste your own source text/i), {
      target: { value: 'Volcanoes erupt molten rock.' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(window.location.pathname).toBe('/jobs/job9'));
    const call = m.callsTo('POST', '/api/jobs')[0]!;
    expect(call.body).toEqual({
      topic: 'Volcanoes',
      lengthSeconds: 90,
      config: initialConfig(),
      sourceText: 'Volcanoes erupt molten rock.',
    });
    expect(call.headers.get(CLIENT_HEADER)).toBe('web');
  });

  it('uploads a recording and sends its id', async () => {
    const m = mockApi(
      routes({
        'POST /api/uploads': {
          id: 'upl_7',
          kind: 'recording',
          name: 'take.wav',
          durationMs: 61_000,
        },
        'POST /api/jobs': { id: 'job9' },
      }),
    );
    render(<CreateScreen setupComplete estimateDelayMs={0} />);
    await ready();
    await userEvent.upload(
      screen.getByLabelText(/your own recording/i),
      new File([new Uint8Array([1])], 'take.wav', { type: 'audio/wav' }),
    );
    expect(await screen.findByText(/take\.wav/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Topic'), 'Volcanoes');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(m.callsTo('POST', '/api/jobs')).toHaveLength(1));
    expect(m.callsTo('POST', '/api/jobs')[0]!.body).toMatchObject({ recordingUploadId: 'upl_7' });
    expect(m.callsTo('POST', '/api/uploads')[0]!.query.get('kind')).toBe('recording');
  });

  it('warns but does not block Generate', async () => {
    mockApi(routes());
    render(<CreateScreen setupComplete estimateDelayMs={0} />);
    await ready();
    await userEvent.type(screen.getByLabelText('Topic'), 'Volcanoes');
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Aspect' })).getByRole('radio', { name: '9:16' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Letterbox' }));
    expect(
      within(screen.getByRole('region', { name: 'Warnings' })).getByText(/thin strip/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });

  it('shows the server’s reasons when a job is refused', async () => {
    mockApi(
      routes({
        'POST /api/jobs': apiError(409, 'setup_incomplete', 'Finish setup first.', [
          { path: 'voice', message: 'Test the voice provider.' },
        ]),
      }),
    );
    render(<CreateScreen setupComplete estimateDelayMs={0} />);
    await ready();
    await userEvent.type(screen.getByLabelText('Topic'), 'Volcanoes');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Finish setup first.');
    expect(alert).toHaveTextContent('Test the voice provider.');
  });

  it('starts from the default preset in Settings', async () => {
    mockApi(
      routes({ 'GET /api/settings': { ...settingsResponse(), defaultPresetId: 'cinematic' } }),
    );
    render(<CreateScreen setupComplete estimateDelayMs={0} />);
    await ready();
    expect(screen.getByRole('button', { name: 'Cinematic' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
