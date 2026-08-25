import { BadRequestException, Controller, Headers, Logger, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import Stripe from "stripe";
import { BillingService } from "./billing.service.js";

/**
 * invoice.paid → unlock; invoice.payment_failed → past_due/lock. See build
 * plan §Billing / auto-lock logic.
 *
 * Signature verification runs whenever STRIPE_WEBHOOK_SECRET is set (the
 * production path — requires `rawBody: true` on NestFactory.create, wired in
 * main.ts). Without it, the raw JSON body is trusted directly: this is the
 * same posture as the Groq/Gemini LLM providers — real-integration code
 * that's complete but not live-tested (no Stripe test account available
 * here) — and it's what lets `apps/api/src/modules/billing/*.e2e.test.ts`
 * exercise the whole lock/unlock chain by POSTing plain Stripe-shaped JSON.
 * Never enable the codebase without a webhook secret in production.
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
    this.logger.warn("STRIPE_WEBHOOK_SECRET not set — trusting webhook payload unverified (dev only)");
    return req.body as Stripe.Event;
  }

  private customerIdOf(invoice: Stripe.Invoice): string | null {
    const customer = invoice.customer;
    if (typeof customer === "string") return customer;
    if (customer && "id" in customer) return customer.id;
    return null;
  }
}
