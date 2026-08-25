"use client";

import { useEffect, useState } from "react";
import type { AuditLogEntry } from "@envoy/sdk";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.admin.listAuditLog().then(setEntries).catch((err) => setError(errorMessage(err)));
  }, []);

  return (
    <div>
      <h1 className="page-title">Audit log</h1>
      {error && <div className="error-banner">{error}</div>}

      {entries && entries.length === 0 && (
        <div className="card" style={{ textAlign: "center", color: "var(--ink-faint)" }}>
          No admin actions recorded yet.
        </div>
      )}

      {entries && entries.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Admin</th>
                <th>When</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>
                    <code style={{ fontSize: 12 }}>{e.action}</code>
                  </td>
                  <td>{e.adminUser.email}</td>
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
