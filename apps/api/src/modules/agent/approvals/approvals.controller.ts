import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { APPROVAL_STATUSES, CreateApprovalInput, type ApprovalStatus } from "@envoy/types";
import { TenantLockGuard } from "../../billing/guards/tenant-lock.guard.js";
import { CurrentUser } from "../../core/auth/decorators/current-user.decorator.js";
import { Roles } from "../../core/auth/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../core/auth/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../core/auth/guards/roles.guard.js";
import { TenantScopeGuard } from "../../core/auth/guards/tenant-scope.guard.js";
import type { AuthenticatedRequest, JwtPayload } from "../../core/auth/types.js";
import { ZodValidationPipe } from "../../core/common/zod-validation.pipe.js";
import { ApprovalsService } from "./approvals.service.js";

const StatusQuery = z.enum(APPROVAL_STATUSES as unknown as [string, ...string[]]).optional();

/**
 * Anyone with access (including an API token holding the right scope) can ASK; only the workspace owner, signed in as
 * a person, can answer. The token policy refuses `approve` and `reject` for tokens outright, and the role guard
 * refuses everyone but the owner — two independent locks on the one door that matters.
 */
@Controller("approvals")
@UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard, RolesGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post()
  create(@Req() req: AuthenticatedRequest, @CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(CreateApprovalInput)) body: CreateApprovalInput) {
    return this.approvals.create(user.tenantId!, { userId: user.sub, token: req.apiToken ? { id: req.apiToken.id, name: req.apiToken.name } : undefined }, body);
  }

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query("status") status?: string) {
    return this.approvals.list(user.tenantId!, StatusQuery.parse(status) as ApprovalStatus | undefined);
  }

  @Get("pending-count")
  count(@CurrentUser() user: JwtPayload) {
    return this.approvals.pendingCount(user.tenantId!);
  }

  @Get(":id")
  get(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.approvals.get(user.tenantId!, id);
  }

  @Post(":id/approve")
  @Roles("owner")
  approve(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.approvals.approve(user.tenantId!, user.sub, id);
  }

  @Post(":id/reject")
  @Roles("owner")
  reject(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.approvals.reject(user.tenantId!, user.sub, id);
  }
}
