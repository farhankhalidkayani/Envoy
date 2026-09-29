import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import Stripe from "stripe";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { billingCycleWindow } from "./billing-cycle.js";

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

  private stripe(): Stripe | null {
    const key = process.env.STRIPE_SECRET_KEY;
    return key ? new Stripe(key) : null;
  }

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

  /**
   * The tenant (or an operator) cancelled via Stripe's billing portal — the
   * subscription is gone regardless of what our own active/past_due/locked
   * state machine currently says, so this always wins.
   */
  async handleSubscriptionDeleted(stripeCustomerId: string) {
    const subscription = await this.findByStripeCustomerId(stripeCustomerId);
    if (subscription.status === "cancelled") return; // already reflected, no-op
    await this.transitionStatus(subscription.tenantId, "cancelled");
    this.logger.log(`tenant ${subscription.tenantId}: Stripe subscription deleted → cancelled`);
  }

  /**
   * Only acts on cancellation — Stripe fires this on nearly every change to
   * the subscription object (plan changes, trial ending, etc.), and
   * invoice.paid/payment_failed already own the active/past_due/locked
   * transitions above. Reacting to every status here would run two
   * overlapping state machines against the same subscriptionStatus field.
   */
  async handleSubscriptionUpdated(stripeCustomerId: string, stripeStatus: string) {
    if (stripeStatus !== "canceled") return;
    await this.handleSubscriptionDeleted(stripeCustomerId);
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

  /**
   * Stripe Checkout — no live Stripe account here, same "code-complete, not
   * live-tested" posture as the rest of billing/CRM/calendar. Without
   * STRIPE_SECRET_KEY, the tenant is already active under `local_<tenantId>`
   * (ensureSubscription), so there's nothing to check out: return mock mode
   * and let the caller show that instead of a payment page.
   */
  async createCheckoutSession(tenantId: string): Promise<{ mode: "mock" | "stripe"; url?: string }> {
    const stripe = this.stripe();
    if (!stripe) return { mode: "mock" };

    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) throw new NotFoundException("STRIPE_PRICE_ID is not configured on this server");

    const customerId = await this.ensureStripeCustomer(tenantId, stripe);
    const portalUrl = process.env.PORTAL_URL ?? "http://localhost:3001";
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${portalUrl}/dashboard/billing?checkout=success`,
      cancel_url: `${portalUrl}/dashboard/billing?checkout=cancelled`,
      client_reference_id: tenantId,
    });
    if (!session.url) throw new NotFoundException("Stripe did not return a checkout URL");
    return { mode: "stripe", url: session.url };
  }

  /** Stripe's self-serve portal — update payment method, view invoices, cancel. */
  async createPortalSession(tenantId: string): Promise<{ mode: "mock" | "stripe"; url?: string }> {
    const stripe = this.stripe();
    if (!stripe) return { mode: "mock" };

    const customerId = await this.ensureStripeCustomer(tenantId, stripe);
    const portalUrl = process.env.PORTAL_URL ?? "http://localhost:3001";
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${portalUrl}/dashboard/billing`,
    });
    return { mode: "stripe", url: session.url };
  }

  /** Swaps the `local_<tenantId>` stand-in for a real Stripe customer the first time real billing is used. */
  private async ensureStripeCustomer(tenantId: string, stripe: Stripe): Promise<string> {
    const subscription = await this.getForTenant(tenantId);
    if (subscription.stripeCustomerId && !subscription.stripeCustomerId.startsWith("local_")) {
      return subscription.stripeCustomerId;
    }
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const customer = await stripe.customers.create({ name: tenant.name, metadata: { tenantId } });
    await this.prisma.client.subscription.update({
      where: { tenantId },
      data: { stripeCustomerId: customer.id },
    });
    return customer.id;
  }

  /**
   * Usage was stored (Subscription.usageRate/includedConversations) but
   * never read anywhere — this is what finally reads it: completed
   * conversations in the current billing cycle, and what they'd cost past
   * the included allotment.
   */
  async getUsage(tenantId: string) {
    const subscription = await this.getForTenant(tenantId);
    const { start, end } = billingCycleWindow(subscription.billingCycleDay, new Date());
    const usedConversations = await this.prisma.client.conversation.count({
      where: { tenantId, status: "completed", completedAt: { gte: start, lt: end } },
    });
    const overageConversations = Math.max(0, usedConversations - subscription.includedConversations);
    return {
      cycleStart: start.toISOString(),
      cycleEnd: end.toISOString(),
      includedConversations: subscription.includedConversations,
      usedConversations,
      overageConversations,
      overageAmountCents: overageConversations * subscription.usageRate,
    };
  }

  /**
   * Bills the current cycle's overage as a one-off Stripe invoice item.
   * Idempotent per cycle via Subscription.lastOverageBilledCycleEnd — a
   * second call inside the same cycle (retry, double-click, or a future
   * scheduler firing twice) is a safe no-op instead of a duplicate charge.
   * ponytail: operator-triggered only (AdminController) — no scheduler in
   * this codebase yet to call it automatically once each tenant's cycle
   * rolls over. Upgrade path: a recurring BullMQ job that calls this for
   * every tenant whose cycle just ended.
   */
  async chargeOverage(tenantId: string): Promise<{ mode: "mock" | "stripe"; charged: boolean; amountCents?: number }> {
    const stripe = this.stripe();
    if (!stripe) return { mode: "mock", charged: false };

    const usage = await this.getUsage(tenantId);
    if (usage.overageConversations === 0) return { mode: "stripe", charged: false };

    const subscription = await this.getForTenant(tenantId);
    if (!subscription.stripeCustomerId || subscription.stripeCustomerId.startsWith("local_")) {
      // No real Stripe customer yet (tenant has never been through checkout) — nothing to invoice.
      return { mode: "stripe", charged: false };
    }
    if (subscription.lastOverageBilledCycleEnd?.toISOString() === usage.cycleEnd) {
      // Already billed this cycle — a retry or double-click must not double-charge.
      return { mode: "stripe", charged: false };
    }

    await stripe.invoiceItems.create({
      customer: subscription.stripeCustomerId,
      amount: usage.overageAmountCents,
      currency: "usd",
      description: `Overage: ${usage.overageConversations} conversation(s) over the ${usage.includedConversations} included (${usage.cycleStart.slice(0, 10)} – ${usage.cycleEnd.slice(0, 10)})`,
    });
    await this.prisma.client.subscription.update({
      where: { tenantId },
      data: { lastOverageBilledCycleEnd: new Date(usage.cycleEnd) },
    });
    this.logger.log(`tenant ${tenantId}: billed ${usage.overageAmountCents}c overage for ${usage.overageConversations} conversation(s)`);
    return { mode: "stripe", charged: true, amountCents: usage.overageAmountCents };
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
