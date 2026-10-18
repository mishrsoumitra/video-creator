import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Link, navigate, parseRoute, useRoute } from './router';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('parseRoute', () => {
  it.each([
    ['/', { name: 'create' }],
    ['/create', { name: 'create' }],
    ['/jobs', { name: 'jobs' }],
    ['/jobs/abc-123', { name: 'job', id: 'abc-123' }],
    ['/settings', { name: 'settings' }],
    ['/setup', { name: 'setup' }],
    ['/nope', { name: 'not-found' }],
  ])('%s', (path, route) => {
    expect(parseRoute(path)).toEqual(route);
  });
});

const Show = () => {
  const route = useRoute();
  return (
    <div>
      <p data-testid="route">{JSON.stringify(route)}</p>
      <Link to="/jobs/j7">Open job</Link>
    </div>
  );
};

describe('router', () => {
  it('follows navigate() and Link clicks without reloading', async () => {
    render(<Show />);
    expect(screen.getByTestId('route').textContent).toBe('{"name":"create"}');
    act(() => navigate('/settings'));
    expect(screen.getByTestId('route').textContent).toBe('{"name":"settings"}');
    await userEvent.click(screen.getByRole('link', { name: 'Open job' }));
    expect(screen.getByTestId('route').textContent).toBe('{"name":"job","id":"j7"}');
    expect(window.location.pathname).toBe('/jobs/j7');
  });

  it('responds to the back button', () => {
    render(<Show />);
    act(() => navigate('/jobs'));
    act(() => {
      window.history.replaceState(null, '', '/settings');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByTestId('route').textContent).toBe('{"name":"settings"}');
  });
});
