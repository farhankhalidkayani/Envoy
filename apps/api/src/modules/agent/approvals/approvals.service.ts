import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import {
  APPROVAL_KIND_LABELS,
  APPROVAL_TTL_HOURS,
  AgentSpec,
  ApprovalParams,
  HardRulesSpec,
  MAX_PENDING_PER_TOKEN,
  TOOL_ACCESS_NOTES,
  canonicalParams,
  type ApprovalStatus,
  type CreateApprovalInput,
} from "@envoy/types";
import { createHash } from "node:crypto";
import { PrismaService } from "../../core/prisma/prisma.service.js";
import { CrmService } from "../../crm/crm.service.js";
import { IntegrationsService } from "../../integrations/integrations.service.js";
import { AgentsService } from "../agents.service.js";
import { ProposalsService } from "../improvement/proposals.service.js";
import { ScenariosService } from "../simulation/scenarios.service.js";

export interface Requester {
  userId: string;
  /** Present when an API token (e.g. an AI assistant over MCP) is asking. */
  token?: { id: string; name: string };
}

export interface ApprovalSummary {
  title: string;
  /** Facts the reviewer needs, built by the server from the agent's real state — not written by the requester. */
  lines: string[];
  /** Things worth pausing on before saying yes. */
  warnings: string[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ruleKey = (r: { id: string; text: string; action: string; severity: string }) => `${r.text}|${r.action}|${r.severity}`;

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentsService,
    private readonly proposals: ProposalsService,
    private readonly scenarios: ScenariosService,
    private readonly crm: CrmService,
    private readonly integrations: IntegrationsService,
  ) {}

  private async agentScoped(tenantId: string, agentId: string) {
    const agent = await this.prisma.client.agent.findFirst({ where: { id: agentId, tenantId } });
    if (!agent) throw new NotFoundException("Agent not found");
    return agent;
  }

