import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module.js";
import { CoreModule } from "../core/core.module.js";
import { CrmController } from "./crm.controller.js";
import { CrmPushProcessor } from "./crm-push.processor.js";
import { CrmQueueService } from "./crm-queue.service.js";
import { CrmService } from "./crm.service.js";
import { CrmProviderModule } from "./providers/crm-provider.module.js";

/**
 * HubSpot OAuth connect, field mapping, and push-on-complete (gated behind
 * the "crm" feature flag). Imports CoreModule (for the JwtAuthGuard/
 * TenantScopeGuard/FeatureGuard the controller's routes use) and
 * BillingModule (for TenantLockGuard) — both are also imported directly by
 * AgentModule, so this is a diamond, not a cycle: neither CoreModule nor
 * BillingModule imports CrmModule back.
 */
@Module({
  imports: [CoreModule, BillingModule, CrmProviderModule],
  controllers: [CrmController],
  providers: [CrmService, CrmQueueService, CrmPushProcessor],
  exports: [CrmService, CrmQueueService],
})
export class CrmModule {}
