import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { ModelConfig, ScenarioDef, ScenarioSandbox } from "@envoy/types";
import { TenantLockGuard } from "../../billing/guards/tenant-lock.guard.js";
import { CurrentUser } from "../../core/auth/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../../core/auth/guards/jwt-auth.guard.js";
import { TenantScopeGuard } from "../../core/auth/guards/tenant-scope.guard.js";
import type { JwtPayload } from "../../core/auth/types.js";
import { ZodValidationPipe } from "../../core/common/zod-validation.pipe.js";
import { ScenariosService } from "./scenarios.service.js";
import { SimulationService } from "./simulation.service.js";

const SimulateDto = z.object({
  /** Omit to start a new simulated conversation; send the returned id to continue it. */
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional(),
  message: z.string().trim().min(1).max(4000),
  sandbox: ScenarioSandbox.optional(),
});

const RunDto = z.object({
  scenarioIds: z.array(z.string()).min(1).max(20).optional(),
  variants: z.array(z.object({ label: z.string().trim().min(1).max(60), models: ModelConfig.partial().optional() })).max(3).optional(),
});

const PatchScenarioDto = ScenarioDef.partial();

/**
 * Test an agent without a real visitor: an interactive playground and saved
 * scenarios. Open to everyone in the workspace (it only reads the agent's
 * config); costs model usage, so it is metered per day.
 */
@Controller("agents/:agentId")
@UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard)
export class SimulationController {
  constructor(
    private readonly simulation: SimulationService,
    private readonly scenarios: ScenariosService,
  ) {}

  @Post("simulate")
  async simulate(
    @CurrentUser() user: JwtPayload,
    @Param("agentId") agentId: string,
    @Body(new ZodValidationPipe(SimulateDto)) body: z.infer<typeof SimulateDto>,
  ) {
    const agent = await this.simulation.loadAgent(user.tenantId!, agentId);
    const sessionId = body.sessionId ?? `s${Math.random().toString(36).slice(2, 12)}`;
    const turn = await this.simulation.turn({
      tenantId: user.tenantId!,
      agent,
      sessionId,
      message: body.message,
      sandbox: body.sandbox ?? ScenarioSandbox.parse({}),
    });
    return { sessionId, agentVersion: agent.version, ...turn };
  }

  @Delete("simulate/:sessionId")
  async resetSimulation(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string, @Param("sessionId") sessionId: string) {
    await this.simulation.loadAgent(user.tenantId!, agentId);
    await this.simulation.reset(user.tenantId!, sessionId);
    return { reset: true };
  }

  @Get("scenarios")
  list(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string) {
    return this.scenarios.list(user.tenantId!, agentId);
  }

  @Get("scenarios/status")
  status(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string) {
    return this.scenarios.status(user.tenantId!, agentId);
  }

  @Get("scenarios/runs")
  history(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string, @Query("limit") limit?: string) {
    return this.scenarios.history(user.tenantId!, agentId, Number(limit) || 30);
  }

  @Get("scenarios/runs/:runId")
  getRun(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string, @Param("runId") runId: string) {
    return this.scenarios.getRun(user.tenantId!, agentId, runId);
  }

  @Post("scenarios/run")
  run(
    @CurrentUser() user: JwtPayload,
    @Param("agentId") agentId: string,
    @Body(new ZodValidationPipe(RunDto)) body: z.infer<typeof RunDto>,
  ) {
    return this.scenarios.run(user.tenantId!, agentId, body);
  }

  @Post("scenarios")
  create(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string, @Body(new ZodValidationPipe(ScenarioDef)) body: ScenarioDef) {
    return this.scenarios.create(user.tenantId!, agentId, body);
  }

  @Patch("scenarios/:id")
  update(
    @CurrentUser() user: JwtPayload,
    @Param("agentId") agentId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(PatchScenarioDto)) body: z.infer<typeof PatchScenarioDto>,
  ) {
    return this.scenarios.update(user.tenantId!, agentId, id, body);
  }

  @Delete("scenarios/:id")
  async remove(@CurrentUser() user: JwtPayload, @Param("agentId") agentId: string, @Param("id") id: string) {
    await this.scenarios.remove(user.tenantId!, agentId, id);
    return { deleted: true };
  }
}
