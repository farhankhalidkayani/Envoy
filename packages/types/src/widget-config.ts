import { z } from "zod";

export const WidgetPosition = z.enum(["bottom-right", "bottom-left"]);
export type WidgetPosition = z.infer<typeof WidgetPosition>;

export const WidgetThemeMode = z.enum(["light", "dark", "auto"]);
export type WidgetThemeMode = z.infer<typeof WidgetThemeMode>;

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
});
export type WidgetConfig = z.infer<typeof WidgetConfig>;
