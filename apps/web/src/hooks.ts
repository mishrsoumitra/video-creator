import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { errorMessage } from './api';

export type Loadable<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: string };

/** Loads data once (and again when `key` changes); `reload` refetches. */
export const useLoad = <T>(
  load: () => Promise<T>,
  key = '',
): Loadable<T> & { reload: () => void } => {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const run = useEffectEvent(() => load());

  useEffect(() => {
    let alive = true;
    run().then(
      (data) => alive && setState({ status: 'ready', data }),
      (error: unknown) => alive && setState({ status: 'error', error: errorMessage(error) }),
    );
    return () => {
      alive = false;
    };
  }, [key, nonce]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setNonce((v) => v + 1);
  }, []);
  return { ...state, reload };
};

/** Runs `effect` after `delayMs` of quiet whenever `key` changes. */
export const useDebouncedEffect = (
  effect: () => void | (() => void),
  key: string,
  delayMs: number,
) => {
  const fire = useEffectEvent(effect);
  useEffect(() => {
    let cleanup: void | (() => void);
    const timer = setTimeout(() => {
      cleanup = fire();
    }, delayMs);
    return () => {
      clearTimeout(timer);
      if (typeof cleanup === 'function') cleanup();
    };
  }, [key, delayMs]);
};
