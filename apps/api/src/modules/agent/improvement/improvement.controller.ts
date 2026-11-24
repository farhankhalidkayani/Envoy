import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { InsightStatus } from "@envoy/types";
import { TenantLockGuard } from "../../billing/guards/tenant-lock.guard.js";
import { CurrentUser } from "../../core/auth/decorators/current-user.decorator.js";
import { RequireFeature } from "../../core/auth/decorators/require-feature.decorator.js";
import { Roles } from "../../core/auth/decorators/roles.decorator.js";
import { FeatureGuard } from "../../core/auth/guards/feature.guard.js";
import { JwtAuthGuard } from "../../core/auth/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../core/auth/guards/roles.guard.js";
import { TenantScopeGuard } from "../../core/auth/guards/tenant-scope.guard.js";
import type { JwtPayload } from "../../core/auth/types.js";
import { ZodValidationPipe } from "../../core/common/zod-validation.pipe.js";
import { ImprovementService } from "./improvement.service.js";
import { ProposalsService } from "./proposals.service.js";

const DaysQuery = (raw?: string) => Math.min(Math.max(Number(raw) || 30, 1), 90);
const ApproveDto = z.object({ acknowledgeUntested: z.boolean().optional() });
const InsightPatchDto = z.object({ status: InsightStatus });

/**
 * The improvement harness. Reading, analysing, drafting and testing are open to anyone with the feature; only the
 * workspace owner can approve (which changes the live agent) or reject.
 */
@Controller("agents/:agentId/improvement")
@UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard, FeatureGuard, RolesGuard)
@RequireFeature("improvement")
export class ImprovementController {
  constructor(
    private readonly improvement: ImprovementService,
    private readonly proposals: ProposalsService,
  ) {}

  @Get("metrics")
  metrics(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string, @Query("days") days?: string) {
    return this.improvement.metrics(user.tenantId!, agentId, DaysQuery(days));
  }

  @Get("insights")
  insights(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string) {
    return this.improvement.list(user.tenantId!, agentId);
  }

  @Post("analyze")
  analyze(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string, @Query("days") days?: string) {
    return this.improvement.analyze(user.tenantId!, agentId, DaysQuery(days));
  }

  @Patch("insights/:id")
  setInsight(
    @CurrentUser() user: JwtPayload,
    @Param("agentId") agentId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(InsightPatchDto)) body: z.infer<typeof InsightPatchDto>,
  ) {
    return this.improvement.setStatus(user.tenantId!, agentId, id, body.status);
  }

  @Post("insights/:id/propose")
  propose(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string, @Param("id") id: string) {
    return this.proposals.create(user.tenantId!, agentId, id);
  }

  @Get("proposals")
  list(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string) {
    return this.proposals.list(user.tenantId!, agentId);
  }

  @Get("proposals/:id")
  get(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string, @Param("id") id: string) {
    return this.proposals.get(user.tenantId!, agentId, id);
  }

  @Post("proposals/:id/test")
  test(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string, @Param("id") id: string) {
    return this.proposals.test(user.tenantId!, agentId, id);
  }

  @Post("proposals/:id/approve")
  @Roles("owner")
  approve(
    @CurrentUser() user: JwtPayload,
    @Param("agentId") agentId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ApproveDto)) body: z.infer<typeof ApproveDto>,
  ) {
    return this.proposals.approve(user.tenantId!, agentId, id, user.sub, body);
  }

  @Post("proposals/:id/reject")
  @Roles("owner")
  reject(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string, @Param("id") id: string) {
    return this.proposals.reject(user.tenantId!, agentId, id, user.sub);
  }
}
