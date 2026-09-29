"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@envoy/sdk";
import type {
  CalendarIntegrationConfig,
  EmailIntegrationConfig,
  Integration,
  WebhookIntegrationConfig,
} from "@envoy/sdk";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { useToast } from "../../../components/Toast";
import { useOAuthReturn } from "../../../lib/oauth-return";

const EMPTY_WEBHOOK: WebhookIntegrationConfig = { url: "", method: "POST", payloadTemplate: "" };
const EMPTY_EMAIL: EmailIntegrationConfig = { to: "", subject: "", bodyTemplate: "" };
const EMPTY_CALENDAR: CalendarIntegrationConfig = { titleTemplate: "", descriptionTemplate: "", startField: "" };

export default function IntegrationsPage() {
  const { showToast } = useToast();
  const [integrations, setIntegrations] = useState<Integration[] | undefined>(undefined);
  const [notEnabled, setNotEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<"webhook" | "email" | "calendar" | null>(null);

  function load() {
    api.integrations
      .list()
      .then(setIntegrations)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) setNotEnabled(true);
        else setError(errorMessage(err));
      });
  }

  useEffect(load, []);
  useOAuthReturn(
    () => {
      showToast("Google Calendar connected.");
      load();
    },
    (message) => setError(message),
  );

  function find(type: "webhook" | "email" | "calendar") {
    return integrations?.find((i) => i.type === type);
  }

  async function disconnect(type: "webhook" | "email" | "calendar") {
    setDisconnecting(null);
    try {
      await api.integrations.disconnect(type);
      load();
      showToast(`${type} disconnected.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (notEnabled) {
    return (
      <div>
        <h1 className="page-title">Integrations</h1>
        <div className="card" style={{ color: "var(--ink-faint)" }}>
          Integrations aren't enabled for your account yet. Ask your workspace admin to turn them on.
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="page-title">Integrations</h1>
      {error && <div className="error-banner">{error}</div>}
      <p style={{ fontSize: 13.5, color: "var(--ink-soft)" }}>
        Each of these fires automatically whenever a conversation completes with captured data. Use{" "}
        <code>{"{{fieldKey}}"}</code> in any template to insert a captured field's value.
      </p>

      {integrations === undefined ? null : (
        <>
          <WebhookCard
            connection={find("webhook")}
            onSaved={load}
            onDisconnect={() => setDisconnecting("webhook")}
            onError={(m) => setError(m)}
          />
          <EmailCard
            connection={find("email")}
            onSaved={load}
            onDisconnect={() => setDisconnecting("email")}
            onError={(m) => setError(m)}
          />
          <CalendarCard
            connection={find("calendar")}
            onSaved={load}
            onDisconnect={() => setDisconnecting("calendar")}
            onError={(m) => setError(m)}
          />
        </>
      )}

      <ConfirmDialog
        open={disconnecting !== null}
        title={`Disconnect ${disconnecting}?`}
        description="Completed conversations will stop triggering this integration. Its configuration will be lost."
        confirmLabel="Disconnect"
        danger
        onConfirm={() => disconnecting && disconnect(disconnecting)}
        onCancel={() => setDisconnecting(null)}
      />
    </div>
  );
}

function IntegrationShell({
  title,
  description,
  connected,
  onDisconnect,
  children,
}: {
  title: string;
  description: string;
  connected: boolean;
  onDisconnect: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong style={{ fontSize: 13.5 }}>{title}</strong>
        {connected ? (
          <span>
            <span className="pill pill-ok">connected</span>{" "}
            <button className="btn btn-danger" onClick={onDisconnect} style={{ fontSize: 12.5 }}>
              Disconnect
            </button>
          </span>
        ) : (
          <span className="pill pill-gray">not connected</span>
        )}
      </div>
      <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginBottom: 12 }}>{description}</p>
      {children}
    </div>
  );
}

function WebhookCard({
  connection,
  onSaved,
  onDisconnect,
  onError,
}: {
  connection?: Integration;
  onSaved: () => void;
  onDisconnect: () => void;
  onError: (m: string) => void;
}) {
  const [config, setConfig] = useState<WebhookIntegrationConfig>(
    (connection?.config as unknown as WebhookIntegrationConfig) ?? EMPTY_WEBHOOK,
  );
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const headers = Object.entries(config.headers ?? {});
  function setHeaders(next: Array<[string, string]>) {
    setConfig({ ...config, headers: Object.fromEntries(next) });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (connection) await api.integrations.updateConfig("webhook", config);
      else await api.integrations.connectWebhook(config);
      onSaved();
      showToast("Webhook saved.");
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <IntegrationShell
      title="Custom webhook"
      description="POST captured data to any endpoint you configure."
      connected={Boolean(connection)}
      onDisconnect={onDisconnect}
    >
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <select
            aria-label="HTTP method"
            value={config.method ?? "POST"}
            onChange={(e) => setConfig({ ...config, method: (e.target as HTMLSelectElement).value as WebhookIntegrationConfig["method"] })}
            style={{ width: 100 }}
          >
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
          </select>
          <input
            placeholder="https://example.com/webhook"
            value={config.url}
            onInput={(e) => setConfig({ ...config, url: (e.target as HTMLInputElement).value })}
            style={{ flex: 1 }}
          />
        </div>

        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>
            Headers <span style={{ fontWeight: 400, color: "var(--ink-faint)" }}>(e.g. Authorization)</span>
          </label>
          {headers.map(([name, value], i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <input
                aria-label={`Header ${i + 1} name`}
                placeholder="Header name"
                value={name}
                onInput={(e) => {
                  const next = headers.slice();
                  next[i] = [(e.target as HTMLInputElement).value, value];
                  setHeaders(next);
                }}
                style={{ flex: 1 }}
              />
              <input
                aria-label={`Header ${i + 1} value`}
                placeholder="Value"
                value={value}
                onInput={(e) => {
                  const next = headers.slice();
                  next[i] = [name, (e.target as HTMLInputElement).value];
                  setHeaders(next);
                }}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn"
                onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
                aria-label={`Remove header ${i + 1}`}
                style={{ fontSize: 12 }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() => setHeaders([...headers, ["", ""]])}
            style={{ fontSize: 12.5 }}
          >
            + Add header
          </button>
        </div>

        <textarea
          placeholder='Payload template (JSON, optional) — e.g. {"order_id": "{{orderId}}"}'
          value={config.payloadTemplate}
          onInput={(e) => setConfig({ ...config, payloadTemplate: (e.target as HTMLTextAreaElement).value })}
          rows={3}
        />
        <button type="submit" className="btn btn-primary" disabled={saving} style={{ fontSize: 12.5, alignSelf: "start" }}>
          {saving ? "Saving…" : "Save webhook"}
        </button>
      </form>
    </IntegrationShell>
  );
}

function EmailCard({
  connection,
  onSaved,
  onDisconnect,
  onError,
}: {
  connection?: Integration;
  onSaved: () => void;
  onDisconnect: () => void;
  onError: (m: string) => void;
}) {
  const [config, setConfig] = useState<EmailIntegrationConfig>(
    (connection?.config as unknown as EmailIntegrationConfig) ?? EMPTY_EMAIL,
  );
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (connection) await api.integrations.updateConfig("email", config);
      else await api.integrations.connectEmail(config);
      onSaved();
      showToast("Email integration saved.");
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <IntegrationShell
      title="Email on capture"
      description="Send an email whenever a conversation completes with captured data."
      connected={Boolean(connection)}
      onDisconnect={onDisconnect}
    >
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          placeholder="Recipient email"
          value={config.to}
          onInput={(e) => setConfig({ ...config, to: (e.target as HTMLInputElement).value })}
        />
        <input
          placeholder="Subject — e.g. New order from {{name}}"
          value={config.subject}
          onInput={(e) => setConfig({ ...config, subject: (e.target as HTMLInputElement).value })}
        />
        <textarea
          placeholder="Body template"
          value={config.bodyTemplate}
          onInput={(e) => setConfig({ ...config, bodyTemplate: (e.target as HTMLTextAreaElement).value })}
          rows={3}
        />
        <button type="submit" className="btn btn-primary" disabled={saving} style={{ fontSize: 12.5, alignSelf: "start" }}>
          {saving ? "Saving…" : "Save email"}
        </button>
      </form>
    </IntegrationShell>
  );
}

function CalendarCard({
  connection,
  onSaved,
  onDisconnect,
  onError,
}: {
  connection?: Integration;
  onSaved: () => void;
  onDisconnect: () => void;
  onError: (m: string) => void;
}) {
  const [config, setConfig] = useState<CalendarIntegrationConfig>(
    (connection?.config as unknown as CalendarIntegrationConfig) ?? EMPTY_CALENDAR,
  );
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const { showToast } = useToast();

  async function connect() {
    setConnecting(true);
    try {
      const result = await api.integrations.connectCalendar();
      if (result.mode === "oauth" && result.authorizeUrl) {
        window.location.href = result.authorizeUrl;
        return;
      }
      onSaved();
      showToast("Google Calendar connected.");
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setConnecting(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.integrations.updateConfig("calendar", config);
      onSaved();
      showToast("Calendar event settings saved.");
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <IntegrationShell
      title="Google Calendar event"
      description="Create a calendar event whenever a conversation completes with captured data."
      connected={Boolean(connection)}
      onDisconnect={onDisconnect}
    >
      {!connection ? (
        <button className="btn btn-primary" onClick={connect} disabled={connecting} style={{ fontSize: 12.5 }}>
          {connecting ? "Connecting…" : "Connect Google Calendar"}
        </button>
      ) : (
        <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            placeholder="Event title — e.g. Demo with {{name}}"
            value={config.titleTemplate}
            onInput={(e) => setConfig({ ...config, titleTemplate: (e.target as HTMLInputElement).value })}
          />
          <input
            placeholder="captured-field key holding the start time (ISO 8601)"
            value={config.startField}
            onInput={(e) => setConfig({ ...config, startField: (e.target as HTMLInputElement).value })}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Calendar ID (optional, defaults to primary)"
              value={config.calendarId ?? ""}
              onInput={(e) => setConfig({ ...config, calendarId: (e.target as HTMLInputElement).value || undefined })}
              style={{ flex: 1 }}
            />
            <input
              type="number"
              min={1}
              placeholder="Duration (min)"
              aria-label="Duration in minutes"
              value={config.durationMinutes ?? ""}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setConfig({ ...config, durationMinutes: v ? Number(v) : undefined });
              }}
              style={{ width: 130 }}
            />
          </div>
          <textarea
            placeholder="Description template (optional)"
            value={config.descriptionTemplate}
            onInput={(e) => setConfig({ ...config, descriptionTemplate: (e.target as HTMLTextAreaElement).value })}
            rows={2}
          />
          <button type="submit" className="btn btn-primary" disabled={saving} style={{ fontSize: 12.5, alignSelf: "start" }}>
            {saving ? "Saving…" : "Save event settings"}
          </button>
        </form>
      )}
    </IntegrationShell>
  );
}
