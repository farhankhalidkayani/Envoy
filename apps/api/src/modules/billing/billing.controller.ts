import { Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../core/auth/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard.js";
import { TenantScopeGuard } from "../core/auth/guards/tenant-scope.guard.js";
import type { JwtPayload } from "../core/auth/types.js";
import { BillingService } from "./billing.service.js";

/**
 * Deliberately NOT behind TenantLockGuard — a locked tenant must still be
 * able to see its own billing status (that's the whole point of "visible
 * but disabled"), and this is the endpoint the portal's locked-state banner
 * reads from.
 */
@Controller("billing")
@UseGuards(JwtAuthGuard, TenantScopeGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get("subscription")
  getSubscription(@CurrentUser() user: JwtPayload) {
    return this.billing.getForTenant(user.tenantId!);
  }

  /** Starts a Stripe Checkout session; `{ mode: "mock" }` when no live Stripe account is configured. */
  @Post("checkout")
  @HttpCode(200)
  checkout(@CurrentUser() user: JwtPayload) {
    return this.billing.createCheckoutSession(user.tenantId!);
  }

  /** Stripe's self-serve billing portal (payment method, invoices, cancel). */
  @Post("portal")
  @HttpCode(200)
  portal(@CurrentUser() user: JwtPayload) {
    return this.billing.createPortalSession(user.tenantId!);
  }

  /** Completed conversations in the current billing cycle vs. the included allotment. */
  @Get("usage")
  getUsage(@CurrentUser() user: JwtPayload) {
    return this.billing.getUsage(user.tenantId!);
  }
}
