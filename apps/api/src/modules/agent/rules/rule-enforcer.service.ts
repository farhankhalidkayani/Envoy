import { Inject, Injectable } from "@nestjs/common";
import type { HardRulesSpec, RuleViolation } from "@envoy/types";
import { buildRetryNoticeMessage } from "../prompt/system-prompt.builder.js";
import { LLM_PROVIDER } from "../providers/llm/llm-provider.module.js";
import type { LlmMessage, LlmProvider } from "../providers/llm/types.js";

const FALLBACK_SAFE_REPLY =
  "Let me connect you with a colleague who can help further with that — thanks for your patience.";

export interface EnforcementResult {
  /** What actually gets sent to the visitor. */
  finalText: string;
  /** Every violation caught this turn, in order — appended to Conversation.ruleViolationsBlocked. */
  violations: RuleViolation[];
}

/**
 * Layer 2 of rule enforcement (layer 1 is the instructions baked into the
 * stable system prompt). Runs AFTER the candidate reply is fully generated
 * and BEFORE anything reaches the visitor — which is why the engine does not
 * stream tokens to the client (see conversation-engine.service.ts): there is
 * no way to "un-send" a token that already violated a hard rule.
 *
 * - action "block": one regeneration attempt with the violation named in a
 *   trailing system message. If the retry also violates, a generic safe
 *   fallback is delivered instead — never the offending text.
 * - action "escalate": the reply is still delivered (escalation is a flag
 *   for human review, not a block), but logged the same as a block.
 */
@Injectable()
export class RuleEnforcerService {
  constructor(@Inject(LLM_PROVIDER) private readonly llm: LlmProvider) {}

  async enforce(params: {
    candidateText: string;
    hardRules: HardRulesSpec;
    regenerate: (messages: LlmMessage[]) => Promise<string>;
    messagesForRetry: LlmMessage[];
  }): Promise<EnforcementResult> {
    const violations: RuleViolation[] = [];
    if (params.hardRules.length === 0) {
      return { finalText: params.candidateText, violations };
    }

    const firstVerdict = await this.llm.judge(params.candidateText, params.hardRules);
    if (!firstVerdict.violated) {
      return { finalText: params.candidateText, violations };
    }

    const rule = params.hardRules.find((r) => r.id === firstVerdict.ruleId);
    violations.push({
      ruleId: firstVerdict.ruleId ?? "unknown",
      action: rule?.action ?? "block",
      candidateText: params.candidateText,
      timestamp: new Date().toISOString(),
    });

    if (!rule || rule.action === "escalate") {
      // Escalation flags for review but doesn't suppress the reply.
      return { finalText: params.candidateText, violations };
    }

    // action === "block": one regeneration attempt with explicit feedback.
    const retryText = await params.regenerate([
      ...params.messagesForRetry,
      buildRetryNoticeMessage(rule.text),
    ]);
    const retryVerdict = await this.llm.judge(retryText, params.hardRules);
    if (!retryVerdict.violated) {
      return { finalText: retryText, violations };
    }

    violations.push({
      ruleId: retryVerdict.ruleId ?? rule.id,
      action: "block",
      candidateText: retryText,
      timestamp: new Date().toISOString(),
    });
    return { finalText: FALLBACK_SAFE_REPLY, violations };
  }
}
