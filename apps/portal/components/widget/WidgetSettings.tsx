"use client";

import { BlockBuilder } from "@envoy/builder";
import "@envoy/builder/builder.css";
import type { WidgetConfig, WidgetPosition, WidgetThemeMode } from "@envoy/types";
import type { Form } from "@envoy/sdk";
import { cloneQuickReply, newQuickReply, QUICK_REPLY_PALETTE, quickReplyAdapter, type QuickReplyContainer } from "../../lib/widget";

export function WidgetSettings({
  config,
  onChange,
  leadFormId,
  onLeadFormChange,
  forms,
}: {
  config: WidgetConfig;
  onChange(update: (c: WidgetConfig) => WidgetConfig): void;
  leadFormId: string | null;
  onLeadFormChange(id: string | null): void;
  forms: Form[];
}) {
  const set = (patch: Partial<WidgetConfig>) => onChange((c) => ({ ...c, ...patch }));
  const containers: QuickReplyContainer[] = [{ id: "quick-replies", items: config.quickReplies }];

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>Widget appearance</strong>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 14 }}>
        How the chat widget looks and opens on your site. Changes go live immediately — no redeploy.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="w-color">Accent color</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              id="w-color"
              type="color"
              value={config.primaryColor}
              onInput={(e) => set({ primaryColor: (e.target as HTMLInputElement).value })}
              style={{ width: 40, height: 34, padding: 2 }}
            />
            <input
              aria-label="Accent color hex"
              value={config.primaryColor}
              onInput={(e) => set({ primaryColor: (e.target as HTMLInputElement).value })}
              style={{ flex: 1 }}
            />
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="w-position">Launcher position</label>
          <select
            id="w-position"
            value={config.position}
            onChange={(e) => set({ position: (e.target as HTMLSelectElement).value as WidgetPosition })}
          >
            <option value="bottom-right">Bottom right</option>
            <option value="bottom-left">Bottom left</option>
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="w-theme">Theme</label>
          <select
            id="w-theme"
            value={config.themeMode}
            onChange={(e) => set({ themeMode: (e.target as HTMLSelectElement).value as WidgetThemeMode })}
          >
            <option value="auto">Match visitor's device</option>
            <option value="light">Always light</option>
            <option value="dark">Always dark</option>
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="w-launcher">Launcher label</label>
          <input
            id="w-launcher"
            value={config.launcherLabel}
            maxLength={40}
            onInput={(e) => set({ launcherLabel: (e.target as HTMLInputElement).value })}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="w-logo">Logo URL (optional)</label>
        <input
          id="w-logo"
          type="url"
          placeholder="https://…"
          value={config.logoUrl ?? ""}
          onInput={(e) => set({ logoUrl: (e.target as HTMLInputElement).value || undefined })}
        />
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="w-greeting">Greeting</label>
        <textarea
          id="w-greeting"
          rows={2}
          maxLength={300}
          value={config.greeting}
          onInput={(e) => set({ greeting: (e.target as HTMLTextAreaElement).value })}
        />
      </div>

      <div style={{ borderTop: "1px solid var(--line)", margin: "16px 0 12px" }} />

      <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>Conversation starters</strong>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 12 }}>
        Up to 6 suggested openers shown as chips before the visitor's first message. Drag to reorder.
      </p>
      {config.quickReplies.length < 6 && (
        <div style={{ marginBottom: 12 }}>
          <BlockBuilder<QuickReplyContainer, (typeof config.quickReplies)[number]>
            adapter={quickReplyAdapter}
            containers={containers}
            fixedContainers
            onChange={(next) => set({ quickReplies: next[0]!.items })}
            palette={QUICK_REPLY_PALETTE}
            paletteTitle="Add"
            cloneBlock={cloneQuickReply}
            blockLabel={(q) => q.label}
            createContainer={() => ({ id: "quick-replies", items: [] })}
            renderContainerHeader={() => null}
            renderBlock={(q) => (
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{q.label || "(no label)"}</div>
                <div style={{ fontSize: 12, color: "var(--ink-faint)" }}>{q.message || "(no message)"}</div>
              </div>
            )}
            renderInspector={(selection, builder) => {
              if (selection?.kind !== "block") {
                return (
                  <p className="fi-hint">
                    {config.quickReplies.length === 0
                      ? "Drag “Conversation starter” onto the canvas, or click it, to add one."
                      : "Select a starter to edit it."}
                  </p>
                );
              }
              const q = selection.block;
              return (
                <div className="fi">
                  <div className="eb-pane-title">Conversation starter</div>
                  <label className="fi-row">
                    <span className="fi-label">Button label</span>
                    <input
                      value={q.label}
                      maxLength={40}
                      onInput={(e) => builder.updateBlock(q.id, (b) => ({ ...b, label: (e.target as HTMLInputElement).value }))}
                    />
                  </label>
                  <label className="fi-row">
                    <span className="fi-label">Message sent when clicked</span>
                    <textarea
                      rows={3}
                      maxLength={300}
                      value={q.message}
                      onInput={(e) =>
                        builder.updateBlock(q.id, (b) => ({ ...b, message: (e.target as HTMLTextAreaElement).value }))
                      }
                    />
                  </label>
                </div>
              );
            }}
          />
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--line)", margin: "16px 0 12px" }} />

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="w-form">Lead form</label>
        <select
          id="w-form"
          value={leadFormId ?? ""}
          onChange={(e) => onLeadFormChange((e.target as HTMLSelectElement).value || null)}
        >
          <option value="">None — chat only</option>
          {forms.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} {f.status === "draft" ? "(draft — publish it to show in the widget)" : ""}
            </option>
          ))}
        </select>
        <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 4 }}>
          Adds a “Fill out form” button to the widget so a visitor can submit it without leaving the chat.
        </p>
      </div>
    </div>
  );
}
