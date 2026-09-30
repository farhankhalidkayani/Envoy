"use client";

import { useEffect, useState } from "react";
import type { Lead } from "@envoy/sdk";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";

const DESTINATIONS = ["webhook", "email", "calendar"] as const;
const PAGE_SIZE = 50;

function summarizeData(data: Record<string, unknown>): string {
  const parts = Object.entries(data)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${k}: ${v}`);
  return parts.join(" · ") || "—";
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.leads
      .list(PAGE_SIZE)
      .then((page) => {
        setLeads(page.leads);
        setHasMore(page.hasMore);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  async function loadMore() {
    setLoadingMore(true);
    setError(null);
    try {
      const nextLimit = limit + PAGE_SIZE;
      const page = await api.leads.list(nextLimit);
      setLeads(page.leads);
      setHasMore(page.hasMore);
      setLimit(nextLimit);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div>
      <h1 className="page-title">Leads</h1>
      <p style={{ color: "var(--ink-faint)", fontSize: 12.5, marginBottom: 16 }}>
        Every completed conversation and form submission in one feed, newest first.
      </p>
      {error && <div className="error-banner">{error}</div>}

      {!leads && !error && (
        <div className="card" style={{ textAlign: "center", color: "var(--ink-faint)" }}>
          Loading…
        </div>
      )}

      {leads && leads.length === 0 && (
        <div className="card" style={{ textAlign: "center", color: "var(--ink-faint)" }}>
          No leads yet — completed conversations and form submissions will show up here.
        </div>
      )}

      {leads && leads.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Captured</th>
                <th>Delivered to</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => {
                const statuses: Array<{ dest: "crm" | (typeof DESTINATIONS)[number]; ok: boolean; error?: string }> = [];
                if (lead.crmPushedAt || lead.crmPushError) {
                  statuses.push({ dest: "crm", ok: !!lead.crmPushedAt, error: lead.crmPushError ?? undefined });
                }
                for (const d of DESTINATIONS) {
                  const s = lead.integrationStatus[d];
                  if (s) statuses.push({ dest: d, ok: !!s.pushedAt, error: s.error });
                }
                return (
                  <tr key={`${lead.source}:${lead.id}`}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <span className={`pill ${lead.source === "conversation" ? "pill-warn" : "pill-ok"}`}>
                        {lead.source === "conversation" ? "Agent" : "Form"}
                      </span>{" "}
                      {lead.sourceLabel}
                    </td>
                    <td style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {summarizeData(lead.data)}
                    </td>
                    <td>
                      {statuses.length === 0 ? (
                        <span className="fb-muted">No destinations connected</span>
                      ) : (
                        statuses.map((s) => (
                          <span
                            key={s.dest}
                            className={`pill ${s.ok ? "pill-ok" : "pill-stop"}`}
                            style={{ marginRight: 4 }}
                            title={s.ok ? undefined : s.error}
                          >
                            {s.dest}
                          </span>
                        ))
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{new Date(lead.createdAt).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <button className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
