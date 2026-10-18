import type { SetupState } from '@vc/config';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, errorMessage } from './api';
import { Link, navigate, useRoute } from './router';
import { CreateScreen } from './screens/CreateScreen';
import { JobScreen } from './screens/JobScreen';
import { JobsScreen } from './screens/JobsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SetupScreen } from './screens/SetupScreen';
import { VaultScreen } from './screens/VaultScreen';

type AppState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; setup: SetupState };

const Shell = ({ nav, children }: { nav: boolean; children: ReactNode }) => (
  <div className="app">
    <header className="app-header">
      <Link to="/" className="brand">
        Video Creator
      </Link>
      {nav ? (
        <nav aria-label="Main">
          <Link to="/create">Create</Link>
          <Link to="/jobs">Jobs</Link>
          <Link to="/settings">Settings</Link>
        </nav>
      ) : null}
    </header>
    <main className="app-main">{children}</main>
  </div>
);

export const App = () => {
  const [state, setState] = useState<AppState>({ status: 'loading' });
  const route = useRoute();

  const load = useCallback(() => {
    api.getSetup().then(
      (setup) => setState({ status: 'ready', setup }),
      (error: unknown) => setState({ status: 'error', message: errorMessage(error) }),
    );
  }, []);

  useEffect(load, [load]);

  const setSetup = useCallback((setup: SetupState) => setState({ status: 'ready', setup }), []);

  if (state.status === 'loading') {
    return (
      <Shell nav={false}>
        <p className="muted">Loading…</p>
      </Shell>
    );
  }
  if (state.status === 'error') {
    return (
      <Shell nav={false}>
        <div className="panel">
          <h1>Can’t reach the local server</h1>
          <p role="alert">{state.message}</p>
          <button
            type="button"
            onClick={() => {
              setState({ status: 'loading' });
              load();
            }}
          >
            Retry
          </button>
        </div>
      </Shell>
    );
  }

  const { setup } = state;
  if (setup.vault.needsSetup || setup.vault.locked) {
    return (
      <Shell nav={false}>
        <VaultScreen vault={setup.vault} onDone={load} />
      </Shell>
    );
  }
  if (!setup.complete) {
    return (
      <Shell nav={false}>
        <SetupScreen setup={setup} onSetupChange={setSetup} onContinue={load} />
      </Shell>
    );
  }

  const screen = (() => {
    switch (route.name) {
      case 'create':
        return <CreateScreen setupComplete={setup.complete} />;
      case 'jobs':
        return <JobsScreen />;
      case 'job':
        return <JobScreen key={route.id} id={route.id} />;
      case 'settings':
        return <SettingsScreen setup={setup} onSetupChange={setSetup} />;
      case 'setup':
        return (
          <SetupScreen
            setup={setup}
            onSetupChange={setSetup}
            onContinue={() => navigate('/create')}
          />
        );
      case 'not-found':
        return (
          <div className="panel">
            <h1>Page not found</h1>
            <Link to="/create">Create a video</Link>
          </div>
        );
    }
  })();
  return <Shell nav>{screen}</Shell>;
};
