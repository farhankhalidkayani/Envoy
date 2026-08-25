import { Injectable } from "@nestjs/common";
import type { CrmProvider, CrmPushResult } from "./types.js";

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
}
