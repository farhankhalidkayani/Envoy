"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ModelStatus } from "@envoy/sdk";
import { api } from "../../lib/api";

/**
 * Shown on every dashboard page until the workspace is served by its own model key. The shared default model
 * works, but a stronger model of your own gives noticeably better results — so we say so, persistently.
 */
export function ModelBanner() {
  const pathname = usePathname();
  const [status, setStatus] = useState<ModelStatus | null>(null);

  // Re-read when navigating, so the banner clears as soon as a key is connected on the models page.
  useEffect(() => {
    api.models.status().then(setStatus).catch(() => setStatus(null));
  }, [pathname]);

  if (!status || pathname === "/dashboard/models") return null;
  if (status.hasInvalidCredential) {
    return (
      <div className="model-banner" role="status">
        <span>
          <strong>One of your AI model keys was rejected by its provider.</strong> Until you fix it, your agents are answering from the
          shared default model.
        </span>
        <Link href="/dashboard/models" className="btn">Fix API key</Link>
      </div>
    );
  }
  if (!status.usingPlatformDefault) return null;
  return (
    <div className="model-banner" role="status">
      <span>
        <strong>Your agents are running on the shared default model.</strong> It works, but results — reliable tool use, rule
        compliance, accurate data capture — are noticeably better on a model you choose. Connect your own API key (Claude, GPT,
        Gemini…); you pay your provider directly.
      </span>
      <Link href="/dashboard/models" className="btn btn-primary">Connect your own model</Link>
    </div>
  );
}
