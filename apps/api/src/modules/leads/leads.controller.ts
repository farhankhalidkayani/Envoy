import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../core/auth/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard.js";
import { TenantScopeGuard } from "../core/auth/guards/tenant-scope.guard.js";
import { TenantLockGuard } from "../billing/guards/tenant-lock.guard.js";
import type { JwtPayload } from "../core/auth/types.js";
import { LeadsService } from "./leads.service.js";

/** Combines completed conversations and form submissions into one dashboard feed. */
@Controller("leads")
@UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard)
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query("limit") limit?: string) {
    return this.leads.list(user.tenantId!, limit ? Number(limit) : undefined);
  }

  @Get("stats")
  stats(@CurrentUser() user: JwtPayload) {
    return this.leads.stats(user.tenantId!);
  }
}
