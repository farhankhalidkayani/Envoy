import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { OutcomeType, WorkflowDef, WorkflowStatus } from "@envoy/types";
import { TenantLockGuard } from "../billing/guards/tenant-lock.guard.js";
import { CurrentUser } from "../core/auth/decorators/current-user.decorator.js";
import { RequireFeature } from "../core/auth/decorators/require-feature.decorator.js";
import { FeatureGuard } from "../core/auth/guards/feature.guard.js";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard.js";
import { TenantScopeGuard } from "../core/auth/guards/tenant-scope.guard.js";
import type { JwtPayload } from "../core/auth/types.js";
import { ZodValidationPipe } from "../core/common/zod-validation.pipe.js";
import { WorkflowsService } from "./workflows.service.js";

const UpdateDto = z.object({
  name: WorkflowDef.innerType().shape.name.optional(),
  trigger: WorkflowDef.innerType().shape.trigger.optional(),
  conditions: WorkflowDef.innerType().shape.conditions.optional(),
  steps: WorkflowDef.innerType().shape.steps.optional(),
  settings: WorkflowDef.innerType().shape.settings.optional(),
});
const StatusDto = z.object({ status: WorkflowStatus });
const PreviewDto = z.object({
  workflow: WorkflowDef,
  lead: z.object({ data: z.record(z.string(), z.unknown()), outcome: OutcomeType.nullish() }),
});
const OptOutDto = z.object({ channel: z.enum(["email", "sms"]), address: z.string().min(3).max(254) });

/**
 * Follow-up workflows send real email and SMS on the workspace's behalf, so: the `workflows` feature must be enabled
 * for the user, only the owner can switch one live, and none of this is reachable with an API token (it is outside
 * every area a token may touch).
 */
@Controller("workflows")
@UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard, FeatureGuard)
@RequireFeature("workflows")
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.workflows.list(user.tenantId!);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(WorkflowDef)) body: WorkflowDef) {
    return this.workflows.create(user.tenantId!, body);
  }

  @Post("preview")
  preview(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(PreviewDto)) body: z.infer<typeof PreviewDto>) {
    return this.workflows.preview(user.tenantId!, body.workflow, { data: body.lead.data, outcome: body.lead.outcome ?? null });
  }

  @Get("opt-outs")
  optOuts(@CurrentUser() user: JwtPayload, @Query("channel") channel?: string) {
    return this.workflows.listOptOuts(user.tenantId!, channel === "email" || channel === "sms" ? channel : undefined);
  }

  @Post("opt-outs")
  addOptOut(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(OptOutDto)) body: z.infer<typeof OptOutDto>) {
    return this.workflows.addOptOut(user.tenantId!, body.channel, body.address);
  }

  @Delete("opt-outs/:id")
  async removeOptOut(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    await this.workflows.removeOptOut(user.tenantId!, id);
    return { removed: true };
  }

  @Get("runs/:runId")
  run(@CurrentUser() user: JwtPayload, @Param("runId") runId: string) {
    return this.workflows.getRun(user.tenantId!, runId);
  }

  @Post("runs/:runId/cancel")
  cancel(@CurrentUser() user: JwtPayload, @Param("runId") runId: string) {
    return this.workflows.cancelRun(user.tenantId!, runId);
  }

  @Get(":id")
  get(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.workflows.get(user.tenantId!, id);
  }

  @Patch(":id")
  update(@CurrentUser() user: JwtPayload, @Param("id") id: string, @Body(new ZodValidationPipe(UpdateDto)) body: z.infer<typeof UpdateDto>) {
    return this.workflows.update(user.tenantId!, id, body as never);
  }

  @Post(":id/status")
  setStatus(@CurrentUser() user: JwtPayload, @Param("id") id: string, @Body(new ZodValidationPipe(StatusDto)) body: z.infer<typeof StatusDto>) {
    if (body.status === "live" && user.role !== "owner") throw new ForbiddenException("Only the workspace owner can switch a workflow live — it sends messages to your leads.");
    return this.workflows.setStatus(user.tenantId!, id, body.status);
  }

  @Delete(":id")
  async remove(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    await this.workflows.remove(user.tenantId!, id);
    return { deleted: true };
  }

  @Get(":id/runs")
  runs(@CurrentUser() user: JwtPayload, @Param("id") id: string, @Query("status") status?: string, @Query("limit") limit?: string) {
    return this.workflows.runs(user.tenantId!, id, { status, limit: Number(limit) || 50 });
  }
}
