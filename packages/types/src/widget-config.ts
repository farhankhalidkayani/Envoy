import { z } from "zod";

export const WidgetPosition = z.enum(["bottom-right", "bottom-left"]);
export type WidgetPosition = z.infer<typeof WidgetPosition>;

export const WidgetThemeMode = z.enum(["light", "dark", "auto"]);
export type WidgetThemeMode = z.infer<typeof WidgetThemeMode>;

/** A suggested first message shown as a clickable chip before the visitor's first reply. */
export const QuickReply = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(40),
  message: z.string().min(1).max(300),
});
export type QuickReply = z.infer<typeof QuickReply>;

/** Agent.widgetConfig — read by the embeddable widget on load; edits go live with no redeploy. */
export const WidgetConfig = z.object({
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex color")
    .default("#235a97"),
  logoUrl: z.string().url().optional(),
  position: WidgetPosition.default("bottom-right"),
  greeting: z.string().min(1).max(300).default("Hi! How can I help you today?"),
  launcherLabel: z.string().min(1).max(40).default("Chat with us"),
  themeMode: WidgetThemeMode.default("auto"),
  quickReplies: z.array(QuickReply).max(6).default([]),
});
export type WidgetConfig = z.infer<typeof WidgetConfig>;
