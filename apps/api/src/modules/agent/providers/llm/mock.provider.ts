import { Injectable } from "@nestjs/common";
import type { HardRuleDef, RequiredFieldDef } from "@envoy/types";
import {
  COMPLETE_MARKER_PREFIX,
  COMPLETE_MARKER_SUFFIX,
  extractCapturedData,
  extractGoalProgress,
  extractGoals,
  extractRequiredFields,
  RETRY_NOTICE_MARKER,
} from "./prompt-markers.js";
import type {
  JudgeVerdict,
  LlmCompleteRequest,
  LlmCompleteResult,
  LlmMessage,
  LlmProvider,
  LlmToolCall,
  LlmToolRequest,
  LlmToolResult,
} from "./types.js";

/**
 * Deterministic, zero-dependency provider used by default (LLM_PROVIDER=mock,
 * which is the fallback when no provider is configured). It exists so the
 * whole engine — field collection, rule enforcement, completion detection,
 * summarization — is verifiable end-to-end without a live API key. It reads
 * the machine-parseable blocks the prompt builder embeds (see
 * prompt-markers.ts) rather than "understanding" anything.
 */
@Injectable()
export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
    switch (req.purpose) {
      case "extract":
        return { text: this.extract(req) };
      case "summarize":
        return { text: this.summarize(req) };
      case "chat":
      default:
        return { text: this.chat(req) };
    }
  }

  async judge(candidateText: string, hardRules: HardRuleDef[]): Promise<JudgeVerdict> {
    const haystack = candidateText.toLowerCase();
    for (const rule of hardRules) {
      const significantWords = rule.text
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 4);
      const matched = significantWords.filter((w) => haystack.includes(w));
      if (matched.length >= 2) {
        return { violated: true, ruleId: rule.id, reason: `matched keywords: ${matched.join(", ")}` };
      }
    }
    return { violated: false };
  }

  /**
   * Scripted tool-using agent for the agentic runtime — deterministic, so the
   * loop, tool registry, goals and enforcement are testable without a key.
   * Behaviour, in order, on each model call:
   *   - visitor asks for a human ("human" in the message)  → handoff_to_human
   *   - visitor mentions "refund"                          → a policy-violating reply (exercises the judge)
   *   - visitor message holds values for uncaptured fields → capture_field per value
   *   - after tool results: say the closing line if the conversation just ended
   *   - required fields still missing                      → ask for the next one
   *   - all captured, goals open                           → update_goal(achieved) per goal
   *   - all captured, goals resolved                       → end_conversation
   */
  async completeWithTools(req: LlmToolRequest): Promise<LlmToolResult> {
    const systemText = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const fields = extractRequiredFields(systemText) ?? [];
    const captured = extractCapturedData(systemText) ?? {};
    const goals = extractGoals(systemText) ?? [];
    const progress = extractGoalProgress(systemText) ?? {};
    const offered = new Set(req.tools.map((t) => t.name));
    const last = req.messages[req.messages.length - 1];
    const reply = (text: string): LlmToolResult => ({ text, toolCalls: [] });
    const call = (name: string, args: Record<string, unknown>, i = 0): LlmToolCall => ({
      id: `mock_${name}_${req.messages.length}_${i}`,
      name,
      arguments: args,
    });

    if (systemText.includes(RETRY_NOTICE_MARKER)) {
      return reply("I can't make specific promises about outcomes, but I'm happy to help however I can.");
    }

    if (last?.role === "tool") {
      const results = this.trailingToolResults(req.messages);
      if (results.some((r) => r.name === "handoff_to_human" && r.ok)) {
        return reply("I'm connecting you with a colleague who will be in touch shortly.");
      }
      if (results.some((r) => r.name === "end_conversation" && r.ok)) {
        return reply("Thanks, I have everything I need!");
      }
      const lookup = results.find((r) => r.name === "lookup_crm_contact");
      if (lookup) return reply(lookup.ok && lookup.data?.found ? "Welcome back — good to see you again!" : "Nice to meet you!");
      const availability = results.find((r) => r.name === "check_calendar_availability");
      if (availability) return reply(availability.ok ? "I've checked the calendar — mornings around 10:00 UTC are taken, the rest is open." : "I couldn't check the calendar just now.");
      const booking = results.find((r) => r.name === "book_meeting");
      if (booking) return reply(booking.ok ? "You're booked in — see you then!" : "That time isn't available — could you suggest another?");
      return this.nextStep(fields, captured, goals, progress, offered, req.messages, call);
    }

    const lastUser = last?.role === "user" ? last.content : "";
    const capturedEmail = fields.filter((f) => f.type === "email").map((f) => captured[f.key]).find((v) => typeof v === "string") as string | undefined;
    if (offered.has("lookup_crm_contact") && capturedEmail && /do you know me|existing customer/i.test(lastUser)) {
      return { text: "", toolCalls: [call("lookup_crm_contact", { email: capturedEmail })] };
    }
    if (offered.has("check_calendar_availability") && /\bavailab/i.test(lastUser)) {
      const from = new Date(Date.now() + 86_400_000);
      from.setUTCHours(0, 0, 0, 0);
      return { text: "", toolCalls: [call("check_calendar_availability", { from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString() })] };
    }
    const bookAt = /\bbook\b.*?(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(lastUser)?.[1];
    if (offered.has("book_meeting") && bookAt) {
      return { text: "", toolCalls: [call("book_meeting", { startTime: bookAt, ...(capturedEmail ? { attendeeEmail: capturedEmail } : {}) })] };
    }
    if (offered.has("handoff_to_human") && /\bhuman\b/i.test(lastUser)) {
      return { text: "", toolCalls: [call("handoff_to_human", { reason: "Visitor asked for a human." })] };
    }
    if (lastUser.toLowerCase().includes("refund")) {
      return reply("Yes, we can offer you guaranteed refunds right away!");
    }

    if (offered.has("capture_field")) {
      // A free-text field matches anything, so only take it as an answer to the question just asked
      // (the first missing required field, after the agent has spoken) — never from an opening "Hi".
      const spoke = req.messages.some((m) => m.role === "assistant" && m.content);
      const firstMissing = fields.find((f) => f.required && !(f.key in captured));
      const found = fields
        .filter((f) => !(f.key in captured))
        .filter((f) => f.type !== "text" || (spoke && f.key === firstMissing?.key))
        .map((f) => ({ f, value: this.extractOne(f, lastUser) }))
        .filter((x) => x.value !== undefined);
      if (found.length > 0) {
        return {
          text: "",
          toolCalls: found.map((x, i) => call("capture_field", { key: x.f.key, value: String(x.value) }, i)),
        };
      }
    }
    return this.nextStep(fields, captured, goals, progress, offered, req.messages, call);
  }

  private nextStep(
    fields: RequiredFieldDef[],
    captured: Record<string, unknown>,
    goals: Array<{ id: string }>,
    progress: Record<string, { status: string }>,
    offered: Set<string>,
    messages: LlmMessage[],
    call: (name: string, args: Record<string, unknown>, i?: number) => LlmToolCall,
  ): LlmToolResult {
    const missing = fields.filter((f) => f.required && !(f.key in captured));
    if (missing.length > 0) {
      const first = messages.every((m) => m.role !== "assistant" || !m.content);
      const greeting = first ? "Hi! I'd be happy to help. " : "";
      return { text: `${greeting}Could you share your ${missing[0]!.label.toLowerCase()}?`, toolCalls: [] };
    }
    const open = goals.filter((g) => !["achieved", "failed"].includes(progress[g.id]?.status ?? "pending"));
    if (offered.has("update_goal") && open.length > 0) {
      return {
        text: "",
        toolCalls: open.map((g, i) => call("update_goal", { goalId: g.id, status: "achieved", note: "All details collected." }, i)),
      };
    }
    if (offered.has("end_conversation")) {
      return { text: "", toolCalls: [call("end_conversation", { outcomeType: "demo_booking" })] };
    }
    return { text: "Thanks, I have everything I need!", toolCalls: [] };
  }

  /** The tool results at the end of the message list, parsed — what the model "just saw". */
  private trailingToolResults(messages: LlmMessage[]): Array<{ name: string; ok: boolean; data?: Record<string, unknown> }> {
    const out: Array<{ name: string; ok: boolean; data?: Record<string, unknown> }> = [];
    for (let i = messages.length - 1; i >= 0 && messages[i]!.role === "tool"; i--) {
      let parsed: { ok?: boolean; data?: Record<string, unknown> } = {};
      try {
        parsed = JSON.parse(messages[i]!.content) as typeof parsed;
      } catch {
        parsed = {};
      }
      out.push({ name: messages[i]!.toolName ?? "", ok: parsed.ok === true, data: parsed.data });
    }
    return out;
  }

  // ── chat: a scripted field-collection FSM ─────────────────────

  private chat(req: LlmCompleteRequest): string {
    const systemText = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const fields = extractRequiredFields(systemText) ?? [];
    const isRetry = systemText.includes(RETRY_NOTICE_MARKER);
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

    if (isRetry) {
      return "I can't make specific promises about outcomes, but I'm happy to help however I can.";
    }

    // Deliberately policy-violating canned reply, used to exercise the
    // rule-judge/block/retry path in tests — see agent-engine.e2e.test.ts.
    if (lastUser.toLowerCase().includes("refund")) {
      return "Yes, we can offer you guaranteed refunds right away!";
    }

    const askedCount = req.messages.filter((m) => m.role === "assistant").length;
    if (askedCount < fields.length) {
      const field: RequiredFieldDef = fields[askedCount]!;
      const greeting = askedCount === 0 ? "Hi! I'd be happy to help. " : "";
      return `${greeting}Could you share your ${field.label.toLowerCase()}?`;
    }

    return `Thanks, I have everything I need! ${COMPLETE_MARKER_PREFIX} outcomeType="demo_booking"${COMPLETE_MARKER_SUFFIX}`;
  }

  // ── extract: regex-based per-field-type extraction ────────────

  private extract(req: LlmCompleteRequest): string {
    const systemText = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const fields = extractRequiredFields(systemText) ?? [];
    const userText = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const value = this.extractOne(field, userText);
      if (value !== undefined) result[field.key] = value;
    }
    return JSON.stringify(result);
  }

  private extractOne(field: RequiredFieldDef, text: string): unknown {
    switch (field.type) {
      case "email": {
        const match = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
        return match?.[0];
      }
      case "phone": {
        const match = text.match(/\+?\d[\d\-\s()]{6,}\d/);
        return match?.[0];
      }
      case "number": {
        const match = text.match(/-?\d+(\.\d+)?/);
        return match ? Number(match[0]) : undefined;
      }
      case "date": {
        const match = text.match(/\d{4}-\d{2}-\d{2}/);
        return match?.[0];
      }
      case "select": {
        const lower = text.toLowerCase();
        return field.options?.find((opt) => lower.includes(opt.toLowerCase()));
      }
      case "boolean": {
        if (/\b(yes|true)\b/i.test(text)) return true;
        if (/\b(no|false)\b/i.test(text)) return false;
        return undefined;
      }
      case "text": {
        const trimmed = text.trim();
        return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : undefined;
      }
    }
  }

  // ── summarize: templated, deterministic ────────────────────────

  private summarize(req: LlmCompleteRequest): string {
    const transcript = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const truncated = transcript.length > 200 ? `${transcript.slice(0, 200)}...` : transcript;
    return `Summary: ${truncated}`;
  }
}
