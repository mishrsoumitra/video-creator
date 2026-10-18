import { useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export type Route =
  | { name: 'create' }
  | { name: 'jobs' }
  | { name: 'job'; id: string }
  | { name: 'settings' }
  | { name: 'setup' }
  | { name: 'not-found' };

export const parseRoute = (pathname: string): Route => {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'create'))
    return { name: 'create' };
  if (parts[0] === 'jobs' && parts.length === 1) return { name: 'jobs' };
  if (parts[0] === 'jobs' && parts.length === 2)
    return { name: 'job', id: decodeURIComponent(parts[1]!) };
  if (parts.length === 1 && parts[0] === 'settings') return { name: 'settings' };
  if (parts.length === 1 && parts[0] === 'setup') return { name: 'setup' };
  return { name: 'not-found' };
};

const NAVIGATE = 'vc:navigate';

const subscribe = (onChange: () => void) => {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATE, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATE, onChange);
  };
};

export const navigate = (to: string, { replace = false }: { replace?: boolean } = {}) => {
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAVIGATE));
};

export const useRoute = (): Route => {
  const pathname = useSyncExternalStore(subscribe, () => window.location.pathname);
  return useMemo(() => parseRoute(pathname), [pathname]);
};

export const Link = ({
  to,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
  <a
    href={to}
    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      navigate(to);
    }}
    {...rest}
  />
);
