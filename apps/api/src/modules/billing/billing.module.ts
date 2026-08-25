import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller.js";
import { BillingService } from "./billing.service.js";
import { TenantLockGuard } from "./guards/tenant-lock.guard.js";
import { StripeWebhookController } from "./stripe-webhook.controller.js";

/**
 * Stripe subscriptions, the invoice.paid/payment_failed webhook handler, and
 * the lock/unlock engine that flips Tenant.subscriptionStatus. See
 * billing.service.ts for the state machine and TenantLockGuard for how it's
 * enforced on ordinary tenant routes.
 *
 * No `imports` here on purpose: everything this module's providers need
 * (PrismaService) comes from the @Global() PrismaModule, already loaded via
 * CoreModule elsewhere in the graph. Keeping this module import-free is
 * what lets AuthModule depend on it (to create a Subscription row at
 * registration) without a circular CoreModule ↔ BillingModule reference —
 * CoreModule owns AuthModule, and BillingModule must stay a leaf.
 */
@Module({
  controllers: [BillingController, StripeWebhookController],
  providers: [BillingService, TenantLockGuard],
  exports: [BillingService, TenantLockGuard],
})
export class BillingModule {}
