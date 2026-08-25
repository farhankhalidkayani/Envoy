import { Injectable } from "@nestjs/common";
import type { HardRuleDef, RequiredFieldDef } from "@envoy/types";
import {
  COMPLETE_MARKER_PREFIX,
  COMPLETE_MARKER_SUFFIX,
  extractRequiredFields,
  RETRY_NOTICE_MARKER,
} from "./prompt-markers.js";
import type { JudgeVerdict, LlmCompleteRequest, LlmCompleteResult, LlmProvider } from "./types.js";

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
