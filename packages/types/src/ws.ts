import { z } from "zod";
import { OutcomeType } from "./enums.js";
import { WidgetConfig } from "./widget-config.js";

/**
 * WebSocket protocol between the embeddable widget (client) and the agent
 * engine (server), scoped to one agent's public token. Discriminated unions
 * keyed on `type` so both sides can `switch` exhaustively.
 */

// ── Client → Server ─────────────────────────────────────────────

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.start"),
    agentId: z.string(),
    publicToken: z.string(),
  }),
  z.object({
    type: z.literal("user.message"),
    text: z.string().min(1).max(4000),
  }),
  z.object({
    type: z.literal("user.audio"),
    chunk: z.string(), // base64-encoded audio of one full utterance
    mimeType: z.string(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ── Server → Client ─────────────────────────────────────────────

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.ready"),
    widgetConfig: WidgetConfig,
  }),
  z.object({
    type: z.literal("agent.message"),
    delta: z.string().optional(),
    text: z.string().optional(),
    done: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("agent.audio"),
    chunk: z.string(), // base64-encoded audio of one full synthesized reply
    mimeType: z.string(),
  }),
  z.object({
    type: z.literal("transcript"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("session.completed"),
    outcomeType: OutcomeType.optional(),
    capturedData: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("locked"),
    message: z.string().default("This chat is temporarily unavailable."),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
