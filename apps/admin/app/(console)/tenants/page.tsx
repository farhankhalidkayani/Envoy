"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AdminTenant } from "@envoy/sdk";
import { api } from "../../../lib/api";
import { errorMessage } from "../layout";

const STATUS_PILL: Record<AdminTenant["subscriptionStatus"], string> = {
  active: "pill-ok",
  past_due: "pill-warn",
  locked: "pill-stop",
  cancelled: "pill-gray",
};

export default function TenantsPage() {
  const [tenants, setTenants] = useState<AdminTenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    api.admin.listTenants().then(setTenants).catch((err) => setError(errorMessage(err)));
  }

  useEffect(load, []);

  async function withBusy(id: string, action: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await action();
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, marginBottom: 20 }}>Tenants</h1>
      {error && <div className="error-banner">{error}</div>}

      {tenants && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Agents</th>
                <th>Users</th>
                <th>Conversations</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link href={`/tenants/${t.id}`}>{t.name}</Link>
                  </td>
                  <td>
                    <span className={`pill ${STATUS_PILL[t.subscriptionStatus]}`}>
                      {t.subscriptionStatus}
                    </span>
                  </td>
                  <td>{t._count.agents}</td>
                  <td>{t._count.users}</td>
                  <td>{t._count.conversations}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    {t.subscriptionStatus === "locked" ? (
                      <button
                        className="btn"
                        disabled={busyId === t.id}
                        onClick={() => withBusy(t.id, () => api.admin.resumeTenant(t.id))}
                      >
                        Resume
                      </button>
                    ) : (
                      t.subscriptionStatus !== "cancelled" && (
                        <button
                          className="btn"
                          disabled={busyId === t.id}
                          onClick={() => withBusy(t.id, () => api.admin.pauseTenant(t.id))}
                        >
                          Pause
                        </button>
                      )
                    )}
                    {t.subscriptionStatus !== "cancelled" && (
                      <button
                        className="btn btn-danger"
                        disabled={busyId === t.id}
                        onClick={() => {
                          if (confirm(`Revoke ${t.name}? This is a soft-cancel — no data is deleted.`)) {
                            withBusy(t.id, () => api.admin.revokeTenant(t.id));
                          }
                        }}
                      >
                        Revoke
                      </button>
                    )}
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
