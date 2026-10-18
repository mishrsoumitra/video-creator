import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLIENT_HEADER } from '@vc/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockApi } from '../test/mock-api';
import { VaultScreen } from './VaultScreen';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('VaultScreen: keys in an encrypted file unlocked by a passphrase', () => {
  it('creates a passphrase after checking length and confirmation', async () => {
    const m = mockApi({
      'POST /api/vault/setup': { backend: 'file', locked: false, needsSetup: false },
    });
    const onDone = vi.fn();
    render(
      <VaultScreen vault={{ backend: 'file', locked: true, needsSetup: true }} onDone={onDone} />,
    );
    await userEvent.type(screen.getByLabelText('Passphrase'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm passphrase'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create passphrase' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/at least 8/i);
    expect(m.calls).toHaveLength(0);

    await userEvent.clear(screen.getByLabelText('Passphrase'));
    await userEvent.type(screen.getByLabelText('Passphrase'), 'correct horse battery');
    await userEvent.clear(screen.getByLabelText('Confirm passphrase'));
    await userEvent.type(screen.getByLabelText('Confirm passphrase'), 'correct horse batterY');
    await userEvent.click(screen.getByRole('button', { name: 'Create passphrase' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/do not match/i);

    await userEvent.clear(screen.getByLabelText('Confirm passphrase'));
    await userEvent.type(screen.getByLabelText('Confirm passphrase'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Create passphrase' }));
    expect(onDone).toHaveBeenCalled();
    expect(m.calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/vault/setup',
      body: { passphrase: 'correct horse battery' },
    });
    expect(m.calls[0]!.headers.get(CLIENT_HEADER)).toBe('web');
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('correct horse');
  });

  it('shows the server’s message for a wrong passphrase', async () => {
    mockApi({
      'POST /api/vault/unlock': apiError(401, 'wrong_passphrase', 'That passphrase is not right.'),
    });
    const onDone = vi.fn();
    render(
      <VaultScreen vault={{ backend: 'file', locked: true, needsSetup: false }} onDone={onDone} />,
    );
    await userEvent.type(screen.getByLabelText('Passphrase'), 'not the one');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That passphrase is not right.');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Passphrase')).toHaveValue('');
  });
});
