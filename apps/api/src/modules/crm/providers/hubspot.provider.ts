import { Injectable } from "@nestjs/common";
import type { CrmProvider, CrmPushResult } from "./types.js";

const HUBSPOT_CONTACTS_URL = "https://api.hubapi.com/crm/v3/objects/contacts";

/**
 * Real HubSpot Contacts API integration — code-complete, not live-tested
 * (no HubSpot developer account available here). Same posture as the
 * Groq/Gemini LLM providers and the Stripe webhook handler: correct against
 * the documented API shape, exercised via the mock provider instead.
 */
@Injectable()
export class HubSpotCrmProvider implements CrmProvider {
  readonly name = "hubspot";

  async pushRecord(accessToken: string, record: Record<string, unknown>): Promise<CrmPushResult> {
    const response = await fetch(HUBSPOT_CONTACTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ properties: record }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      return { success: false, error: `HubSpot API error ${response.status}: ${text}` };
    }
    const data = (await response.json()) as { id: string };
    return { success: true, externalId: data.id };
  }
}
