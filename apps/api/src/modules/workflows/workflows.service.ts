import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@envoy/db";
import {
  WorkflowConditions,
  WorkflowDef,
  WorkflowSettings,
  WorkflowStep,
  WorkflowTrigger,
  delayMs,
  describeConditions,
  isStartKeyword,
  isStopKeyword,
  leadMatches,
  normalizeEmail,
  stepApplies,
  normalizePhone,
  type WorkflowStatus,
} from "@envoy/types";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { sanitizeCapturedData } from "../core/common/sanitize-captured-data.js";
import type { PushSource } from "../integrations/types.js";
import { contactHash, type Channel } from "./contact.js";
import { WorkflowEngine, type Decision, type Lead } from "./workflow-engine.service.js";
import { WorkflowQueueService } from "./workflow-queue.service.js";

const MAX_WORKFLOWS = 25;

type Row = { id: string; name: string; status: WorkflowStatus; trigger: unknown; conditions: unknown; steps: unknown; settings: unknown; createdAt: Date; updatedAt: Date };

export interface PreviewStep {
  index: number;
  type: WorkflowStep["type"];
  result: "wait" | "send" | "skip" | "end";
  /** When it would happen, in ms after enrolment (waits and held messages included). */
  atMs: number;
  detail?: string;
  to?: string;
  subject?: string;
  body?: string;
  missingVariables?: string[];
}

