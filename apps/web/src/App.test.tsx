import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { navigate } from './router';
import {
  catalogResponse,
  completeSetup,
  emptySetup,
  presetsResponse,
  providers,
  settingsResponse,
} from './test/fixtures';
import { apiError, mockApi } from './test/mock-api';

vi.mock('@remotion/player', () => ({ Player: () => <div data-testid="player" /> }));

const createRoutes = {
  'GET /api/presets': presetsResponse(),
  'GET /api/catalog': catalogResponse(),
  'GET /api/settings': settingsResponse(),
  'GET /api/providers': providers,
  'POST /api/estimate': apiError(503, 'busy', 'later'),
};

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(() => vi.unstubAllGlobals());

describe('App gating', () => {
  it('asks for a new passphrase first when the encrypted vault needs setting up', async () => {
    mockApi({
      'GET /api/setup': {
        ...emptySetup(),
        vault: { backend: 'file', locked: true, needsSetup: true },
      },
    });
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: /create a passphrase/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('unlocks a locked vault, then continues', async () => {
    let unlocked = false;
    mockApi({
      'GET /api/setup': () =>
        unlocked
          ? completeSetup()
          : { ...completeSetup(), vault: { backend: 'file', locked: true, needsSetup: false } },
      'POST /api/vault/unlock': () => {
        unlocked = true;
        return { backend: 'file', locked: false, needsSetup: false };
      },
      ...createRoutes,
    });
    render(<App />);
    await userEvent.type(await screen.findByLabelText('Passphrase'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('heading', { name: /create a video/i })).toBeInTheDocument();
  });

  it('shows Setup until every required role passes, and keeps Create unreachable', async () => {
    mockApi({ 'GET /api/setup': emptySetup(), 'GET /api/providers': providers });
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: /set up your ai providers/i }),
    ).toBeInTheDocument();
    act(() => navigate('/create'));
    expect(screen.getByRole('heading', { name: /set up your ai providers/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /create a video/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create' })).not.toBeInTheDocument();
  });

  it('opens on Create with the full navigation once setup is complete', async () => {
    mockApi({ 'GET /api/setup': completeSetup(), ...createRoutes });
    render(<App />);
    expect(await screen.findByRole('heading', { name: /create a video/i })).toBeInTheDocument();
    const nav = screen.getByRole('navigation');
    for (const name of ['Create', 'Jobs', 'Settings'])
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
  });

  it('offers a retry when the server cannot be reached', async () => {
    let fail = true;
    mockApi({
      'GET /api/setup': () => (fail ? apiError(500, 'internal', 'Server down') : completeSetup()),
      ...createRoutes,
    });
    render(<App />);
    expect(await screen.findByText(/server down/i)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /create a video/i })).toBeInTheDocument(),
    );
  });
});
