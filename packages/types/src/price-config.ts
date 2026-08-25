import { z } from "zod";

/**
 * Tenant.priceConfig — admin-set, per-tenant. This is the custom
 * usage-based pricing engine: a base monthly rate, a per-conversation
 * overage rate past the included allotment, and paid add-ons.
 * All monetary values are integer cents to avoid float drift.
 */
export const PriceConfig = z.object({
  currency: z.string().length(3).default("usd"),
  baseMonthlyCents: z.number().int().nonnegative(),
  perConversationCents: z.number().int().nonnegative().default(0),
  includedConversations: z.number().int().nonnegative().default(0),
  addOns: z
    .object({
      crm: z.boolean().default(false),
      voice: z.boolean().default(false),
    })
    .default({ crm: false, voice: false }),
});
export type PriceConfig = z.infer<typeof PriceConfig>;
