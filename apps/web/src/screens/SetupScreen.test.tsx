import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLIENT_HEADER, type SetupState } from '@vc/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeSetup, emptySetup, providers } from '../test/fixtures';
import { mockApi } from '../test/mock-api';
import { SetupScreen } from './SetupScreen';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

const block = (name: string) => screen.getByRole('region', { name });

const renderSetup = (setup: SetupState, routes: Record<string, unknown> = {}) => {
  const m = mockApi({ 'GET /api/providers': providers, 'GET /api/setup': setup, ...routes });
  const onSetupChange = vi.fn();
  const onContinue = vi.fn();
  render(<SetupScreen setup={setup} onSetupChange={onSetupChange} onContinue={onContinue} />);
  return { m, onSetupChange, onContinue };
};

describe('SetupScreen: pick providers once, paste keys, test each role', () => {
  it('shows one block per role, each listing only providers that can fill it', async () => {
    renderSetup(emptySetup());
    await screen.findByRole('region', { name: 'Text' });
    for (const name of ['Text', 'Web search', 'Voice', 'Word timing', 'Vision'])
      expect(block(name)).toBeInTheDocument();
    const timing = within(block('Word timing')).getByLabelText('Provider');
    expect(
      within(timing)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose…', 'OpenAI', 'whisper.cpp (local)']);
  });

  it('keeps Continue disabled until setup is complete, and says what is missing', async () => {
    renderSetup(emptySetup());
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByText('Choose a text provider and pass the test call.')).toBeInTheDocument();
  });

  it('enables Continue once every required role has passed', async () => {
    const { onContinue } = renderSetup(completeSetup());
    const button = await screen.findByRole('button', { name: 'Continue' });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(onContinue).toHaveBeenCalled();
  });

  it('saves a provider choice with its default model', async () => {
    const next = { ...emptySetup() };
    const { m, onSetupChange } = renderSetup(emptySetup(), { 'PUT /api/setup/roles/:role': next });
    await userEvent.selectOptions(
      await within(await screen.findByRole('region', { name: 'Text' })).findByLabelText('Provider'),
      'openai',
    );
    await waitFor(() => expect(m.callsTo('PUT', '/api/setup/roles/:role')).toHaveLength(1));
    const call = m.callsTo('PUT', '/api/setup/roles/:role')[0]!;
    expect(call.path).toBe('/api/setup/roles/text');
    expect(call.body).toEqual({
      mode: 'provider',
      providerId: 'openai',
      model: 'gpt-6.1-sol',
      options: {},
    });
    expect(call.headers.get(CLIENT_HEADER)).toBe('web');
    expect(onSetupChange).toHaveBeenCalledWith(next);
  });

  it('sends the key once, clears the field and never keeps it in the browser', async () => {
    const setup = emptySetup();
    setup.roles.text = { ...setup.roles.text, providerId: 'openai', model: 'gpt-6.1-sol' };
    const after = {
      ...setup,
      credentials: [
        {
          id: 'openai',
          label: 'OpenAI API key',
          masked: '••••3xyz',
          updatedAt: '2026-10-18T10:00:00Z',
        },
      ],
    };
    const { m, onSetupChange } = renderSetup(setup, {
      'PUT /api/credentials/:id': {
        id: 'openai',
        label: 'OpenAI API key',
        masked: '••••3xyz',
        updatedAt: '',
      },
      'GET /api/setup': after,
    });
    const text = await screen.findByRole('region', { name: 'Text' });
    const key = 'sk-proj-SECRET-KEY-0123456789abc3xyz';
    const input = within(text).getByLabelText('OpenAI API key');
    expect(input).toHaveAttribute('type', 'password');
    await userEvent.type(input, key);
    await userEvent.click(within(text).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(m.callsTo('PUT', '/api/credentials/:id')).toHaveLength(1));
    expect(m.callsTo('PUT', '/api/credentials/:id')[0]).toMatchObject({
      path: '/api/credentials/openai',
      body: { apiKey: key },
    });
    await waitFor(() => expect(onSetupChange).toHaveBeenCalledWith(after));
    expect(input).toHaveValue('');
    expect(document.body.innerHTML).not.toContain('SECRET-KEY');
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('SECRET-KEY');
  });

  it('reuses a stored key (one key fills several slots) and shows only its last four characters', async () => {
    const setup = completeSetup();
    setup.roles.vision = {
      ...setup.roles.vision,
      mode: 'provider',
      providerId: 'openai',
      model: 'gpt-6.1-sol',
    };
    renderSetup(setup);
    const vision = await screen.findByRole('region', { name: 'Vision' });
    expect(within(vision).getByText('Using your OpenAI API key ••••abcd')).toBeInTheDocument();
    expect(within(vision).queryByLabelText('OpenAI API key')).not.toBeInTheDocument();
    await userEvent.click(within(vision).getByRole('button', { name: 'Replace' }));
    expect(within(vision).getByLabelText('OpenAI API key')).toHaveValue('');
  });

  it('runs a test call and shows the result and the model it reached', async () => {
    const setup = completeSetup();
    const { m, onSetupChange } = renderSetup(setup, {
      'POST /api/setup/roles/:role/test': {
        ok: true,
        model: 'gpt-6.1-sol-2026-09-01',
        detail: 'Replied "OK".',
        durationMs: 412,
      },
    });
    const text = await screen.findByRole('region', { name: 'Text' });
    await userEvent.click(within(text).getByRole('button', { name: 'Test' }));
    expect(await within(text).findByText(/Passed/)).toBeInTheDocument();
    expect(within(text).getByText(/gpt-6\.1-sol-2026-09-01/)).toBeInTheDocument();
    expect(m.callsTo('POST', '/api/setup/roles/:role/test')[0]!.path).toBe(
      '/api/setup/roles/text/test',
    );
    await waitFor(() => expect(onSetupChange).toHaveBeenCalled());
  });

  it('shows a failed test with the reason', async () => {
    renderSetup(completeSetup(), {
      'POST /api/setup/roles/:role/test': {
        ok: false,
        model: null,
        detail: 'The key was rejected (401).',
        durationMs: 120,
      },
    });
    const voice = await screen.findByRole('region', { name: 'Voice' });
    await userEvent.click(within(voice).getByRole('button', { name: 'Test' }));
    expect(await within(voice).findByText(/The key was rejected/)).toBeInTheDocument();
  });

  it('lets search and vision be switched off', async () => {
    const { m } = renderSetup(emptySetup(), { 'PUT /api/setup/roles/:role': emptySetup() });
    const search = await screen.findByRole('region', { name: 'Web search' });
    await userEvent.click(
      within(search).getByRole('radio', { name: /off.*paste my own source text/i }),
    );
    await waitFor(() =>
      expect(m.callsTo('PUT', '/api/setup/roles/:role')[0]).toMatchObject({
        path: '/api/setup/roles/search',
        body: { mode: 'off' },
      }),
    );
    expect(within(block('Vision')).getByRole('radio', { name: /^off/i })).toBeChecked();
  });

  it('offers "use local" for voice and word timing', async () => {
    const { m } = renderSetup(emptySetup(), { 'PUT /api/setup/roles/:role': emptySetup() });
    const voice = await screen.findByRole('region', { name: 'Voice' });
    await userEvent.click(within(voice).getByRole('checkbox', { name: /use local/i }));
    await waitFor(() => expect(m.callsTo('PUT', '/api/setup/roles/:role')).toHaveLength(1));
    expect(m.callsTo('PUT', '/api/setup/roles/:role')[0]).toMatchObject({
      path: '/api/setup/roles/voice',
      body: {
        mode: 'provider',
        providerId: 'kokoro',
        model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      },
    });
    await userEvent.click(
      within(block('Word timing')).getByRole('checkbox', { name: /use local/i }),
    );
    await waitFor(() => expect(m.callsTo('PUT', '/api/setup/roles/:role')).toHaveLength(2));
    expect(m.callsTo('PUT', '/api/setup/roles/:role')[1]).toMatchObject({
      path: '/api/setup/roles/align',
      body: { providerId: 'whisper-cpp' },
    });
  });

  it('lets voice be uploaded recordings and word timing come from the voice itself', async () => {
    const { m } = renderSetup(emptySetup(), { 'PUT /api/setup/roles/:role': emptySetup() });
    const voice = await screen.findByRole('region', { name: 'Voice' });
    await userEvent.click(within(voice).getByRole('radio', { name: /upload recordings/i }));
    await userEvent.click(
      within(block('Word timing')).getByRole('radio', { name: /voice's own timings/i }),
    );
    await waitFor(() => expect(m.callsTo('PUT', '/api/setup/roles/:role')).toHaveLength(2));
    expect(
      m
        .callsTo('PUT', '/api/setup/roles/:role')
        .map((c) => [c.path, (c.body as { mode: string }).mode]),
    ).toEqual([
      ['/api/setup/roles/voice', 'off'],
      ['/api/setup/roles/align', 'off'],
    ]);
  });

  it('builds option inputs from the provider’s options schema', async () => {
    const setup = emptySetup();
    setup.roles.voice = {
      ...setup.roles.voice,
      providerId: 'azure-tts',
      model: 'en-US-AndrewMultilingualNeural',
    };
    const { m } = renderSetup(setup, { 'PUT /api/setup/roles/:role': setup });
    const voice = await screen.findByRole('region', { name: 'Voice' });
    const region = within(voice).getByLabelText(/region/i);
    expect(region).toBeRequired();
    await userEvent.type(region, 'westeurope');
    await userEvent.tab();
    await waitFor(() => expect(m.callsTo('PUT', '/api/setup/roles/:role')).toHaveLength(1));
    expect(m.callsTo('PUT', '/api/setup/roles/:role')[0]!.body).toMatchObject({
      providerId: 'azure-tts',
      options: { region: 'westeurope' },
    });
  });

  it('marks an optional key as optional', async () => {
    const setup = emptySetup();
    setup.roles.text = { ...setup.roles.text, providerId: 'openai-compatible', model: 'qwen3:8b' };
    renderSetup(setup);
    const text = await screen.findByRole('region', { name: 'Text' });
    expect(within(text).getByText(/optional/i)).toBeInTheDocument();
  });
});
