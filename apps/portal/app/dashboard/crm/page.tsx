"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@envoy/sdk";
import type { CrmConnection } from "@envoy/sdk";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";

interface MappingRow {
  envoyKey: string;
  crmProperty: string;
}

export default function CrmPage() {
  const [connection, setConnection] = useState<CrmConnection | null | undefined>(undefined);
  const [notEnabled, setNotEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [saving, setSaving] = useState(false);

  function load() {
    api.crm
      .getConnection()
      .then((c) => {
        setConnection(c ?? null);
        setRows(
          c ? Object.entries(c.fieldMapping).map(([envoyKey, crmProperty]) => ({ envoyKey, crmProperty })) : [],
        );
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setNotEnabled(true);
        } else {
          setError(errorMessage(err));
        }
      });
  }

  useEffect(load, []);

  async function connect() {
    setConnecting(true);
    setError(null);
    try {
      await api.crm.connect();
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect your CRM? Field mapping will be lost.")) return;
    try {
      await api.crm.disconnect();
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function addRow() {
    setRows((prev) => [...prev, { envoyKey: "", crmProperty: "" }]);
  }
  function updateRow(i: number, patch: Partial<MappingRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function saveMapping(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const mapping = Object.fromEntries(
        rows.filter((r) => r.envoyKey && r.crmProperty).map((r) => [r.envoyKey, r.crmProperty]),
      );
      await api.crm.updateMapping(mapping);
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (notEnabled) {
    return (
      <div>
        <h1 style={{ fontSize: 20, marginBottom: 16 }}>CRM</h1>
        <div className="card" style={{ color: "var(--ink-faint)" }}>
          CRM sync isn't enabled for your account yet. Ask your workspace admin to turn it on.
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>CRM</h1>
      {error && <div className="error-banner">{error}</div>}

      {connection === undefined ? null : !connection ? (
        <div className="card">
          <p style={{ fontSize: 13.5, color: "var(--ink-soft)", marginBottom: 14 }}>
            Not connected. Completed conversations will automatically push captured data to your
            CRM once connected.
          </p>
          <button className="btn btn-primary" onClick={connect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect HubSpot"}
          </button>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>
                <span className="pill pill-ok">connected</span>{" "}
                <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>
                  {connection.provider}
                </span>
              </span>
              <button className="btn btn-danger" onClick={disconnect} style={{ fontSize: 12.5 }}>
                Disconnect
              </button>
            </div>
          </div>

          <div className="card">
            <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>Field mapping</strong>
            <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginBottom: 12 }}>
              Map your agents' required-field keys to CRM property names. Unmapped fields push
              through using their original key.
            </p>
            <form onSubmit={saveMapping}>
              {rows.map((row, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <input
                    placeholder="envoy field key (e.g. email)"
                    value={row.envoyKey}
                    onInput={(e) => updateRow(i, { envoyKey: (e.target as HTMLInputElement).value })}
                    style={{ flex: 1 }}
                  />
                  <input
                    placeholder="CRM property (e.g. email_address)"
                    value={row.crmProperty}
                    onInput={(e) => updateRow(i, { crmProperty: (e.target as HTMLInputElement).value })}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="btn" onClick={() => removeRow(i)} style={{ fontSize: 12 }}>
                    ✕
                  </button>
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button type="button" className="btn" onClick={addRow} style={{ fontSize: 12.5 }}>
                  + Add mapping
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving} style={{ fontSize: 12.5 }}>
                  {saving ? "Saving…" : "Save mapping"}
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
