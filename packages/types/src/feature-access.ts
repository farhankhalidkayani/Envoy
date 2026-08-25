import { z } from "zod";

/**
 * The closed set of gate-able features. Adding a new feature means adding a
 * key here, which is deliberate — this list is what the admin panel renders
 * toggles for and what @RequireFeature() guards check against.
 */
export const FEATURE_KEYS = [
  "conversations",
  "crm",
  "recordings",
  "export",
  "voice",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** User.featureAccess — admin-editable, per-user, checked on every request (not embedded in the JWT since it changes live). */
export const FeatureAccess = z
  .object(
    Object.fromEntries(FEATURE_KEYS.map((key) => [key, z.boolean()])) as Record<
      FeatureKey,
      z.ZodBoolean
    >,
  )
  .partial();
export type FeatureAccess = z.infer<typeof FeatureAccess>;

export const DEFAULT_FEATURE_ACCESS: FeatureAccess = {
  conversations: true,
  crm: false,
  recordings: true,
  export: true,
  voice: false,
};
