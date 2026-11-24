"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ModelStatus } from "@envoy/sdk";
import { PROVIDER_LABELS } from "@envoy/types";
import { api } from "../../lib/api";

/** "Running on: …" for an agent's reply model, with a push toward connecting a key when it's still on the shared default. */
export function ModelBadge({ agentic, override }: { agentic: boolean; override: boolean }) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  useEffect(() => {
    api.models.status().then(setStatus).catch(() => {});
  }, []);
  if (!status) return null;

  const chat = status.roles.chat;
  const onDefault = chat.source === "platform" && !override;
  return (
    <div style={{ fontSize: 12.5, margin: "-8px 0 16px", color: "var(--ink-faint)" }}>
      Running on:{" "}
      {override ? (
        <b>this agent&apos;s own model override</b>
      ) : chat.source === "tenant" ? (
        <b>
          {chat.model} ({PROVIDER_LABELS[chat.provider!]}) — your key
        </b>
      ) : (
        <b>shared default model</b>
      )}
      {onDefault && (
        <>
          {" · "}
          <Link href="/dashboard/models">Connect your own key</Link>
          {agentic && (
            <span style={{ color: "var(--warn)" }}>
              {" "}
              — agentic agents depend on strong tool use, which the shared model does least reliably.
            </span>
          )}
        </>
      )}
    </div>
  );
}
