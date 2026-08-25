"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AdminTenant } from "@envoy/sdk";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { useToast } from "../../../components/Toast";
import { BuildingIcon, CheckCircleIcon, AlertIcon, DollarIcon } from "../../../components/icons";

type PendingAction =
  | { kind: "pause"; tenant: AdminTenant }
  | { kind: "revoke"; tenant: AdminTenant };

const STATUS_PILL: Record<AdminTenant["subscriptionStatus"], string> = {
  active: "pill-ok",
  past_due: "pill-warn",
  locked: "pill-stop",
  cancelled: "pill-gray",
};

export default function TenantsPage() {
  const { showToast } = useToast();
  const [tenants, setTenants] = useState<AdminTenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  function load() {
    api.admin.listTenants().then(setTenants).catch((err) => setError(errorMessage(err)));
  }

  useEffect(load, []);

  async function withBusy(id: string, action: () => Promise<void>, successMessage?: string) {
    setBusyId(id);
    setError(null);
    try {
      await action();
      load();
      if (successMessage) showToast(successMessage);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function runPendingAction() {
    if (!pending) return;
    const { kind, tenant } = pending;
    setPending(null);
    if (kind === "pause") {
      await withBusy(tenant.id, () => api.admin.pauseTenant(tenant.id), `${tenant.name} paused.`);
    } else {
      await withBusy(tenant.id, () => api.admin.revokeTenant(tenant.id), `${tenant.name} revoked.`);
    }
  }

  const activeCount = tenants?.filter((t) => t.subscriptionStatus === "active").length ?? 0;
  const attentionCount =
    tenants?.filter((t) => t.subscriptionStatus === "past_due" || t.subscriptionStatus === "locked").length ?? 0;
  const mrrCents =
    tenants
      ?.filter((t) => t.subscriptionStatus === "active" || t.subscriptionStatus === "past_due")
      .reduce((sum, t) => sum + (t.subscription?.monthlyRate ?? 0), 0) ?? 0;

  return (
    <div>
      <h1 className="page-title">Tenants</h1>
      {error && <div className="error-banner">{error}</div>}

      {tenants && (
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-card-top">
              <span className="stat-card-icon">
                <BuildingIcon size={16} />
              </span>
            </div>
            <div className="stat-card-value">{tenants.length}</div>
            <div className="stat-card-label">Total tenants</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-top">
              <span className="stat-card-icon">
                <CheckCircleIcon size={16} />
              </span>
            </div>
            <div className="stat-card-value">{activeCount}</div>
            <div className="stat-card-label">Active</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-top">
              <span className="stat-card-icon">
                <AlertIcon size={16} />
              </span>
            </div>
            <div className="stat-card-value">{attentionCount}</div>
            <div className="stat-card-label">Needs attention</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-top">
              <span className="stat-card-icon">
                <DollarIcon size={16} />
              </span>
            </div>
            <div className="stat-card-value">${(mrrCents / 100).toLocaleString()}</div>
            <div className="stat-card-label">Monthly recurring</div>
          </div>
        </div>
      )}

      {!tenants && !error && (
        <div className="card" style={{ textAlign: "center", color: "var(--ink-faint)" }}>
          Loading tenants…
        </div>
      )}

      {tenants && tenants.length === 0 && (
        <div className="card" style={{ textAlign: "center", color: "var(--ink-faint)" }}>
          No tenants have signed up yet.
        </div>
      )}

      {tenants && tenants.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th className="num">Agents</th>
                <th className="num">Users</th>
                <th className="num">Conversations</th>
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
                  <td className="num">{t._count.agents}</td>
                  <td className="num">{t._count.users}</td>
                  <td className="num">{t._count.conversations}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    {t.subscriptionStatus === "locked" ? (
                      <button
                        className="btn"
                        disabled={busyId === t.id}
                        onClick={() => withBusy(t.id, () => api.admin.resumeTenant(t.id), `${t.name} resumed.`)}
                      >
                        Resume
                      </button>
                    ) : (
                      t.subscriptionStatus !== "cancelled" && (
                        <button
                          className="btn"
                          disabled={busyId === t.id}
                          onClick={() => setPending({ kind: "pause", tenant: t })}
                        >
                          Pause
                        </button>
                      )
                    )}
                    {t.subscriptionStatus !== "cancelled" && (
                      <button
                        className="btn btn-danger"
                        disabled={busyId === t.id}
                        onClick={() => setPending({ kind: "revoke", tenant: t })}
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

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "revoke" ? `Revoke ${pending.tenant.name}?` : `Pause ${pending?.tenant.name}?`}
        description={
          pending?.kind === "revoke"
            ? "This is a soft-cancel — no data is deleted, and the tenant can be restored later. Their agents and widget will stop responding to visitors immediately."
            : "Their agents and widget will stop responding to visitors until you resume the account. Nothing is deleted."
        }
        confirmLabel={pending?.kind === "revoke" ? "Revoke access" : "Pause access"}
        danger
        busy={busyId !== null}
        onConfirm={runPendingAction}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
