import { Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { forbiddenAgentEditForToken, AgentSpec, AgentStatus, HardRulesSpec, RequiredFieldsSpec, WidgetConfig } from "@envoy/types";
import { CurrentUser } from "../core/auth/decorators/current-user.decorator.js";
import { FeatureGuard } from "../core/auth/guards/feature.guard.js";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard.js";
import { TenantScopeGuard } from "../core/auth/guards/tenant-scope.guard.js";
import type { AuthenticatedRequest, JwtPayload } from "../core/auth/types.js";
import { ZodValidationPipe } from "../core/common/zod-validation.pipe.js";
import { TenantLockGuard } from "../billing/guards/tenant-lock.guard.js";
import { AgentsService } from "./agents.service.js";

const CreateAgentDto = z.object({
  name: z.string().min(1),
  script: z.string().optional(),
  requiredFields: RequiredFieldsSpec.optional(),
  hardRules: HardRulesSpec.optional(),
  widgetConfig: WidgetConfig.partial().optional(),
  spec: AgentSpec.optional(),
});

const UpdateOnlyDto = z.object({
  leadFormId: z.string().nullable().optional(),
  note: z.string().max(200).optional(),
});

const UpdateAgentDto = CreateAgentDto.partial().merge(UpdateOnlyDto).extend({
  status: AgentStatus.optional(),
});

@Controller("agents")
@UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard, FeatureGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  /** Edits made with an API token (e.g. by an AI agent over MCP) can't touch hard rules, publish, or switch on CRM/calendar tools. */
  private async guardTokenEdit(req: AuthenticatedRequest, body: Parameters<typeof forbiddenAgentEditForToken>[0], tenantId: string, agentId?: string) {
    if (!req.apiToken) return;
    const current = agentId && body.spec ? await this.agents.findOneScoped(tenantId, agentId) : undefined;
    const enabled = new Set((current ? AgentSpec.parse(current.spec).tools : []).filter((t) => t.enabled).map((t) => t.name));
    const reason = forbiddenAgentEditForToken(body, enabled);
    if (reason) throw new ForbiddenException(reason);
  }

  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CreateAgentDto)) body: z.infer<typeof CreateAgentDto>,
  ) {
    await this.guardTokenEdit(req, body, user.tenantId!);
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

  @Get(":id/versions")
  versions(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.agents.listVersions(user.tenantId!, id);
  }

  @Post(":id/versions/:version/restore")
  restore(@CurrentUser() user: JwtPayload, @Param("id") id: string, @Param("version", ParseIntPipe) version: number) {
    return this.agents.restoreVersion(user.tenantId!, id, version);
  }

  @Patch(":id")
  async update(
    @Req() req: AuthenticatedRequest,
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateAgentDto)) body: z.infer<typeof UpdateAgentDto>,
  ) {
    await this.guardTokenEdit(req, body, user.tenantId!, id);
    return this.agents.update(user.tenantId!, id, body);
  }
}
