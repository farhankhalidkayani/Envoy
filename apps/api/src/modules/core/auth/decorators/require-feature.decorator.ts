import { SetMetadata } from "@nestjs/common";
import type { FeatureKey } from "@envoy/types";

export const REQUIRE_FEATURE_KEY = "requireFeature";

/** Gate a route behind a tenant feature flag, e.g. `@RequireFeature("crm")`. */
export const RequireFeature = (feature: FeatureKey) => SetMetadata(REQUIRE_FEATURE_KEY, feature);
