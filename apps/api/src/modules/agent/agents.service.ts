import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import { AgentSpec, WidgetConfig, type AgentStatus } from "@envoy/types";
import { PrismaService } from "../core/prisma/prisma.service.js";

export interface CreateAgentInput {
  name: string;
  script?: string;
  requiredFields?: Prisma.InputJsonValue;
  hardRules?: Prisma.InputJsonValue;
  widgetConfig?: Prisma.InputJsonValue;
  spec?: Prisma.InputJsonValue;
}

/** JSON.stringify with object keys sorted at every depth. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** The whole configuration of an agent, as snapshotted into AgentVersion. */
interface AgentConfigSnapshot {
  script: string;
  requiredFields: unknown;
  hardRules: unknown;
  widgetConfig: unknown;
  spec: unknown;
}

const CONFIG_KEYS = ["script", "requiredFields", "hardRules", "widgetConfig", "spec"] as const;

export interface UpdateAgentInput extends Partial<CreateAgentInput> {
  /** Free-text label stored on the AgentVersion this edit creates. */
  note?: string;
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

  async create(tenantId: string, input: CreateAgentInput) {
    const data = {
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
      spec: AgentSpec.parse(input.spec ?? {}) as Prisma.InputJsonValue,
      version: 1,
    };
    const agent = await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.agent.create({ data });
      await tx.agentVersion.create({
        data: { agentId: created.id, tenantId, version: 1, snapshot: this.snapshotOf(created) as unknown as Prisma.InputJsonValue, note: "Created" },
      });
      return created;
    });
    return this.withDefaults(agent);
  }

  /** Canonical form: stored JSON may predate newer fields, so defaults are filled in before snapshotting or comparing. */
  private snapshotOf(agent: AgentConfigSnapshot): AgentConfigSnapshot {
    return {
      script: agent.script,
      requiredFields: agent.requiredFields,
      hardRules: agent.hardRules,
      widgetConfig: WidgetConfig.parse(agent.widgetConfig ?? {}),
      spec: AgentSpec.parse(agent.spec ?? {}),
    };
  }

  /** Normalizes possibly-legacy/partial stored widgetConfig and spec to their full shapes — same as PublicAgentsController. */
  private withDefaults<T extends { widgetConfig: unknown; spec: unknown }>(agent: T): T {
    return {
      ...agent,
      widgetConfig: WidgetConfig.parse(agent.widgetConfig ?? {}),
      spec: AgentSpec.parse(agent.spec ?? {}),
    };
  }

  async findAllForTenant(tenantId: string) {
    const agents = await this.prisma.client.agent.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    return agents.map((a) => this.withDefaults(a));
  }

  async findOneScoped(tenantId: string, id: string) {
    const agent = await this.prisma.client.agent.findFirst({
      where: { id, tenantId },
    });
    if (!agent) {
      throw new NotFoundException("Agent not found");
    }
    return this.withDefaults(agent);
  }

  async update(tenantId: string, id: string, input: UpdateAgentInput) {
    if (input.leadFormId) {
      // Cheap IDOR guard: without this, a tenant could link (and thereby
      // read the publicToken of, via the public agent endpoint) a form
      // that belongs to someone else.
      const form = await this.prisma.client.form.findFirst({ where: { id: input.leadFormId, tenantId } });
      if (!form) throw new BadRequestException("Form not found");
    }
    const existing = await this.prisma.client.agent.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException("Agent not found");

    const data: UpdateAgentInput = { ...input };
    if (input.spec !== undefined) data.spec = AgentSpec.parse(input.spec) as Prisma.InputJsonValue;
    if (input.widgetConfig !== undefined) data.widgetConfig = WidgetConfig.parse(input.widgetConfig) as Prisma.InputJsonValue;

    await this.applyUpdate(existing, data, input.note);
    return this.findOneScoped(tenantId, id); // already applies the same defaulting
  }

  /**
   * Writes the update; when any configuration field actually changed, bumps
   * the version and snapshots it, in one transaction. Name/status/lead-form
   * edits are not configuration and never create a version. updateMany
   * scoped by tenantId so a cross-tenant id can never be targeted, even if
   * a caller skipped the ownership check above.
   */
  private async applyUpdate(
    existing: { id: string; tenantId: string; version: number } & AgentConfigSnapshot,
    data: UpdateAgentInput,
    note?: string,
  ) {
    const { note: _note, ...columns } = data as UpdateAgentInput & { note?: string };
    const merged: AgentConfigSnapshot = { ...this.snapshotOf(existing) };
    for (const key of CONFIG_KEYS) {
      if (columns[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = columns[key];
    }
    // Postgres JSONB does not preserve key order, so compare canonically rather than by raw string.
    const configChanged = canonical(this.snapshotOf(merged)) !== canonical(this.snapshotOf(existing));

    await this.prisma.client.$transaction(async (tx) => {
      if (!configChanged) {
        const { count } = await tx.agent.updateMany({ where: { id: existing.id, tenantId: existing.tenantId }, data: columns });
        if (count === 0) throw new NotFoundException("Agent not found");
        return;
      }
      // Agents created before versioning have no row for their current version; capture it before moving on.
      await tx.agentVersion.upsert({
        where: { agentId_version: { agentId: existing.id, version: existing.version } },
        create: {
          agentId: existing.id,
          tenantId: existing.tenantId,
          version: existing.version,
          snapshot: this.snapshotOf(existing) as unknown as Prisma.InputJsonValue,
          note: "Before versioning",
        },
        update: {},
      });
      const nextVersion = existing.version + 1;
      const { count } = await tx.agent.updateMany({
        where: { id: existing.id, tenantId: existing.tenantId, version: existing.version },
        data: { ...columns, version: nextVersion },
      });
      // 0 rows = a concurrent edit already moved the version; refuse rather than clobber it.
      if (count === 0) throw new ConflictException("Agent was modified by someone else; reload and retry");
      await tx.agentVersion.create({
        data: {
          agentId: existing.id,
          tenantId: existing.tenantId,
          version: nextVersion,
          snapshot: this.snapshotOf(merged) as unknown as Prisma.InputJsonValue,
          note: note ?? null,
        },
      });
    });
  }

  async listVersions(tenantId: string, id: string) {
    await this.findOneScoped(tenantId, id);
    return this.prisma.client.agentVersion.findMany({
      where: { agentId: id, tenantId },
      orderBy: { version: "desc" },
    });
  }

  /** Re-applies an old snapshot as a NEW version (history is never rewritten). */
  async restoreVersion(tenantId: string, id: string, version: number) {
    const target = await this.prisma.client.agentVersion.findFirst({ where: { agentId: id, tenantId, version } });
    if (!target) throw new NotFoundException("Version not found");
    const snap = target.snapshot as unknown as AgentConfigSnapshot;
    return this.update(tenantId, id, {
      script: snap.script,
      requiredFields: snap.requiredFields as Prisma.InputJsonValue,
      hardRules: snap.hardRules as Prisma.InputJsonValue,
      widgetConfig: snap.widgetConfig as Prisma.InputJsonValue,
      spec: snap.spec as Prisma.InputJsonValue,
      note: `Restored from v${version}`,
    });
  }
}
