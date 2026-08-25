import { NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@envoy/db";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { AgentsService } from "./agents.service.js";

/**
 * The correctness guarantee this whole app depends on: tenant A can never
 * read, list, or mutate tenant B's rows, no matter what id is passed in.
 * Requires a running Postgres — see packages/db + docker-compose.yml at the
 * repo root. Run `pnpm db:migrate` once before `pnpm --filter @envoy/api test`.
 */
describe("AgentsService tenant isolation", () => {
  const prismaService = new PrismaService();
  const agents = new AgentsService(prismaService);

  let tenantA: { id: string };
  let tenantB: { id: string };
  let agentA: { id: string };

  beforeAll(async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    tenantA = await prisma.tenant.create({ data: { name: `Isolation Test A ${suffix}` } });
    tenantB = await prisma.tenant.create({ data: { name: `Isolation Test B ${suffix}` } });
    agentA = await agents.create(tenantA.id, { name: "Tenant A Agent" });
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: tenantA.id } }); // cascades to agents
    await prisma.tenant.delete({ where: { id: tenantB.id } });
    await prisma.$disconnect();
  });

  it("lets the owning tenant read its own agent", async () => {
    const found = await agents.findOneScoped(tenantA.id, agentA.id);
    expect(found.id).toBe(agentA.id);
  });

  it("returns not-found (never the row) when another tenant requests it by id", async () => {
    await expect(agents.findOneScoped(tenantB.id, agentA.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("never includes another tenant's agent in a list query", async () => {
    const tenantBAgents = await agents.findAllForTenant(tenantB.id);
    expect(tenantBAgents.find((a) => a.id === agentA.id)).toBeUndefined();
  });

  it("cannot be mutated by another tenant, and leaves the row unchanged", async () => {
    await expect(
      agents.update(tenantB.id, agentA.id, { name: "hijacked" }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const stillOwnedByA = await agents.findOneScoped(tenantA.id, agentA.id);
    expect(stillOwnedByA.name).toBe("Tenant A Agent");
  });
});
