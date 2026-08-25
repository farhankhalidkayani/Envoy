import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import type { AgentStatus } from "@envoy/types";
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
        widgetConfig: input.widgetConfig ?? {},
      },
    });
  }

  findAllForTenant(tenantId: string) {
    return this.prisma.client.agent.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
  }

  async findOneScoped(tenantId: string, id: string) {
    const agent = await this.prisma.client.agent.findFirst({
      where: { id, tenantId },
    });
    if (!agent) {
      throw new NotFoundException("Agent not found");
    }
    return agent;
  }

  async update(tenantId: string, id: string, input: UpdateAgentInput) {
    // updateMany scoped by tenantId so a cross-tenant id can never be
    // targeted, even if findOneScoped's guard were bypassed upstream.
    const { count } = await this.prisma.client.agent.updateMany({
      where: { id, tenantId },
      data: input,
    });
    if (count === 0) {
      throw new NotFoundException("Agent not found");
    }
    return this.findOneScoped(tenantId, id);
  }
}
