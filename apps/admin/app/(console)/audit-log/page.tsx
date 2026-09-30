"use client";

import { useEffect, useState } from "react";
import type { AuditLogEntry } from "@envoy/sdk";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";

type Filter = "all" | "platform" | "tenant";

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    api.admin.listAuditLog().then(setEntries).catch((err) => setError(errorMessage(err)));
  }, []);

  const rows = (entries ?? []).filter((e) => {
    if (filter === "platform") return e.adminUser.role === "platform_admin";
    if (filter === "tenant") return e.adminUser.role !== "platform_admin";
    return true;
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 className="page-title page-title--flush">Audit log</h1>
        <select aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} style={{ width: 200 }}>
          <option value="all">All actions</option>
          <option value="platform">Platform actions</option>
          <option value="tenant">Tenant actions</option>
        </select>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {entries && rows.length === 0 && (
        <div className="card" style={{ textAlign: "center", color: "var(--ink-faint)" }}>
          {entries.length === 0 ? "No actions recorded yet." : "No actions match this filter."}
        </div>
      )}

      {rows.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Who</th>
                <th>When</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>
                    <code style={{ fontSize: 12 }}>{e.action}</code>
                  </td>
                  <td>
                    <span className={`pill ${e.adminUser.role === "platform_admin" ? "pill-warn" : "pill-gray"}`} style={{ marginRight: 6 }}>
                      {e.adminUser.role === "platform_admin" ? "platform" : "tenant"}
                    </span>
                    {e.adminUser.email}
                  </td>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td style={{ fontSize: 12, color: "var(--ink-faint)" }}>
                    {Object.keys(e.meta).length > 0 ? JSON.stringify(e.meta) : "—"}
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