@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: WorkflowEngine,
    private readonly queue: WorkflowQueueService,
  ) {}

  private view(w: Row) {
    return { id: w.id, name: w.name, status: w.status, trigger: w.trigger, conditions: w.conditions, steps: w.steps, settings: WorkflowSettings.parse(w.settings ?? {}), createdAt: w.createdAt, updatedAt: w.updatedAt };
  }

  private async scoped(tenantId: string, id: string) {
    const w = await this.prisma.client.workflow.findFirst({ where: { id, tenantId } });
    if (!w) throw new NotFoundException("Workflow not found");
    return w;
  }

  private async assertTriggerTargetsOwned(tenantId: string, trigger: WorkflowTrigger) {
    if (trigger.agentId && !(await this.prisma.client.agent.findFirst({ where: { id: trigger.agentId, tenantId }, select: { id: true } }))) throw new BadRequestException("Agent not found");
    if (trigger.formId && !(await this.prisma.client.form.findFirst({ where: { id: trigger.formId, tenantId }, select: { id: true } }))) throw new BadRequestException("Form not found");
  }

  async list(tenantId: string) {
    const [rows, grouped, sent] = await Promise.all([
      this.prisma.client.workflow.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }),
      this.prisma.client.workflowRun.groupBy({ by: ["workflowId", "status"], where: { tenantId }, _count: { _all: true } }),
      this.prisma.client.workflowStepLog.count({ where: { tenantId, status: "sent", createdAt: { gt: new Date(Date.now() - 30 * 86_400_000) } } }),
    ]);
    return {
      sentLast30Days: sent,
      workflows: rows.map((w) => ({
        ...this.view(w),
        runs: Object.fromEntries(grouped.filter((g) => g.workflowId === w.id).map((g) => [g.status, g._count._all])),
      })),
    };
  }

  async get(tenantId: string, id: string) {
    return this.view(await this.scoped(tenantId, id));
  }

  async create(tenantId: string, def: WorkflowDef) {
    if ((await this.prisma.client.workflow.count({ where: { tenantId } })) >= MAX_WORKFLOWS) throw new BadRequestException(`A workspace can have at most ${MAX_WORKFLOWS} workflows.`);
    await this.assertTriggerTargetsOwned(tenantId, def.trigger);
    const w = await this.prisma.client.workflow.create({
      data: { tenantId, name: def.name, trigger: def.trigger, conditions: def.conditions, steps: def.steps, settings: def.settings },
    });
    return this.view(w);
  }

  /** A live workflow can't be edited: runs in flight read its steps by position, so changing them mid-run would send the wrong thing. Pause it first. */
  async update(tenantId: string, id: string, patch: Partial<WorkflowDef>) {
    const existing = await this.scoped(tenantId, id);
    if (existing.status === "live") throw new ConflictException("Pause this workflow before editing it. Leads already in it are stopped when you pause.");
    const merged = WorkflowDef.safeParse({
      name: patch.name ?? existing.name,
      trigger: patch.trigger ?? existing.trigger,
      conditions: patch.conditions ?? existing.conditions,
      steps: patch.steps ?? existing.steps,
      settings: patch.settings ?? existing.settings,
    });
    if (!merged.success) throw new BadRequestException(merged.error.issues.map((i) => i.message).join("; "));
    await this.assertTriggerTargetsOwned(tenantId, merged.data.trigger);
    const w = await this.prisma.client.workflow.update({
      where: { id },
      data: { name: merged.data.name, trigger: merged.data.trigger, conditions: merged.data.conditions, steps: merged.data.steps, settings: merged.data.settings },
    });
    return this.view(w);
  }

  /** Going live starts enrolling new leads. Pausing stops every lead currently in the workflow (they are not resumed on re-activation). */
  async setStatus(tenantId: string, id: string, status: WorkflowStatus) {
    const existing = await this.scoped(tenantId, id);
    if (existing.status === status) return this.view(existing);
    if (status === "draft") throw new BadRequestException("A workflow can't go back to draft.");
    if (status === "live") {
      const valid = WorkflowDef.safeParse({ name: existing.name, trigger: existing.trigger, conditions: existing.conditions, steps: existing.steps, settings: existing.settings });
      if (!valid.success) throw new BadRequestException("This workflow isn't valid: " + valid.error.issues.map((i) => i.message).join("; "));
    }
    const w = await this.prisma.client.workflow.update({ where: { id }, data: { status } });
    if (status === "paused") {
      await this.prisma.client.workflowRun.updateMany({ where: { workflowId: id, status: "running" }, data: { status: "stopped", stopReason: "workflow_paused", finishedAt: new Date(), nextRunAt: null } });
    }
    return this.view(w);
  }

  async remove(tenantId: string, id: string) {
    await this.scoped(tenantId, id);
    await this.prisma.client.workflow.delete({ where: { id } }); // runs and logs go with it
  }

  // ── enrolment ────────────────────────────────────────────

  /**
   * Called when a lead arrives (see CaptureRoutingService). Enrols the lead in every live workflow of the workspace
   * whose trigger and conditions it meets. A lead can enter a given workflow once, ever: a repeat call is a no-op.
   * Never throws — a problem here must not affect completing the conversation.
   */
  async enroll(tenantId: string, source: PushSource): Promise<number> {
    try {
      const isConversation = "conversationId" in source;
      const lead = isConversation
        ? await this.prisma.client.conversation.findFirst({ where: { id: source.conversationId, tenantId }, select: { agentId: true, capturedData: true, outcomeType: true } })
        : await this.prisma.client.formSubmission.findFirst({ where: { id: source.formSubmissionId, tenantId }, select: { formId: true, data: true } });
      if (!lead) return 0;

      const data = sanitizeCapturedData((("capturedData" in lead ? lead.capturedData : lead.data) as Record<string, unknown>) ?? {});
      const outcome = "outcomeType" in lead ? lead.outcomeType : null;
      const live = await this.prisma.client.workflow.findMany({ where: { tenantId, status: "live" } });

      let enrolled = 0;
      for (const w of live) {
        const trigger = WorkflowTrigger.safeParse(w.trigger);
        const conditions = WorkflowConditions.safeParse(w.conditions ?? {});
        if (!trigger.success || !conditions.success) continue;
        if (trigger.data.type !== (isConversation ? "conversation_completed" : "form_submitted")) continue;
        if (trigger.data.agentId && trigger.data.agentId !== ("agentId" in lead ? lead.agentId : undefined)) continue;
        if (trigger.data.formId && trigger.data.formId !== ("formId" in lead ? lead.formId : undefined)) continue;
        if (!leadMatches(conditions.data, data, outcome)) continue;

        try {
          const run = await this.prisma.client.workflowRun.create({
            data: { tenantId, workflowId: w.id, sourceType: isConversation ? "conversation" : "form_submission", sourceId: isConversation ? source.conversationId : (source as { formSubmissionId: string }).formSubmissionId },
          });
          await this.queue.enqueue(run.id, 0);
          enrolled++;
        } catch (err) {
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err; // already enrolled: fine
        }
      }
      return enrolled;
    } catch (err) {
      this.logger.warn(`workflow enrolment failed: ${(err as Error).message}`);
      return 0;
    }
  }

  // ── runs ─────────────────────────────────────────────────

  async runs(tenantId: string, workflowId: string, opts: { status?: string; limit: number }) {
    await this.scoped(tenantId, workflowId);
    return this.prisma.client.workflowRun.findMany({
      where: { tenantId, workflowId, ...(opts.status ? { status: opts.status as never } : {}) },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(opts.limit, 1), 200),
    });
  }

  async getRun(tenantId: string, runId: string) {
    const run = await this.prisma.client.workflowRun.findFirst({ where: { id: runId, tenantId }, include: { logs: { orderBy: { stepIndex: "asc" } }, workflow: { select: { id: true, name: true } } } });
    if (!run) throw new NotFoundException("Run not found");
    return run;
  }

  async cancelRun(tenantId: string, runId: string) {
    await this.getRun(tenantId, runId);
    await this.engine.stop(runId, "cancelled");
    return { cancelled: true };
  }

  // ── preview ──────────────────────────────────────────────

  /**
   * Plays a workflow against a sample lead without sending anything or enrolling anyone: whether the lead qualifies,
   * what each step would do and when, with the real gate (opt-outs, consent, quiet hours, caps) applied.
   */
  async preview(tenantId: string, def: WorkflowDef, lead: Lead) {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    const qualifies = leadMatches(def.conditions, lead.data, lead.outcome);
    const steps: PreviewStep[] = [];
    const start = Date.now();
    let offset = 0;
    for (const [index, step] of def.steps.entries()) {
      if (!stepApplies(step, lead.data, lead.outcome)) {
        steps.push({ index, type: step.type, result: "skip", atMs: offset, detail: `Condition not met: ${describeConditions(step.when!)}` });
        continue;
      }
      if (step.type === "exit") {
        steps.push({ index, type: "exit", result: "end", atMs: offset, detail: `Ends here: ${describeConditions(step.when!)}` });
        break; // nothing after it would happen for this lead
      }
      if (step.type === "wait") {
        offset += delayMs(step);
        steps.push({ index, type: "wait", result: "wait", atMs: offset, detail: `Wait ${step.amount} ${step.unit}` });
        continue;
      }
      let decision: Decision = await this.engine.decide({ tenantId, businessName: tenant?.name ?? "Your business", settings: def.settings, step, lead, now: new Date(start + offset) });
      if (decision.action === "defer" && decision.reason.startsWith("Quiet hours")) {
        offset += decision.delayMs; // it would simply go out when quiet hours end
        decision = await this.engine.decide({ tenantId, businessName: tenant?.name ?? "Your business", settings: def.settings, step, lead, now: new Date(start + offset) });
        if (decision.action === "send") {
          steps.push({ index, type: step.type, result: "send", atMs: offset, detail: "Held until quiet hours end", to: decision.to, subject: decision.subject, body: decision.body, missingVariables: decision.missingVariables });
          continue;
        }
      }
      if (decision.action === "send") steps.push({ index, type: step.type, result: "send", atMs: offset, to: decision.to, subject: decision.subject, body: decision.body, missingVariables: decision.missingVariables });
      else steps.push({ index, type: step.type, result: "skip", atMs: offset, detail: decision.reason });
    }
    return { qualifies, steps };
  }

  // ── opt-outs and inbound SMS ──────────────────────────────

  listOptOuts(tenantId: string, channel?: Channel) {
    return this.prisma.client.optOut.findMany({ where: { tenantId, ...(channel ? { channel } : {}) }, orderBy: { createdAt: "desc" }, take: 500 });
  }

  async addOptOut(tenantId: string, channel: Channel, rawAddress: string) {
    const address = channel === "email" ? normalizeEmail(rawAddress) : normalizePhone(rawAddress);
    if (!address) throw new BadRequestException(channel === "email" ? "That isn't a valid email address." : "Enter the phone number in international format, e.g. +44 7700 900123.");
    await this.engine.optOut(tenantId, channel, address, "manual");
    return { channel, address };
  }

  /** Only entries a person added by hand can be removed. Someone who unsubscribed or texted STOP can only opt back in themselves. */
  async removeOptOut(tenantId: string, id: string) {
    const entry = await this.prisma.client.optOut.findFirst({ where: { id, tenantId } });
    if (!entry) throw new NotFoundException("Not found");
    if (entry.reason !== "manual") throw new ForbiddenException("This person chose to opt out. They can opt back in themselves (reply START to a text); it can't be reversed for them.");
    await this.prisma.client.optOut.delete({ where: { id } });
  }

  /** An email unsubscribe link was used. Idempotent. */
  async unsubscribeEmail(tenantId: string, email: string) {
    await this.engine.optOut(tenantId, "email", email, "unsubscribed");
  }

  /**
   * An inbound SMS. STOP (and its carrier synonyms) opts the sender out for every workspace that has texted them from
   * the shared number; START opts them back in; anything else is a reply, which ends the sequences that asked to stop on reply.
   */
  async handleInboundSms(from: string, text: string): Promise<{ action: "stop" | "start" | "reply" | "ignored" }> {
    const phone = normalizePhone(from);
    if (!phone) return { action: "ignored" };
    const hash = contactHash("sms", phone);
    const sent = await this.prisma.client.workflowStepLog.findMany({ where: { toHash: hash, status: "sent" }, select: { tenantId: true, runId: true } });
    const tenants = [...new Set(sent.map((s) => s.tenantId))];
    if (tenants.length === 0) return { action: "ignored" };

    if (isStopKeyword(text)) {
      for (const tenantId of tenants) await this.engine.optOut(tenantId, "sms", phone, "stop");
      return { action: "stop" };
    }
    if (isStartKeyword(text)) {
      await this.prisma.client.optOut.deleteMany({ where: { channel: "sms", address: phone, reason: "stop", tenantId: { in: tenants } } });
      return { action: "start" };
    }
    const runs = await this.prisma.client.workflowRun.findMany({ where: { id: { in: [...new Set(sent.map((s) => s.runId))] }, status: "running" }, include: { workflow: { select: { settings: true } } } });
    for (const run of runs) {
      if (WorkflowSettings.parse(run.workflow.settings ?? {}).exitOnReply) await this.engine.stop(run.id, "replied");
    }
    return { action: "reply" };
  }
}
