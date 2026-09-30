"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../../../lib/auth";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";
import { useToast } from "../../../components/Toast";

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const { showToast } = useToast();
  const [tenantName, setTenantName] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.account.getInfo().then((info) => setTenantName(info.name)).catch(() => {});
  }, []);

  const isOwner = user?.role === "owner";

  async function exportData() {
    setExporting(true);
    setError(null);
    try {
      const blob = await api.account.exportData();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "envoy-data-export.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  async function deleteAccount() {
    setDeleting(true);
    setError(null);
    try {
      await api.account.deleteAccount(confirmName);
      showToast("Account deleted.");
      logout();
    } catch (err) {
      setError(errorMessage(err));
      setDeleting(false);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 className="page-title">Settings</h1>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <strong style={{ display: "block", marginBottom: 8, fontSize: 13.5 }}>Your data</strong>
        <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginBottom: 12 }}>
          Download everything Envoy has stored for your account — agents, conversations, lead forms and their
          submissions — as a single JSON file. OAuth tokens for connected integrations are never included.
        </p>
        <button className="btn" onClick={exportData} disabled={exporting}>
          {exporting ? "Exporting…" : "Export my data"}
        </button>
      </div>

      {isOwner && (
        <div className="card" style={{ borderColor: "var(--stop)" }}>
          <strong style={{ display: "block", marginBottom: 8, fontSize: 13.5 }}>Danger zone</strong>
          <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginBottom: 12 }}>
            Permanently deletes this account and everything in it — agents, conversations, lead forms and
            submissions, CRM and integration connections. This can&apos;t be undone. Type{" "}
            <strong>{tenantName ?? "your business name"}</strong> to confirm.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={tenantName ?? ""}
              aria-label="Type your business name to confirm"
            />
            <button
              className="btn btn-danger"
              disabled={deleting || !tenantName || confirmName !== tenantName}
              onClick={deleteAccount}
            >
              {deleting ? "Deleting…" : "Delete account"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
