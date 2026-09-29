"use client";

import { BlockBuilder } from "@envoy/builder";
import "@envoy/builder/builder.css";
import {
  FIELD_ROW_PALETTE,
  FIELD_TYPE_LABELS,
  cloneFieldRow,
  fieldRowAdapter,
  type FieldRow,
  type FieldRowContainer,
} from "../../lib/agent-fields";
import { keyFromLabel, uniqueKey } from "../../lib/forms";

export function RequiredFieldsBuilder({
  fields,
  onChange,
}: {
  fields: FieldRow[];
  onChange(fields: FieldRow[]): void;
}) {
  const containers: FieldRowContainer[] = [{ id: "required-fields", items: fields }];

  return (
    <BlockBuilder<FieldRowContainer, FieldRow>
      adapter={fieldRowAdapter}
      containers={containers}
      fixedContainers
      onChange={(next) => {
        // eslint-disable-next-line no-console
        console.log("[debug] RequiredFieldsBuilder onChange", JSON.stringify(next[0]!.items.map((f) => f.label)));
        onChange(next[0]!.items);
      }}
      palette={FIELD_ROW_PALETTE}
      paletteTitle="Add"
      cloneBlock={cloneFieldRow}
      blockLabel={(f) => f.label || f.key || "Untitled field"}
      createContainer={() => ({ id: "required-fields", items: [] })}
      renderContainerHeader={() => null}
      renderBlock={(f) => (
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {f.label || "(no label)"}
            {f.required && <span className="ef-req"> *</span>}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-faint)", display: "flex", gap: 8 }}>
            <code>{f.key || "—"}</code>
            <span>{FIELD_TYPE_LABELS[f.type]}</span>
            {f.type === "select" && <span>{f.options.length} option{f.options.length === 1 ? "" : "s"}</span>}
          </div>
        </div>
      )}
      renderInspector={(selection, builder) => {
        if (selection?.kind !== "block") {
          return (
            <p className="fi-hint">
              {fields.length === 0
                ? "Drag “Required field” onto the canvas, or click it, to add one."
                : "Select a field to edit it."}
            </p>
          );
        }
        const f = selection.block;
        const otherKeys = new Set(fields.filter((x) => x.id !== f.id).map((x) => x.key));
        const update = (patch: Partial<FieldRow>) => builder.updateBlock(f.id, (b) => ({ ...b, ...patch }));

        function setLabel(label: string) {
          const autoKey = !f.key || f.key === uniqueKey(keyFromLabel(f.label), otherKeys);
          update({ label, ...(autoKey && label.trim() ? { key: uniqueKey(keyFromLabel(label), otherKeys) } : {}) });
        }

        return (
          <div className="fi">
            <div className="eb-pane-title">Required field</div>
            <label className="fi-row">
              <span className="fi-label">Label</span>
              <input value={f.label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
            </label>
            <label className="fi-row">
              <span className="fi-label">Field key</span>
              <input
                value={f.key}
                onInput={(e) => update({ key: (e.target as HTMLInputElement).value.replace(/[^a-zA-Z0-9_]/g, "") })}
              />
              <span className="fi-hint">Name this answer uses in the captured-data record, CRM, webhook, etc.</span>
            </label>
            <label className="fi-row">
              <span className="fi-label">Type</span>
              <select
                value={f.type}
                onChange={(e) => {
                  const type = (e.target as HTMLSelectElement).value as FieldRow["type"];
                  update({ type, options: type === "select" && f.options.length === 0 ? ["Option 1"] : f.options });
                }}
              >
                {Object.entries(FIELD_TYPE_LABELS).map(([t, l]) => (
                  <option key={t} value={t}>
                    {l}
                  </option>
                ))}
              </select>
            </label>

            {f.type === "select" && (
              <div className="fi-row">
                <span className="fi-label">Options</span>
                {f.options.map((opt, i) => (
                  <div key={i} className="fi-option">
                    <input
                      aria-label={`Option ${i + 1}`}
                      value={opt}
                      onInput={(e) =>
                        update({ options: f.options.map((o, j) => (j === i ? (e.target as HTMLInputElement).value : o)) })
                      }
                    />
                    <button
                      type="button"
                      className="eb-icon-btn"
                      aria-label={`Remove option ${i + 1}`}
                      disabled={f.options.length === 1}
                      onClick={() => update({ options: f.options.filter((_, j) => j !== i) })}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn fi-small-btn"
                  onClick={() => update({ options: [...f.options, `Option ${f.options.length + 1}`] })}
                >
                  + Add option
                </button>
              </div>
            )}

            <label className="fi-row">
              <span className="fi-label">Description for the agent</span>
              <textarea
                rows={2}
                placeholder="e.g. the visitor's preferred appointment date, in their own words"
                value={f.prompt}
                onInput={(e) => update({ prompt: (e.target as HTMLTextAreaElement).value })}
              />
            </label>
            <label className="fi-toggle">
              <input type="checkbox" checked={f.required} onChange={(e) => update({ required: e.target.checked })} />
              <span>Required</span>
            </label>
          </div>
        );
      }}
    />
  );
}
