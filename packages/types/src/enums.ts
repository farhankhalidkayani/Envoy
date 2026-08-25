import { z } from "zod";

export const SubscriptionStatus = z.enum(["active", "past_due", "locked", "cancelled"]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

export const UserRole = z.enum(["owner", "staff", "platform_admin"]);
export type UserRole = z.infer<typeof UserRole>;

export const AgentStatus = z.enum(["draft", "live", "paused"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const ConversationChannel = z.enum(["chat", "voice"]);
export type ConversationChannel = z.infer<typeof ConversationChannel>;

export const ConversationStatus = z.enum(["in_progress", "completed", "abandoned"]);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

export const OutcomeType = z.enum(["demo_booking", "order", "complaint", "appointment"]);
export type OutcomeType = z.infer<typeof OutcomeType>;

export const CrmProvider = z.enum(["hubspot", "zoho"]);
export type CrmProvider = z.infer<typeof CrmProvider>;
