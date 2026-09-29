import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import { WidgetConfig, type AgentStatus } from "@envoy/types";
import { PrismaService } from "../core/prisma/prisma.service.js";

export interface CreateAgentInput {
  name: string;
  script?: string;
  requiredFields?: Prisma.InputJsonValue;
  hardRules?: Prisma.InputJsonValue;
  widgetConfig?: Prisma.InputJsonValue;
}

export interface UpdateAgentInput extends Partial<CreateAgentInput> {
  status?: AgentStatus;
  /** null unlinks. Must belong to the same tenant — checked in update() below. */
  leadFormId?: string | null;
}

/**
 * Every method here takes `tenantId` as an explicit first-class argument
 * sourced from the verified JWT (see AgentsController) — never from a route
 * param or request body. Reads use `findFirst({ id, tenantId })`, not
 * `findUnique({ id })`, so a request for another tenant's agent resolves to
 * "not found" rather than leaking the row. This is the tenant-isolation
 * invariant the whole app depends on; see agents.service.isolation.test.ts.
 */
@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  create(tenantId: string, input: CreateAgentInput) {
    return this.prisma.client.agent.create({
      data: {
        tenantId,
        name: input.name,
        script: input.script ?? "",
        requiredFields: input.requiredFields ?? [],
        hardRules: input.hardRules ?? [],
        // Fully defaulted (quickReplies: [], etc), not the bare partial the
        // request sent — every reader (including this row's own future
        // authed GETs) can then assume the full shape, no re-parsing needed.
        widgetConfig: (input.widgetConfig
          ? WidgetConfig.parse(input.widgetConfig)
          : WidgetConfig.parse({})) as Prisma.InputJsonValue,
      },
    });
  }

  /** Normalizes a possibly-legacy/partial stored widgetConfig to the full shape — same as PublicAgentsController. */
  private withDefaultedWidgetConfig<T extends { widgetConfig: unknown }>(agent: T): T {
    return { ...agent, widgetConfig: WidgetConfig.parse(agent.widgetConfig ?? {}) };
  }

  async findAllForTenant(tenantId: string) {
    const agents = await this.prisma.client.agent.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    return agents.map((a) => this.withDefaultedWidgetConfig(a));
  }

  async findOneScoped(tenantId: string, id: string) {
    const agent = await this.prisma.client.agent.findFirst({
      where: { id, tenantId },
    });
    if (!agent) {
      throw new NotFoundException("Agent not found");
    }
    return this.withDefaultedWidgetConfig(agent);
  }

  async update(tenantId: string, id: string, input: UpdateAgentInput) {
    if (input.leadFormId) {
      // Cheap IDOR guard: without this, a tenant could link (and thereby
      // read the publicToken of, via the public agent endpoint) a form
      // that belongs to someone else.
      const form = await this.prisma.client.form.findFirst({ where: { id: input.leadFormId, tenantId } });
      if (!form) throw new BadRequestException("Form not found");
    }
    // updateMany scoped by tenantId so a cross-tenant id can never be
    // targeted, even if findOneScoped's guard were bypassed upstream.
    const { count } = await this.prisma.client.agent.updateMany({
      where: { id, tenantId },
      data: input,
    });
    if (count === 0) {
      throw new NotFoundException("Agent not found");
    }
    return this.findOneScoped(tenantId, id); // already applies the same widgetConfig defaulting
  }
}