  /** A request nobody answered in time is closed, the first time anyone looks at it. */
  private async expireIfDue<T extends { id: string; status: ApprovalStatus; expiresAt: Date }>(row: T): Promise<T> {
    if (row.status === "pending" && row.expiresAt.getTime() <= Date.now()) {
      await this.prisma.client.approvalRequest.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "expired", note: "Nobody answered in time." } });
      return { ...row, status: "expired" };
    }
    return row;
  }

  async create(tenantId: string, who: Requester, input: CreateApprovalInput) {
    const agent = await this.agentScoped(tenantId, input.agentId);
    const params = input.params;
    await this.assertMakesSense(tenantId, agent, params);

    const paramsHash = sha(canonicalParams(params));
    const open = await this.prisma.client.approvalRequest.findMany({ where: { tenantId, status: "pending", expiresAt: { gt: new Date() } } });

    // Asking twice for the same thing is one request, not two: the reviewer sees it once.
    const duplicate = open.find((r) => r.agentId === agent.id && r.paramsHash === paramsHash && r.baseVersion === agent.version);
    if (duplicate) return this.view(duplicate, tenantId);

    if (who.token && open.filter((r) => r.tokenId === who.token!.id).length >= MAX_PENDING_PER_TOKEN) {
      throw new BadRequestException(`This token already has ${MAX_PENDING_PER_TOKEN} requests waiting for a person. Wait for them to be answered.`);
    }

    const row = await this.prisma.client.approvalRequest.create({
      data: {
        tenantId,
        tokenId: who.token?.id,
        requestedBy: who.token?.name ?? "A team member",
        agentId: agent.id,
        params: params as unknown as Prisma.InputJsonValue,
        paramsHash,
        baseVersion: agent.version,
        reason: input.reason,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_HOURS * 3_600_000),
      },
    });
    await this.prisma.client.auditLog.create({ data: { adminUserId: who.userId, tenantId, action: "approval.requested", meta: { approvalId: row.id, kind: params.kind, agentId: agent.id, by: row.requestedBy } } });
    return this.view(row, tenantId);
  }

  /** Refuse requests that could not do anything, so the reviewer is never asked about a no-op. */
  private async assertMakesSense(tenantId: string, agent: { id: string; status: string; version: number; hardRules: unknown; spec: unknown }, params: ApprovalParams) {
    switch (params.kind) {
      case "publish_agent":
        if (agent.status === "live") throw new BadRequestException("This agent is already live.");
        return;
      case "restore_version": {
        if (params.version === agent.version) throw new BadRequestException("That is the version the agent is already on.");
        const target = await this.prisma.client.agentVersion.findFirst({ where: { agentId: agent.id, tenantId, version: params.version } });
        if (!target) throw new BadRequestException("That version doesn't exist.");
        return;
      }
      case "approve_proposal": {
        const p = await this.prisma.client.proposal.findFirst({ where: { id: params.proposalId, agentId: agent.id, tenantId } });
        if (!p) throw new BadRequestException("That proposal doesn't exist for this agent.");
        if (p.status !== "tested") throw new BadRequestException(p.status === "pending" ? "Test the proposal first." : `That proposal was already ${p.status}.`);
        return;
      }
      case "set_hard_rules": {
        const current = HardRulesSpec.parse(agent.hardRules ?? []);
        const same = current.length === params.hardRules.length && current.every((r) => params.hardRules.some((n) => n.id === r.id && ruleKey(n) === ruleKey(r)));
        if (same) throw new BadRequestException("Those are the hard rules the agent already has.");
        if (new Set(params.hardRules.map((r) => r.id)).size !== params.hardRules.length) throw new BadRequestException("Hard rule ids must be unique.");
        return;
      }
      case "enable_tools": {
        const enabled = new Set(AgentSpec.parse(agent.spec ?? {}).tools.filter((t) => t.enabled).map((t) => t.name as string));
        if (params.tools.every((t) => enabled.has(t))) throw new BadRequestException("Those tools are already enabled.");
        return;
      }
    }
  }

  // ── reading ──────────────────────────────────────────────

  async list(tenantId: string, status?: ApprovalStatus) {
    const rows = await this.prisma.client.approvalRequest.findMany({ where: { tenantId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: 100 });
    return Promise.all(rows.map(async (r) => this.view(await this.expireIfDue(r), tenantId)));
  }

  async pendingCount(tenantId: string) {
    return { pending: await this.prisma.client.approvalRequest.count({ where: { tenantId, status: "pending", expiresAt: { gt: new Date() } } }) };
  }

  async get(tenantId: string, id: string) {
    return this.view(await this.expireIfDue(await this.scoped(tenantId, id)), tenantId);
  }

  private async scoped(tenantId: string, id: string) {
    const row = await this.prisma.client.approvalRequest.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Request not found");
    return row;
  }

  private async view(row: Awaited<ReturnType<ApprovalsService["scoped"]>>, tenantId: string) {
    const agent = await this.prisma.client.agent.findFirst({ where: { id: row.agentId, tenantId }, select: { name: true, version: true } });
    const params = ApprovalParams.parse(row.params);
    const stale = row.status === "pending" && agent !== null && agent.version !== row.baseVersion;
    return {
      id: row.id,
      kind: params.kind,
      kindLabel: APPROVAL_KIND_LABELS[params.kind],
      status: row.status,
      agentId: row.agentId,
      agentName: agent?.name ?? "(deleted agent)",
      requestedBy: row.requestedBy,
      reason: row.reason,
      baseVersion: row.baseVersion,
      currentVersion: agent?.version ?? null,
      /** The agent changed since this was asked: it can no longer be approved as reviewed. */
      stale,
      note: row.note,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      decidedAt: row.decidedAt,
      result: row.result,
      summary: agent && row.status === "pending" ? await this.describe(tenantId, row.agentId, params) : null,
    };
  }

  /** What approving would really do, written from the agent's current state. The requester's words never appear here. */
  private async describe(tenantId: string, agentId: string, params: ApprovalParams): Promise<ApprovalSummary> {
    const agent = await this.prisma.client.agent.findFirstOrThrow({ where: { id: agentId, tenantId } });
    const spec = AgentSpec.parse(agent.spec ?? {});
    const rules = HardRulesSpec.parse(agent.hardRules ?? []);
    const lines: string[] = [];
    const warnings: string[] = [];

    switch (params.kind) {
      case "publish_agent": {
        const status = await this.scenarios.status(tenantId, agentId);
        lines.push(`“${agent.name}” (version ${agent.version}, ${spec.runtime.mode} mode) will start talking to visitors on every site that embeds it.`);
        lines.push(`It collects ${(agent.requiredFields as unknown[]).length} field(s) and has ${rules.length} hard rule(s).`);
        const tools = spec.tools.filter((t) => t.enabled).map((t) => t.name);
        if (tools.length) lines.push(`Tools it may use beyond the basics: ${tools.join(", ")}.`);
        lines.push(status.total === 0 ? "It has no test scenarios." : `Scenarios on this version: ${status.passing} passing, ${status.failing} failing, ${status.notRun} not run.`);
        if (status.failing > 0) warnings.push(`${status.failing} scenario(s) are failing on this version.`);
        if (status.total > 0 && status.notRun > 0) warnings.push(`${status.notRun} scenario(s) haven't been run on this version.`);
        if (status.total === 0) warnings.push("Nothing has tested this agent's behaviour.");
        if (rules.length === 0) warnings.push("It has no hard rules.");
        return { title: `Publish “${agent.name}”`, lines, warnings };
      }
      case "restore_version": {
        const target = await this.prisma.client.agentVersion.findFirstOrThrow({ where: { agentId, tenantId, version: params.version } });
        const snap = target.snapshot as { script?: string; hardRules?: unknown; spec?: unknown };
        const targetRules = HardRulesSpec.parse(snap.hardRules ?? []);
        lines.push(`“${agent.name}” goes from version ${agent.version} back to version ${params.version} (${target.note ?? "no note"}, ${target.createdAt.toISOString().slice(0, 10)}), as a new version.`);
        if (snap.script !== agent.script) lines.push("The script changes.");
        const gone = rules.filter((r) => !targetRules.some((t) => t.id === r.id));
        const added = targetRules.filter((t) => !rules.some((r) => r.id === t.id));
        if (added.length) lines.push(`Hard rules added: ${added.map((r) => `“${r.text}”`).join("; ")}.`);
        if (gone.length) warnings.push(`Hard rules that would be REMOVED: ${gone.map((r) => `“${r.text}”`).join("; ")}.`);
        if (agent.status === "live") warnings.push("The agent is live: visitors get the restored behaviour immediately.");
        return { title: `Restore version ${params.version} of “${agent.name}”`, lines, warnings };
      }
      case "approve_proposal": {
        const p = await this.prisma.client.proposal.findFirstOrThrow({ where: { id: params.proposalId, agentId, tenantId } });
        const t = p.testResult as { safe?: boolean; scenarios?: { total: number; baselinePassed: number; candidatePassed: number; regressions: unknown[] } } | null;
        lines.push(`An improvement drafted by the assistant would be applied to “${agent.name}” as a new version.`, `Its stated reason: “${p.rationale}”`, `It changes: ${Object.keys(p.changes as object).join(", ")}.`);
        if (t?.scenarios) lines.push(`Tested: ${t.scenarios.baselinePassed}/${t.scenarios.total} scenarios passed before, ${t.scenarios.candidatePassed}/${t.scenarios.total} with the change.`);
        if (!t?.safe) warnings.push("It did NOT pass the safety check and cannot be applied.");
        if (t?.scenarios?.total === 0) warnings.push("There are no scenarios, so nothing checked it for regressions.");
        return { title: "Apply a proposed improvement", lines, warnings };
      }
      case "set_hard_rules": {
        const added = params.hardRules.filter((n) => !rules.some((r) => r.id === n.id));
        const removed = rules.filter((r) => !params.hardRules.some((n) => n.id === r.id));
        const changed = params.hardRules.filter((n) => rules.some((r) => r.id === n.id && ruleKey(r) !== ruleKey(n)));
        for (const r of added) lines.push(`ADD: “${r.text}” (${r.action}, ${r.severity})`);
        for (const r of changed) lines.push(`CHANGE: “${rules.find((x) => x.id === r.id)!.text}” → “${r.text}” (${r.action}, ${r.severity})`);
        for (const r of removed) lines.push(`REMOVE: “${r.text}”`);
        if (removed.length) warnings.push("Removing a rule lets the agent say things it is currently blocked from saying.");
        if (changed.length) warnings.push("Changing a rule can loosen it — read the new wording carefully.");
        if (agent.status === "live") warnings.push("The agent is live: this takes effect for visitors immediately.");
        return { title: `Change hard rules on “${agent.name}”`, lines, warnings };
      }
      case "enable_tools": {
        const [crm, calendar] = [Boolean(await this.crm.getConnection(tenantId)), await this.integrations.hasCalendar(tenantId)];
        for (const t of params.tools) lines.push(`${t}: ${TOOL_ACCESS_NOTES[t] ?? t}`);
        lines.push(`CRM connected: ${crm ? "yes" : "no"}. Calendar connected: ${calendar ? "yes" : "no"} (a tool only works once its system is connected).`);
        warnings.push("The agent will act on your own systems while talking to members of the public.");
        if (agent.status === "live") warnings.push("The agent is live: this takes effect for visitors immediately.");
        return { title: `Give “${agent.name}” access to your CRM or calendar`, lines, warnings };
      }
    }
  }

  // ── deciding ─────────────────────────────────────────────

  async reject(tenantId: string, userId: string, id: string) {
    const row = await this.expireIfDue(await this.scoped(tenantId, id));
    if (row.status !== "pending") throw new ConflictException(`This request is already ${row.status}.`);
    await this.prisma.client.approvalRequest.updateMany({ where: { id, status: "pending" }, data: { status: "rejected", decidedBy: userId, decidedAt: new Date() } });
    await this.prisma.client.auditLog.create({ data: { adminUserId: userId, tenantId, action: "approval.rejected", meta: { approvalId: id, agentId: row.agentId } } });
    return { status: "rejected" as const };
  }

  /**
   * Carries out exactly what was requested, once, as the person approving. Refused if the request has expired, if the
   * stored action no longer matches its fingerprint, or if the agent has changed since it was asked.
   */
  async approve(tenantId: string, userId: string, id: string) {
    const row = await this.expireIfDue(await this.scoped(tenantId, id));
    if (row.status !== "pending") throw new ConflictException(`This request is already ${row.status}.`);

    const params = ApprovalParams.safeParse(row.params);
    if (!params.success || sha(canonicalParams(params.data)) !== row.paramsHash) {
      await this.finish(id, "failed", "The request no longer matches what was reviewed, so it was not carried out.");
      throw new ConflictException("The request no longer matches what was reviewed, so it was not carried out.");
    }
    const agent = await this.prisma.client.agent.findFirst({ where: { id: row.agentId, tenantId } });
    if (!agent) {
      await this.finish(id, "failed", "The agent no longer exists.");
      throw new ConflictException("The agent no longer exists.");
    }
    if (agent.version !== row.baseVersion) {
      await this.finish(id, "stale", `The agent changed (v${row.baseVersion} → v${agent.version}) after this was requested.`);
      throw new ConflictException("The agent has changed since this was requested. Ask again so you review the current version.");
    }

    // Single use: only one concurrent approval can claim it.
    const claimed = await this.prisma.client.approvalRequest.updateMany({ where: { id, status: "pending" }, data: { status: "approved", decidedBy: userId, decidedAt: new Date() } });
    if (claimed.count === 0) throw new ConflictException("This request was just decided by someone else.");

    try {
      const result = await this.execute(tenantId, userId, row.agentId, params.data);
      await this.prisma.client.approvalRequest.update({ where: { id }, data: { result: result as Prisma.InputJsonValue } });
      await this.prisma.client.auditLog.create({ data: { adminUserId: userId, tenantId, action: "approval.approved", meta: { approvalId: id, kind: params.data.kind, agentId: row.agentId, requestedBy: row.requestedBy } } });
      return { status: "approved" as const, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : "It could not be carried out.";
      await this.finish(id, "failed", message);
      if (err instanceof ForbiddenException || err instanceof ConflictException || err instanceof BadRequestException) throw err;
      throw new ConflictException(message);
    }
  }

  private finish(id: string, status: ApprovalStatus, note: string) {
    return this.prisma.client.approvalRequest.update({ where: { id }, data: { status, note, decidedAt: new Date() } });
  }

  private async execute(tenantId: string, userId: string, agentId: string, params: ApprovalParams): Promise<Record<string, unknown>> {
    switch (params.kind) {
      case "publish_agent": {
        const a = await this.agents.update(tenantId, agentId, { status: "live" });
        return { status: a.status, version: a.version };
      }
      case "restore_version": {
        const a = await this.agents.restoreVersion(tenantId, agentId, params.version);
        return { restoredFrom: params.version, version: a.version };
      }
      case "approve_proposal":
        return this.proposals.approve(tenantId, agentId, params.proposalId, userId, { acknowledgeUntested: params.acknowledgeUntested });
      case "set_hard_rules": {
        const a = await this.agents.update(tenantId, agentId, { hardRules: params.hardRules as unknown as Prisma.InputJsonValue, note: "Hard rules changed (approved request)" });
        return { version: a.version, hardRules: params.hardRules.length };
      }
      case "enable_tools": {
        const current = AgentSpec.parse((await this.agents.findOneScoped(tenantId, agentId)).spec);
        const kept = current.tools.filter((t) => !(params.tools as string[]).includes(t.name));
        const spec = AgentSpec.parse({ ...current, tools: [...kept, ...params.tools.map((name) => ({ ...current.tools.find((t) => t.name === name), name, enabled: true }))] });
        const a = await this.agents.update(tenantId, agentId, { spec: spec as unknown as Prisma.InputJsonValue, note: `Enabled ${params.tools.join(", ")} (approved request)` });
        return { version: a.version, enabled: params.tools };
      }
    }
  }
}
