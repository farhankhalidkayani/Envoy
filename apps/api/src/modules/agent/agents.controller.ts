import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AgentStatus, HardRulesSpec, RequiredFieldsSpec, WidgetConfig } from "@envoy/types";
import { CurrentUser } from "../core/auth/decorators/current-user.decorator.js";
import { FeatureGuard } from "../core/auth/guards/feature.guard.js";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard.js";
import { TenantScopeGuard } from "../core/auth/guards/tenant-scope.guard.js";
import type { JwtPayload } from "../core/auth/types.js";
import { ZodValidationPipe } from "../core/common/zod-validation.pipe.js";
import { TenantLockGuard } from "../billing/guards/tenant-lock.guard.js";
import { AgentsService } from "./agents.service.js";

const CreateAgentDto = z.object({
  name: z.string().min(1),
  script: z.string().optional(),
  requiredFields: RequiredFieldsSpec.optional(),
  hardRules: HardRulesSpec.optional(),
  widgetConfig: WidgetConfig.partial().optional(),
});

const UpdateAgentDto = CreateAgentDto.partial().extend({
  status: AgentStatus.optional(),
});

@Controller("agents")
@UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard, FeatureGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CreateAgentDto)) body: z.infer<typeof CreateAgentDto>,
  ) {
    return this.agents.create(user.tenantId!, body);
  }

  @Get()
  findAll(@CurrentUser() user: JwtPayload) {
    return this.agents.findAllForTenant(user.tenantId!);
  }

  @Get(":id")
  findOne(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.agents.findOneScoped(user.tenantId!, id);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateAgentDto)) body: z.infer<typeof UpdateAgentDto>,
  ) {
    return this.agents.update(user.tenantId!, id, body);
  }
}
