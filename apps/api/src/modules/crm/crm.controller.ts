import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { portalReturnUrl } from "../core/common/oauth-state.js";
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
  pushConversation(@CurrentUser() user: JwtPayload, @Param("conversationId") conversationId: string) {
    return this.crm.pushConversation(conversationId, user.tenantId!);
  }

  @Post("push/submission/:submissionId")
  @UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard, FeatureGuard)
  @RequireFeature("crm")
  pushSubmission(@CurrentUser() user: JwtPayload, @Param("submissionId") submissionId: string) {
    return this.crm.pushFormSubmission(submissionId, user.tenantId!);
  }

  /**
   * Public — the OAuth redirect target HubSpot sends the browser back to.
   * `state` is a single-use nonce from initiateConnect(); the tenant comes
   * from the server-side record, never from the URL.
   */
  @Get("callback")
  async callback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") providerError: string | undefined,
    @Res() res: Response,
  ) {
    try {
      if (providerError) throw new Error(`HubSpot declined the connection (${providerError})`);
      await this.crm.handleCallback(code, state);
      res.redirect(portalReturnUrl("/dashboard/crm", { connected: "hubspot" }));
    } catch (err) {
      res.redirect(portalReturnUrl("/dashboard/crm", { error: (err as Error).message }));
    }
  }
}
