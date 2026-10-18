import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../test/mock-api';
import { JobsScreen } from './JobsScreen';

afterEach(() => vi.unstubAllGlobals());

describe('JobsScreen', () => {
  it('lists jobs with their status and cost, linking to each', async () => {
    mockApi({
      'GET /api/jobs': [
        {
          id: 'job2',
          topic: 'Volcanoes',
          lengthSeconds: 60,
          status: 'done',
          createdAt: '2026-10-18T11:00:00Z',
          updatedAt: '2026-10-18T11:05:00Z',
          costUsd: 0.05,
        },
        {
          id: 'job1',
          topic: 'The Apollo program',
          lengthSeconds: 90,
          status: 'review',
          createdAt: '2026-10-18T10:00:00Z',
          updatedAt: '2026-10-18T10:02:00Z',
          costUsd: 0.0126,
        },
      ],
    });
    render(<JobsScreen />);
    const table = await screen.findByRole('table', { name: 'Jobs' });
    expect(within(table).getByRole('link', { name: 'Volcanoes' })).toHaveAttribute(
      'href',
      '/jobs/job2',
    );
    expect(within(table).getByText('Done')).toBeInTheDocument();
    expect(within(table).getByText('Ready for review')).toBeInTheDocument();
    expect(within(table).getByText('$0.0126')).toBeInTheDocument();
  });

  it('says when there are no jobs yet', async () => {
    mockApi({ 'GET /api/jobs': [] });
    render(<JobsScreen />);
    expect(await screen.findByText(/no videos yet/i)).toBeInTheDocument();
  });
});
