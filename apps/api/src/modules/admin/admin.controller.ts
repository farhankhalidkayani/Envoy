import { Body, Controller, Delete, Get, Param, Patch, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { FeatureAccess, PriceConfig } from "@envoy/types";
import { CurrentUser } from "../core/auth/decorators/current-user.decorator.js";
import { Roles } from "../core/auth/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard.js";
import { RolesGuard } from "../core/auth/guards/roles.guard.js";
import type { JwtPayload } from "../core/auth/types.js";
import { ZodValidationPipe } from "../core/common/zod-validation.pipe.js";
import { AdminService } from "./admin.service.js";

/**
 * The platform-operator surface: every route here requires `platform_admin`
 * — no TenantScopeGuard (admins aren't bound to a tenant) and no
 * TenantLockGuard (the operator must always have full control, including
 * over locked tenants).
 */
@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("platform_admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("tenants")
  listTenants() {
    return this.admin.listTenants();
  }

  @Get("tenants/:id")
  getTenant(@Param("id") tenantId: string) {
    return this.admin.getTenant(tenantId);
  }

  @Patch("tenants/:id/pause")
  pause(@CurrentUser() user: JwtPayload, @Param("id") tenantId: string) {
    return this.admin.pause(user.sub, tenantId);
  }

  @Patch("tenants/:id/resume")
  resume(@CurrentUser() user: JwtPayload, @Param("id") tenantId: string) {
    return this.admin.resume(user.sub, tenantId);
  }

  @Delete("tenants/:id")
  revoke(@CurrentUser() user: JwtPayload, @Param("id") tenantId: string) {
    return this.admin.revoke(user.sub, tenantId);
  }

  @Patch("tenants/:id/users/:uid/access")
  updateUserAccess(
    @CurrentUser() user: JwtPayload,
    @Param("id") tenantId: string,
    @Param("uid") userId: string,
    @Body(new ZodValidationPipe(FeatureAccess)) access: FeatureAccess,
  ) {
    return this.admin.updateUserFeatureAccess(user.sub, tenantId, userId, access);
  }

  @Patch("tenants/:id/pricing")
  updatePricing(
    @CurrentUser() user: JwtPayload,
    @Param("id") tenantId: string,
    @Body(new ZodValidationPipe(PriceConfig)) priceConfig: PriceConfig,
  ) {
    return this.admin.updatePricing(user.sub, tenantId, priceConfig);
  }

  @Get("audit-log")
  listAuditLog(@Query("tenantId", new ZodValidationPipe(z.string().optional())) tenantId?: string) {
    return this.admin.listAuditLog(tenantId);
  }
}
