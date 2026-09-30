"use client";

import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";
import { useToast } from "../../../components/Toast";

type FailedJob = {
  queue: string;
  id: string;
  name: string;
  data: Record<string, unknown>;
  failedReason: string;
  attemptsMade: number;
  timestamp: number;
};

function summarizeData(data: Record<string, unknown>): string {
  const parts = Object.entries(data)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k}: ${v}`);
  return parts.join(", ") || "—";
}

export default function JobsPage() {
  const { showToast } = useToast();
  const [jobs, setJobs] = useState<FailedJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  function load() {
    api.admin.listFailedJobs().then(setJobs).catch((err) => setError(errorMessage(err)));
  }

  useEffect(load, []);

  async function retry(job: FailedJob) {
    const key = `${job.queue}:${job.id}`;
    setRetrying(key);
    setError(null);
    try {
      await api.admin.retryJob(job.queue, job.id);
      showToast("Job re-queued.");
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div>
      <h1 className="page-title">Failed jobs</h1>
      <p style={{ color: "var(--ink-faint)", fontSize: 12.5, marginBottom: 16 }}>
        Background jobs (CRM/integration pushes, AI summaries, the retention sweep) that exhausted every retry
        attempt. Each one already failed a real attempt — check the error before retrying blindly.
      </p>
      {error && <div className="error-banner">{error}</div>}

      {!jobs && !error && (
        <div className="card" style={{ textAlign: "center", color: "var(--ink-faint)" }}>
          Loading…
        </div>
      )}

      {jobs && jobs.length === 0 && (
        <div className="card" style={{ textAlign: "center", color: "var(--ink-faint)" }}>
          No failed jobs. Everything queued has either succeeded or is still retrying.
        </div>
      )}

      {jobs && jobs.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Queue</th>
                <th>Data</th>
                <th>Error</th>
                <th className="num">Attempts</th>
                <th>Failed at</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={`${job.queue}:${job.id}`}>
                  <td>{job.queue}</td>
                  <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {summarizeData(job.data)}
                  </td>
                  <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {job.failedReason}
                  </td>
                  <td className="num">{job.attemptsMade}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(job.timestamp).toLocaleString()}</td>
                  <td>
                    <button
                      className="btn"
                      disabled={retrying === `${job.queue}:${job.id}`}
                      onClick={() => retry(job)}
                    >
                      {retrying === `${job.queue}:${job.id}` ? "Retrying…" : "Retry"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
