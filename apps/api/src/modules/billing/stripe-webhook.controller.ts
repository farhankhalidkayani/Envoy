import { BadRequestException, Controller, Headers, Logger, Post, Req, ServiceUnavailableException } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import Stripe from "stripe";
import { BillingService } from "./billing.service.js";

/**
 * invoice.paid → unlock; invoice.payment_failed → past_due/lock;
 * customer.subscription.deleted (or .updated with status=canceled) →
 * cancelled. See build plan §Billing / auto-lock logic.
 *
 * Events must carry a valid signature for STRIPE_WEBHOOK_SECRET (requires
 * `rawBody: true` on NestFactory.create, wired in main.ts). Unsigned JSON is
 * accepted ONLY with STRIPE_WEBHOOK_ALLOW_UNSIGNED=true outside production —
 * that's what lets billing e2e tests POST plain Stripe-shaped JSON. A missing
 * secret used to fall back to trusting the body, which let anyone POST
 * `invoice.paid` and unlock a locked tenant; it now fails closed.
 */
@Controller("webhooks/stripe")
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(private readonly billing: BillingService) {}

  @Post()
  async handle(@Req() req: RawBodyRequest<Request>, @Headers("stripe-signature") signature?: string) {
    const event = this.resolveEvent(req, signature);

    switch (event.type) {
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = this.customerIdOf(invoice);
        if (customerId) await this.billing.handlePaymentFailed(customerId);
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = this.customerIdOf(invoice);
        if (customerId) await this.billing.handlePaymentSucceeded(customerId);
        break;
      }
      case "customer.subscription.deleted": {
        const customerId = this.customerIdOf(event.data.object as Stripe.Subscription);
        if (customerId) await this.billing.handleSubscriptionDeleted(customerId);
        break;
      }
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = this.customerIdOf(subscription);
        if (customerId) await this.billing.handleSubscriptionUpdated(customerId, subscription.status);
        break;
      }
      default:
        this.logger.debug(`ignored event type: ${event.type}`);
    }

    return { received: true };
  }

  private resolveEvent(req: RawBodyRequest<Request>, signature?: string): Stripe.Event {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (webhookSecret) {
      if (!signature || !req.rawBody) {
        throw new BadRequestException("Missing Stripe signature or raw body");
      }
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
      try {
        return stripe.webhooks.constructEvent(req.rawBody, signature, webhookSecret);
      } catch (err) {
        throw new BadRequestException(`Invalid Stripe signature: ${(err as Error).message}`);
      }
    }
    const allowUnsigned =
      process.env.STRIPE_WEBHOOK_ALLOW_UNSIGNED === "true" && process.env.NODE_ENV !== "production";
    if (!allowUnsigned) {
      this.logger.error("Rejected Stripe webhook: STRIPE_WEBHOOK_SECRET is not configured");
      throw new ServiceUnavailableException("Stripe webhooks are not configured on this server");
    }
    this.logger.warn("STRIPE_WEBHOOK_ALLOW_UNSIGNED=true — trusting webhook payload unverified (dev/test only)");
    return req.body as Stripe.Event;
  }

  private customerIdOf(object: { customer: Stripe.Invoice["customer"] }): string | null {
    const customer = object.customer;
    if (typeof customer === "string") return customer;
    if (customer && "id" in customer) return customer.id;
    return null;
  }
}
