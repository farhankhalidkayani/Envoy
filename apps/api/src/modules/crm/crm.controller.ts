import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequireFeature } from "../core/auth/decorators/require-feature.decorator.js";
import { CurrentUser } from "../core/auth/decorators/current-user.decorator.js";
import { FeatureGuard } from "../core/auth/guards/feature.guard.js";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard.js";
import { TenantScopeGuard } from "../core/auth/guards/tenant-scope.guard.js";
import { TenantLockGuard } from "../billing/guards/tenant-lock.guard.js";
import type { JwtPayload } from "../core/auth/types.js";
import { ZodValidationPipe } from "../core/common/zod-validation.pipe.js";
import { CrmService } from "./crm.service.js";

const FieldMappingDto = z.record(z.string(), z.string());

@Controller("crm")
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get("connection")
  @UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard, FeatureGuard)
  @RequireFeature("crm")
  getConnection(@CurrentUser() user: JwtPayload) {
    return this.crm.getConnection(user.tenantId!);
  }

  @Post("connect")
  @UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard, FeatureGuard)
  @RequireFeature("crm")
  connect(@CurrentUser() user: JwtPayload) {
    return this.crm.initiateConnect(user.tenantId!);
  }

  @Patch("mapping")
  @UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard, FeatureGuard)
  @RequireFeature("crm")
  updateMapping(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(FieldMappingDto)) mapping: Record<string, string>,
  ) {
    return this.crm.updateFieldMapping(user.tenantId!, mapping);
  }

  @Delete("connection")
  @UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard, FeatureGuard)
  @RequireFeature("crm")
  disconnect(@CurrentUser() user: JwtPayload) {
    return this.crm.disconnect(user.tenantId!);
  }

  @Post("push/:conversationId")
  @UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard, FeatureGuard)
  @RequireFeature("crm")
  pushConversation(@Param("conversationId") conversationId: string) {
    return this.crm.pushConversation(conversationId);
  }

  /**
   * Public — this is the OAuth redirect target HubSpot calls back into
   * directly (the browser navigating away and back), not an authenticated
   * API call. `state` carries the tenantId set in initiateConnect().
   */
  @Get("callback")
  async callback(@Query("code") code: string, @Query("state") tenantId: string) {
    await this.crm.handleCallback(code, tenantId);
    return { connected: true };
  }
}
