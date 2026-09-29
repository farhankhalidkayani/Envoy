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
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` };
    const email = typeof record.email === "string" && record.email.trim() ? record.email.trim() : null;

    // With an email, upsert on it: a repeat visitor or a manual re-push
    // updates their existing contact instead of creating a duplicate (or a
    // 409 "contact already exists"). Without one, there's nothing to dedupe on.
    const response = email
      ? await fetch(`${HUBSPOT_CONTACTS_URL}/batch/upsert`, {
          method: "POST",
          headers,
          body: JSON.stringify({ inputs: [{ idProperty: "email", id: email, properties: record }] }),
        })
      : await fetch(HUBSPOT_CONTACTS_URL, { method: "POST", headers, body: JSON.stringify({ properties: record }) });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      return { success: false, error: `HubSpot API error ${response.status}: ${text}` };
    }
    const data = (await response.json()) as { id?: string; results?: Array<{ id: string }> };
    const externalId = email ? data.results?.[0]?.id : data.id;
    return externalId ? { success: true, externalId } : { success: false, error: "HubSpot returned no contact id" };
  }
}
