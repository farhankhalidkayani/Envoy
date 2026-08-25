import { Module } from "@nestjs/common";
import { HubSpotCrmProvider } from "./hubspot.provider.js";
import { MockCrmProvider } from "./mock.provider.js";
import type { CrmProvider } from "./types.js";

export const CRM_PROVIDER = "CRM_PROVIDER";

/** Defaults to "mock" — set CRM_PROVIDER=hubspot once real OAuth credentials are configured. */
@Module({
  providers: [
    {
      provide: CRM_PROVIDER,
      useFactory: (): CrmProvider => {
        const selected = process.env.CRM_PROVIDER ?? "mock";
        switch (selected) {
          case "hubspot":
            return new HubSpotCrmProvider();
          case "mock":
            return new MockCrmProvider();
          default:
            throw new Error(`Unknown CRM_PROVIDER "${selected}" (expected mock|hubspot)`);
        }
      },
    },
  ],
  exports: [CRM_PROVIDER],
})
export class CrmProviderModule {}
