import type { VaultState } from '@vc/config';
import { useId, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';

const MIN_LENGTH = 8;

/** The passphrase that unlocks the encrypted key file (used when no OS keychain is available). */
export const VaultScreen = ({ vault, onDone }: { vault: VaultState; onDone: () => void }) => {
  const creating = vault.needsSetup;
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (creating && passphrase.length < MIN_LENGTH)
      return setError(`Use at least ${MIN_LENGTH} characters.`);
    if (creating && passphrase !== confirm) return setError('The passphrases do not match.');
    setBusy(true);
    setError(null);
    try {
      await (creating ? api.vaultSetup(passphrase) : api.vaultUnlock(passphrase));
      setPassphrase('');
      setConfirm('');
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setPassphrase('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel narrow" onSubmit={submit}>
      <h1>{creating ? 'Create a passphrase' : 'Unlock your keys'}</h1>
      <p className="muted">
        {creating
          ? 'There is no system keychain here, so your API keys are kept in a file encrypted with this passphrase. It is never stored; you will type it when the app starts.'
          : 'Your API keys are encrypted on this machine. Enter the passphrase to use them.'}
      </p>
      <label htmlFor={`${id}-pass`}>Passphrase</label>
      <input
        id={`${id}-pass`}
        type="password"
        autoComplete={creating ? 'new-password' : 'current-password'}
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
      />
      {creating ? (
        <>
          <label htmlFor={`${id}-confirm`}>Confirm passphrase</label>
          <input
            id={`${id}-confirm`}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <button type="submit" className="primary" disabled={busy || passphrase.length === 0}>
        {creating ? 'Create passphrase' : 'Unlock'}
      </button>
    </form>
  );
};
