import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  WorkflowSettings,
  WorkflowStep,
  delayMs,
  describeConditions,
  isConsentGiven,
  stepApplies,
  normalizeEmail,
  normalizePhone,
  quietHoursDelayMs,
  withSmsOptOutNotice,
  type WorkflowSettings as Settings,
} from "@envoy/types";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { sanitizeCapturedData } from "../core/common/sanitize-captured-data.js";
import { renderTemplate } from "../integrations/template.js";
import { EMAIL_CHANNEL, SMS_CHANNEL, type EmailChannel, type SmsChannel } from "./channels.js";
import { contactHash, emailFooter, maskAddress, unsubscribeUrl, type Channel } from "./contact.js";

export const DEFAULT_DAILY_SEND_CAP = 500;
/** Most messages any one person can get from a workspace's workflows in a day, whatever the workflows say. */
export const MAX_MESSAGES_PER_CONTACT_PER_DAY = 5;
const HOUR = 3_600_000;

export type Lead = { data: Record<string, unknown>; outcome: string | null };

export type SendStep = Extract<WorkflowStep, { type: "send_email" | "send_sms" }>;

export type Decision =
  | { action: "send"; channel: Channel; to: string; subject?: string; body: string; headers?: Record<string, string>; toLead: boolean; missingVariables: string[] }
  | { action: "skip"; reason: string }
  | { action: "defer"; delayMs: number; reason: string };

export type Advance = { done: true } | { wakeInMs: number };

/** Names used in a template that the lead has no value for — shown in the preview so "Hi ," never ships unnoticed. */
export function missingVariables(template: string, data: Record<string, unknown>): string[] {
  const names = [...template.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]!);
  return [...new Set(names)].filter((n) => data[n] === undefined || data[n] === null || data[n] === "");
}

/**
 * Runs one lead through one workflow, a step at a time. Every message passes the same gate before it leaves:
 * a valid address, no opt-out, consent where required, outside quiet hours, under the daily and per-contact caps,
 * and the workspace not locked. A step that fails the gate is skipped (and says why) or held until it can go.
 * State is persisted after every step, so a crash or restart resumes exactly where it left off.
 */
