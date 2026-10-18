import { api } from '../api';
import { formatDateTime, formatDuration, formatUsd, statusLabel } from '../format';
import { useLoad } from '../hooks';
import { Link } from '../router';

export const JobsScreen = () => {
  const jobs = useLoad(api.listJobs);
  return (
    <div className="jobs">
      <h1>Jobs</h1>
      {jobs.status === 'loading' ? <p className="muted">Loading…</p> : null}
      {jobs.status === 'error' ? (
        <p className="error">
          {jobs.error}{' '}
          <button type="button" onClick={jobs.reload}>
            Retry
          </button>
        </p>
      ) : null}
      {jobs.status === 'ready' && jobs.data.length === 0 ? (
        <p className="muted">
          No videos yet. <Link to="/create">Create one.</Link>
        </p>
      ) : null}
      {jobs.status === 'ready' && jobs.data.length > 0 ? (
        <section className="panel">
          <table className="data">
            <caption>Jobs</caption>
            <thead>
              <tr>
                <th scope="col">Topic</th>
                <th scope="col">Length</th>
                <th scope="col">Status</th>
                <th scope="col">AI cost</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((j) => (
                <tr key={j.id}>
                  <td>
                    <Link to={`/jobs/${encodeURIComponent(j.id)}`}>{j.topic}</Link>
                  </td>
                  <td>{formatDuration(j.lengthSeconds)}</td>
                  <td>
                    <span className={`status ${j.status}`}>{statusLabel(j.status)}</span>
                  </td>
                  <td>{formatUsd(j.costUsd, true)}</td>
                  <td>{formatDateTime(j.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
};
