import { newId, type BuilderAdapter, type PaletteItem } from "@envoy/builder";
import type { QuickReply } from "@envoy/types";

/** Quick replies are a single flat list, not steps — one fixed pseudo-container wraps them for BlockBuilder. */
export interface QuickReplyContainer {
  id: "quick-replies";
  items: QuickReply[];
}

export const quickReplyAdapter: BuilderAdapter<QuickReplyContainer, QuickReply> = {
  containerId: (c) => c.id,
  blockId: (q) => q.id,
  blocks: (c) => c.items,
  withBlocks: (c, items) => ({ ...c, items }),
};

export function newQuickReply(): QuickReply {
  return { id: newId("qr"), label: "New starter", message: "" };
}

export const QUICK_REPLY_PALETTE: PaletteItem<QuickReply>[] = [
  { type: "reply", label: "Conversation starter", icon: "💬", create: newQuickReply },
];

export function cloneQuickReply(q: QuickReply): QuickReply {
  return { ...q, id: newId("qr") };
}
