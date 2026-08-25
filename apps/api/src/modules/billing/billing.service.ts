import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../core/prisma/prisma.service.js";

const STARTER_PLAN = {
  monthlyRateCents: 4900,
  usageRateCents: 50,
  includedConversations: 100,
};

/**
 * Webhook-driven subscription lock/unlock engine — see build plan §Billing
 * & lock engine. The lock itself only ever flips Tenant.subscriptionStatus
 * (+ mirrors onto Subscription.status); enforcement is centralized in two
 * places rather than scattered across the Agent table: TenantLockGuard
 * (portal/API routes) and AgentGateway's session.start check (the widget).
 * Nothing here ever deletes data — see the "never delete on lock" rule.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every tenant gets a Subscription row at signup, even without a real
   * Stripe account configured — `local_<tenantId>` is a stand-in
   * stripeCustomerId that still lets the webhook flow (and therefore the
   * whole lock/unlock state machine) be exercised and tested without live
   * Stripe credentials. A real integration replaces this with an actual
   * Stripe customer id once STRIPE_SECRET_KEY is configured and a checkout
   * flow runs (not implemented — no test Stripe account available to
   * verify against; this is the same "code-complete, not live-tested"
   * posture as the Groq/Gemini LLM providers).
   */
  async ensureSubscription(tenantId: string) {
    const existing = await this.prisma.client.subscription.findUnique({ where: { tenantId } });
    if (existing) return existing;
    return this.prisma.client.subscription.create({
      data: {
        tenantId,
        status: "active",
        monthlyRate: STARTER_PLAN.monthlyRateCents,
        usageRate: STARTER_PLAN.usageRateCents,
        includedConversations: STARTER_PLAN.includedConversations,
        stripeCustomerId: `local_${tenantId}`,
      },
    });
  }

  async getForTenant(tenantId: string) {
    const subscription = await this.prisma.client.subscription.findUnique({ where: { tenantId } });
    if (!subscription) throw new NotFoundException("No subscription found for this tenant");
    return subscription;
  }

  /**
   * Stripe retries a failing invoice automatically over several days. Rather
   * than tracking wall-clock grace periods (which needs a scheduled job),
   * this maps Stripe's own retry cadence onto the state machine: the FIRST
   * failure moves an active tenant to past_due (grace); a SECOND failure
   * while already past_due — i.e. a retry also failed — locks it. Idempotent
   * on an already-locked tenant.
   */
  async handlePaymentFailed(stripeCustomerId: string) {
    const subscription = await this.findByStripeCustomerId(stripeCustomerId);
    if (subscription.status === "locked") return; // already locked, no-op

    const nextStatus = subscription.status === "past_due" ? "locked" : "past_due";
    await this.transitionStatus(subscription.tenantId, nextStatus);
    this.logger.warn(`tenant ${subscription.tenantId}: payment failed → ${nextStatus}`);
  }

  async handlePaymentSucceeded(stripeCustomerId: string) {
    const subscription = await this.findByStripeCustomerId(stripeCustomerId);
    if (subscription.status === "active") return; // no-op, nothing to unlock
    await this.transitionStatus(subscription.tenantId, "active");
    this.logger.log(`tenant ${subscription.tenantId}: payment succeeded → active`);
  }

  /** Admin-driven pause/resume/revoke — see AdminService. Same status field, different cause. */
  async transitionStatus(
    tenantId: string,
    status: "active" | "past_due" | "locked" | "cancelled",
  ) {
    const now = new Date();
    await this.prisma.client.$transaction([
      this.prisma.client.tenant.update({
        where: { id: tenantId },
        data: { subscriptionStatus: status },
      }),
      this.prisma.client.subscription.update({
        where: { tenantId },
        data: {
          status,
          ...(status === "locked" ? { lockedAt: now } : {}),
          ...(status === "active" ? { unlockedAt: now } : {}),
        },
      }),
    ]);
  }

  private async findByStripeCustomerId(stripeCustomerId: string) {
    const subscription = await this.prisma.client.subscription.findFirst({
      where: { stripeCustomerId },
    });
    if (!subscription) {
      throw new NotFoundException(`No subscription found for Stripe customer ${stripeCustomerId}`);
    }
    return subscription;
  }
}