@Injectable()
export class WorkflowEngine {
  private readonly logger = new Logger(WorkflowEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_CHANNEL) private readonly email: EmailChannel,
    @Inject(SMS_CHANNEL) private readonly sms: SmsChannel,
  ) {}

  async isOptedOut(tenantId: string, channel: Channel, address: string): Promise<boolean> {
    return (await this.prisma.client.optOut.count({ where: { tenantId, channel, address } })) > 0;
  }

  async optOut(tenantId: string, channel: Channel, address: string, reason: "unsubscribed" | "stop" | "manual") {
    await this.prisma.client.optOut.upsert({
      where: { tenantId_channel_address: { tenantId, channel, address } },
      create: { tenantId, channel, address, reason },
      update: {}, // never downgrade or rewrite an existing opt-out
    });
  }

  /**
   * Whether a send step may go out for this lead right now, and exactly what would be sent. Used by the live run and by
   * the preview, so what the tenant sees in the preview is what the gate would do.
   */
  async decide(params: { tenantId: string; businessName: string; settings: Settings; step: SendStep; lead: Lead; now: Date }): Promise<Decision> {
    const { tenantId, settings, step, lead, now } = params;
    const data = { ...lead.data, outcome: lead.outcome ?? "" };
    const toLead = step.type === "send_sms" || step.to === "lead";

    let address: string;
    const channel: Channel = step.type === "send_sms" ? "sms" : "email";
    if (step.type === "send_sms") {
      const phone = normalizePhone(lead.data[settings.phoneField]);
      if (!phone) return { action: "skip", reason: `No phone number in international format (+…) in “${settings.phoneField}”` };
      address = phone;
      if (settings.smsConsentField && !isConsentGiven(lead.data[settings.smsConsentField])) return { action: "skip", reason: `No SMS consent (“${settings.smsConsentField}” isn't a clear yes)` };
    } else if (step.to === "lead") {
      const email = normalizeEmail(lead.data[settings.emailField]);
      if (!email) return { action: "skip", reason: `No valid email address in “${settings.emailField}”` };
      address = email;
    } else {
      address = step.to; // your own team: not a lead, so no opt-out, footer or per-contact cap
    }

    if (toLead && (await this.isOptedOut(tenantId, channel, address))) return { action: "skip", reason: channel === "sms" ? "Lead opted out of SMS" : "Lead unsubscribed from email" };

    if (step.type === "send_sms") {
      const wait = quietHoursDelayMs(now, settings);
      if (wait > 0) return { action: "defer", delayMs: wait, reason: "Quiet hours — held until they end" };
    }

    const sentToday = await this.prisma.client.workflowStepLog.count({ where: { tenantId, status: "sent", createdAt: { gt: new Date(now.getTime() - 24 * HOUR) } } });
    if (sentToday >= Number(process.env.WORKFLOW_DAILY_SEND_CAP ?? DEFAULT_DAILY_SEND_CAP)) return { action: "defer", delayMs: HOUR, reason: "Daily sending limit reached — held" };
    if (toLead) {
      const toContact = await this.prisma.client.workflowStepLog.count({ where: { tenantId, status: "sent", toHash: contactHash(channel, address), createdAt: { gt: new Date(now.getTime() - 24 * HOUR) } } });
      if (toContact >= MAX_MESSAGES_PER_CONTACT_PER_DAY) return { action: "skip", reason: `Already sent ${MAX_MESSAGES_PER_CONTACT_PER_DAY} messages to this contact today` };
    }

    const render = (t: string) => renderTemplate(t, data);
    if (step.type === "send_sms") {
      return { action: "send", channel, to: address, body: withSmsOptOutNotice(render(step.body)), toLead, missingVariables: missingVariables(step.body, data) };
    }
    const body = render(step.body);
    const unsubscribe = toLead ? unsubscribeUrl(tenantId, address) : null;
    return {
      action: "send",
      channel,
      to: address,
      subject: render(step.subject),
      body: unsubscribe ? body + emailFooter(settings.businessName ?? params.businessName, unsubscribe) : body,
      headers: unsubscribe ? { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
      toLead,
      missingVariables: [...new Set([...missingVariables(step.subject, data), ...missingVariables(step.body, data)])],
    };
  }

  private async loadLead(run: { sourceType: string; sourceId: string; tenantId: string }): Promise<Lead | null> {
    if (run.sourceType === "conversation") {
      const c = await this.prisma.client.conversation.findFirst({ where: { id: run.sourceId, tenantId: run.tenantId }, select: { capturedData: true, outcomeType: true } });
      return c ? { data: sanitizeCapturedData((c.capturedData as Record<string, unknown>) ?? {}), outcome: c.outcomeType } : null;
    }
    const s = await this.prisma.client.formSubmission.findFirst({ where: { id: run.sourceId, tenantId: run.tenantId }, select: { data: true } });
    return s ? { data: sanitizeCapturedData((s.data as Record<string, unknown>) ?? {}), outcome: null } : null;
  }

  private async finish(runId: string, status: "completed" | "stopped" | "failed", stopReason?: string) {
    await this.prisma.client.workflowRun.updateMany({ where: { id: runId, status: "running" }, data: { status, stopReason, finishedAt: new Date(), nextRunAt: null } });
  }

  async stop(runId: string, reason: string) {
    await this.finish(runId, "stopped", reason);
  }

  private async log(run: { id: string; tenantId: string }, stepIndex: number, entry: { type: string; status: "sent" | "skipped" | "failed" | "waiting"; detail?: string; channel?: Channel; to?: string; providerId?: string }) {
    const data = {
      type: entry.type,
      status: entry.status,
      detail: entry.detail,
      channel: entry.channel,
      toMasked: entry.channel && entry.to ? maskAddress(entry.channel, entry.to) : undefined,
      toHash: entry.channel && entry.to ? contactHash(entry.channel, entry.to) : undefined,
      providerId: entry.providerId,
    };
    await this.prisma.client.workflowStepLog.upsert({
      where: { runId_stepIndex: { runId: run.id, stepIndex } },
      create: { runId: run.id, tenantId: run.tenantId, stepIndex, ...data },
      update: data,
    });
  }

  /**
   * Runs the lead forward until something has to wait (a delay, quiet hours, a cap, a locked workspace) or the
   * workflow ends. `finalAttempt` is true on the queue's last retry: a send that still fails transiently is then
   * recorded as failed and the workflow moves on, instead of being retried forever.
   */
  async advance(runId: string, opts: { finalAttempt?: boolean } = {}): Promise<Advance> {
    for (let guard = 0; guard < 50; guard++) {
      const run = await this.prisma.client.workflowRun.findUnique({ where: { id: runId }, include: { workflow: true } });
      if (!run || run.status !== "running") return { done: true };

      const parsed = WorkflowStep.array().safeParse(run.workflow.steps);
      const settings = WorkflowSettings.safeParse(run.workflow.settings ?? {});
      if (!parsed.success || !settings.success) {
        await this.finish(runId, "failed", "invalid_workflow");
        return { done: true };
      }
      const steps = parsed.data;

      if (run.workflow.status !== "live") {
        await this.finish(runId, "stopped", "workflow_paused");
        return { done: true };
      }
      if (run.nextStep >= steps.length) {
        await this.finish(runId, "completed");
        return { done: true };
      }

      const tenant = await this.prisma.client.tenant.findUnique({ where: { id: run.tenantId }, select: { name: true, subscriptionStatus: true } });
      if (!tenant) return { done: true };
      // A locked (unpaid or paused) workspace sends nothing on its own behalf; the lead waits, nothing is lost.
      if (tenant.subscriptionStatus === "locked") return this.hold(run.id, HOUR);

      const lead = await this.loadLead(run);
      if (!lead) {
        await this.finish(runId, "failed", "lead_deleted");
        return { done: true };
      }

      const index = run.nextStep;
      const step = steps[index]!;
      const next = () => this.prisma.client.workflowRun.update({ where: { id: runId }, data: { nextStep: index + 1, nextRunAt: null } });

      // A conditional step is checked against the lead as they are NOW, when the step is reached.
      if (!stepApplies(step, lead.data, lead.outcome)) {
        await this.log(run, index, { type: step.type, status: "skipped", detail: `Condition not met: ${describeConditions(step.when!)}` });
        await next();
        continue;
      }
      if (step.type === "exit") {
        await this.log(run, index, { type: "exit", status: "skipped", detail: `Ended here: ${describeConditions(step.when!)}` });
        await next();
        await this.finish(runId, "completed", "ended_early");
        return { done: true };
      }

      if (step.type === "wait") {
        const ms = delayMs(step);
        await this.log(run, index, { type: "wait", status: "waiting", detail: `Waiting ${step.amount} ${step.unit}` });
        await this.prisma.client.workflowRun.update({ where: { id: runId }, data: { nextStep: index + 1, nextRunAt: new Date(Date.now() + ms) } });
        return { wakeInMs: ms };
      }

      const already = await this.prisma.client.workflowStepLog.findUnique({ where: { runId_stepIndex: { runId, stepIndex: index } } });
      if (already?.status === "sent") {
        await next(); // a retried job after a send that was recorded: never send twice
        continue;
      }

      const decision = await this.decide({ tenantId: run.tenantId, businessName: tenant.name, settings: settings.data, step, lead, now: new Date() });
      const channel: Channel = step.type === "send_sms" ? "sms" : "email";

      if (decision.action === "defer") return this.hold(run.id, decision.delayMs);
      if (decision.action === "skip") {
        await this.log(run, index, { type: step.type, status: "skipped", detail: decision.reason, channel });
        await next();
        continue;
      }

      const outcome =
        decision.channel === "sms"
          ? await this.sms.send({ to: decision.to, body: decision.body })
          : await this.email.send({ to: decision.to, subject: decision.subject!, text: decision.body, headers: decision.headers, idempotencyKey: `${runId}:${index}` });

      if (outcome.ok) {
        await this.log(run, index, { type: step.type, status: "sent", channel, to: decision.to, providerId: outcome.id });
      } else if (outcome.optedOut) {
        await this.optOut(run.tenantId, decision.channel, decision.to, "stop");
        await this.log(run, index, { type: step.type, status: "skipped", detail: "Recipient has opted out", channel, to: decision.to });
      } else if (outcome.permanent || opts.finalAttempt) {
        await this.log(run, index, { type: step.type, status: "failed", detail: outcome.error ?? "Send failed", channel, to: decision.to });
      } else {
        // Might clear up (outage, rate limit): let the queue retry this same step.
        throw new Error(outcome.error ?? "Send failed");
      }
      await next();
    }
    return this.hold(runId, HOUR); // 50 steps in one pass can't happen (max 12); fail safe rather than spin
  }

  private async hold(runId: string, ms: number): Promise<Advance> {
    await this.prisma.client.workflowRun.update({ where: { id: runId }, data: { nextRunAt: new Date(Date.now() + ms) } });
    return { wakeInMs: ms };
  }
}
