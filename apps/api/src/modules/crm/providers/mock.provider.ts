import { Injectable } from "@nestjs/common";
import type { CrmLookupResult, CrmProvider, CrmPushResult } from "./types.js";

/**
 * Deterministic, zero-dependency provider — the default (CRM_PROVIDER=mock),
 * so the whole push mechanism (mapping, auth, retry, audit) is testable
 * without a live HubSpot account. A record containing the literal value
 * "FORCE_CRM_FAILURE" in any field deliberately fails, for exercising the
 * failure/retry path in tests.
 */
@Injectable()
export class MockCrmProvider implements CrmProvider {
  readonly name = "mock";

  async pushRecord(_accessToken: string, record: Record<string, unknown>): Promise<CrmPushResult> {
    const forcedFailure = Object.values(record).some((v) => v === "FORCE_CRM_FAILURE");
    if (forcedFailure) {
      return { success: false, error: "Simulated CRM failure (FORCE_CRM_FAILURE)" };
    }
    const externalId = `mock_contact_${Math.random().toString(36).slice(2, 10)}`;
    return { success: true, externalId };
  }

  /** Deterministic: an email whose local part contains "existing" is a known contact; "FORCE_CRM_FAILURE" simulates an outage. */
  async findContact(_accessToken: string, email: string): Promise<CrmLookupResult> {
    if (email.includes("FORCE_CRM_FAILURE")) return { success: false, error: "Simulated CRM failure (FORCE_CRM_FAILURE)" };
    return email.split("@")[0]!.toLowerCase().includes("existing")
      ? { success: true, found: true, firstName: "Existing" }
      : { success: true, found: false };
  }
}
