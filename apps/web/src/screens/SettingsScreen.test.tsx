import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLIENT_HEADER, PutSettingsSchema, SettingsSchema } from '@vc/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeSetup, presetsResponse, settingsResponse } from '../test/fixtures';
import { apiError, mockApi } from '../test/mock-api';
import { SettingsScreen } from './SettingsScreen';

afterEach(() => vi.unstubAllGlobals());

const routes = (extra: Record<string, unknown> = {}) => {
  let stored = settingsResponse();
  return {
    'GET /api/settings': () => stored,
    'GET /api/presets': presetsResponse(),
    'GET /api/render-stats': { sampleCount: 0, timedTransitions: [], calibrating: false },
    // As the server does: parse the body with PutSettingsSchema, then merge it over what is stored.
    'PUT /api/settings': (ctx: { body: unknown }) =>
      (stored = SettingsSchema.parse({ ...stored, ...PutSettingsSchema.parse(ctx.body) })),
    'GET /api/setup': completeSetup(),
    ...extra,
  };
};

const ready = () => screen.findByRole('heading', { name: 'Settings' });

describe('SettingsScreen', () => {
  it('shows only the last four characters of each key', async () => {
    mockApi(routes());
    render(<SettingsScreen setup={completeSetup()} onSetupChange={vi.fn()} />);
    await ready();
    const keys = screen.getByRole('region', { name: 'API keys' });
    expect(within(keys).getByText('••••abcd')).toBeInTheDocument();
    expect(within(keys).getByText('OpenAI API key')).toBeInTheDocument();
    expect(within(keys).queryAllByRole('textbox')).toHaveLength(0);
  });

  it.each([
    ['keychain', /stored only on this machine \(system keychain\)/i],
    ['file', /stored only on this machine \(encrypted file\)/i],
    ['memory', /kept in memory only and forgotten when the server stops/i],
  ] as const)('says truthfully where keys are kept (%s)', async (backend, text) => {
    const setup = { ...completeSetup(), vault: { backend, locked: false, needsSetup: false } };
    mockApi(routes({ 'GET /api/setup': setup }));
    render(<SettingsScreen setup={setup} onSetupChange={vi.fn()} />);
    await ready();
    expect(
      within(screen.getByRole('region', { name: 'API keys' })).getByText(text),
    ).toBeInTheDocument();
  });

  it('replaces and deletes keys', async () => {
    const onSetupChange = vi.fn();
    const m = mockApi(
      routes({
        'PUT /api/credentials/:id': {
          id: 'openai',
          label: 'OpenAI API key',
          masked: '••••zzzz',
          updatedAt: '',
        },
        'DELETE /api/credentials/:id': undefined,
      }),
    );
    render(<SettingsScreen setup={completeSetup()} onSetupChange={onSetupChange} />);
    await ready();
    const row = screen.getByRole('listitem', { name: 'OpenAI API key' });
    await userEvent.click(within(row).getByRole('button', { name: 'Replace' }));
    await userEvent.type(within(row).getByLabelText('New OpenAI API key'), 'sk-new-key-0000zzzz');
    await userEvent.click(within(row).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(m.callsTo('PUT', '/api/credentials/:id')).toHaveLength(1));
    expect(m.callsTo('PUT', '/api/credentials/:id')[0]!.body).toEqual({
      apiKey: 'sk-new-key-0000zzzz',
    });
    await userEvent.click(
      within(screen.getByRole('listitem', { name: 'Brave Search API key' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() =>
      expect(m.callsTo('DELETE', '/api/credentials/:id')[0]!.path).toBe('/api/credentials/brave'),
    );
    await waitFor(() => expect(onSetupChange).toHaveBeenCalledTimes(2));
  });

  it('saves the per-job cost cap', async () => {
    const m = mockApi(routes());
    render(<SettingsScreen setup={completeSetup()} onSetupChange={vi.fn()} />);
    await ready();
    const cap = screen.getByLabelText('Per-job cost cap (USD)');
    expect(cap).toHaveValue(2);
    await userEvent.clear(cap);
    await userEvent.type(cap, '5');
    await userEvent.click(screen.getByRole('button', { name: 'Save cost cap' }));
    await waitFor(() => expect(m.callsTo('PUT', '/api/settings')).toHaveLength(1));
    expect(m.callsTo('PUT', '/api/settings')[0]!.body).toEqual({
      ...settingsResponse(),
      costCapUsd: 5,
    });
    expect(m.callsTo('PUT', '/api/settings')[0]!.headers.get(CLIENT_HEADER)).toBe('web');
  });

  it('has vision ranking and the vision frame check off by default, and saves toggles', async () => {
    const m = mockApi(routes());
    render(<SettingsScreen setup={completeSetup()} onSetupChange={vi.fn()} />);
    await ready();
    const frameCheck = screen.getByRole('checkbox', { name: /vision frame check/i });
    expect(frameCheck).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /rank every scene/i })).not.toBeChecked();
    await userEvent.click(frameCheck);
    await waitFor(() =>
      expect(m.callsTo('PUT', '/api/settings')[0]!.body).toEqual({
        ...settingsResponse(),
        visionFinalCheck: true,
      }),
    );
  });

  it('keeps every other setting when one changes', async () => {
    const m = mockApi(routes());
    render(<SettingsScreen setup={completeSetup()} onSetupChange={vi.fn()} />);
    await ready();
    const cap = screen.getByLabelText('Per-job cost cap (USD)');
    await userEvent.clear(cap);
    await userEvent.type(cap, '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save cost cap' }));
    await waitFor(() => expect(m.callsTo('PUT', '/api/settings')).toHaveLength(1));
    await userEvent.click(screen.getByRole('checkbox', { name: /rank every scene/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /vision frame check/i }));
    await waitFor(() => expect(m.callsTo('PUT', '/api/settings')).toHaveLength(3));
    expect(m.callsTo('PUT', '/api/settings')[2]!.body).toMatchObject({
      costCapUsd: 3,
      visionRankAlways: true,
      visionFinalCheck: true,
    });
  });

  it('only saves a cost cap the server accepts', async () => {
    mockApi(routes());
    render(<SettingsScreen setup={completeSetup()} onSetupChange={vi.fn()} />);
    await ready();
    const cap = screen.getByLabelText('Per-job cost cap (USD)');
    const button = screen.getByRole('button', { name: 'Save cost cap' });
    for (const value of ['', '-1', '1001', 'abc']) {
      await userEvent.clear(cap);
      if (value) await userEvent.type(cap, value);
      expect(button).toBeDisabled();
    }
    await userEvent.clear(cap);
    await userEvent.type(cap, '0');
    expect(button).toBeEnabled();
  });

  it('lists user presets with Delete, built-ins without', async () => {
    const m = mockApi(routes({ 'DELETE /api/presets/:id': undefined }));
    render(<SettingsScreen setup={completeSetup()} onSetupChange={vi.fn()} />);
    await ready();
    const list = screen.getByRole('region', { name: 'Your presets' });
    expect(within(list).getByText('My Channel Look')).toBeInTheDocument();
    expect(within(list).queryByText('Documentary')).not.toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: 'Delete My Channel Look' }));
    await waitFor(() =>
      expect(m.callsTo('DELETE', '/api/presets/:id')[0]!.path).toBe('/api/presets/my-channel-look'),
    );
    await waitFor(() =>
      expect(within(list).queryByText('My Channel Look')).not.toBeInTheDocument(),
    );
  });

  it('adds a pricing override', async () => {
    const m = mockApi(routes());
    render(<SettingsScreen setup={completeSetup()} onSetupChange={vi.fn()} />);
    await ready();
    const pricing = screen.getByRole('region', { name: 'Pricing overrides' });
    await userEvent.type(within(pricing).getByLabelText('Provider / model'), 'openai/gpt-6.1-sol');
    await userEvent.type(within(pricing).getByLabelText('Input $ per 1M tokens'), '2.5');
    await userEvent.type(within(pricing).getByLabelText('Output $ per 1M tokens'), '12');
    await userEvent.click(within(pricing).getByRole('button', { name: 'Add override' }));
    await waitFor(() => expect(m.callsTo('PUT', '/api/settings')).toHaveLength(1));
    expect(m.callsTo('PUT', '/api/settings')[0]!.body).toEqual({
      ...settingsResponse(),
      pricingOverrides: { 'openai/gpt-6.1-sol': { inputPerMTok: 2.5, outputPerMTok: 12 } },
    });
  });

  it('starts calibration, follows it while it runs, then shows what was measured', async () => {
    let started = false;
    let polls = 0;
    const m = mockApi(
      routes({
        'POST /api/calibrate': () => {
          started = true;
          return { calibrating: true };
        },
        'GET /api/render-stats': () => {
          if (!started) return { sampleCount: 0, timedTransitions: [], calibrating: false };
          polls += 1;
          return polls < 3
            ? { sampleCount: 0, timedTransitions: [], calibrating: true }
            : { sampleCount: 14, timedTransitions: ['film-burn', 'ripple'], calibrating: false };
        },
      }),
    );
    render(<SettingsScreen setup={completeSetup()} onSetupChange={vi.fn()} pollMs={30} />);
    await ready();
    expect(screen.getByText(/no renders measured yet/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Calibrate render estimates' }));
    expect(await screen.findByRole('button', { name: /calibrating/i })).toBeDisabled();
    expect(await screen.findByText(/14 measured renders/i)).toBeInTheDocument();
    expect(screen.getByText(/film-burn, ripple/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Calibrate render estimates' })).toBeEnabled();
    expect(m.callsTo('POST', '/api/calibrate')).toHaveLength(1);
    expect(polls).toBe(3);
  });

  it('picks up a calibration that is already running', async () => {
    let polls = 0;
    mockApi(
      routes({
        'GET /api/render-stats': () =>
          ++polls < 3
            ? { sampleCount: 2, timedTransitions: [], calibrating: true }
            : { sampleCount: 9, timedTransitions: ['ripple'], calibrating: false },
      }),
    );
    render(<SettingsScreen setup={completeSetup()} onSetupChange={vi.fn()} pollMs={30} />);
    await ready();
    expect(screen.getByRole('button', { name: /calibrating/i })).toBeDisabled();
    expect(await screen.findByText(/9 measured renders/i)).toBeInTheDocument();
  });

  it('explains when calibration is not available', async () => {
    mockApi(
      routes({
        'POST /api/calibrate': apiError(
          501,
          'unavailable',
          'Calibration is not available in this build.',
        ),
      }),
    );
    render(<SettingsScreen setup={completeSetup()} onSetupChange={vi.fn()} pollMs={30} />);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Calibrate render estimates' }));
    expect(
      await screen.findByText('Calibration is not available in this build.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Calibrate render estimates' })).toBeEnabled();
  });

  it('links to the provider setup', async () => {
    mockApi(routes());
    render(<SettingsScreen setup={completeSetup()} onSetupChange={vi.fn()} />);
    await ready();
    expect(screen.getByRole('link', { name: /change ai providers/i })).toHaveAttribute(
      'href',
      '/setup',
    );
  });
});
