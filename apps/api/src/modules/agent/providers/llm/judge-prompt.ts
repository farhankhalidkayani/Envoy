import type { HardRuleDef } from "@envoy/types";
import type { JudgeVerdict, LlmMessage } from "./types.js";

/** Shared classifier-prompt shape for the real (non-mock) providers' judge() call. */
export function buildJudgeMessages(candidateText: string, hardRules: HardRuleDef[]): LlmMessage[] {
  const rulesList = hardRules.map((r) => `- id="${r.id}": ${r.text}`).join("\n");
  return [
    {
      role: "system",
      content: [
        "You are a strict compliance classifier. You will be given a list of hard rules and a",
        "candidate reply from a customer-support agent. Decide whether the candidate reply",
        "violates any rule. Respond with ONLY a JSON object, no other text, matching exactly:",
        '{"violated": boolean, "ruleId": string | null, "reason": string | null}',
        "",
        "Rules:",
        rulesList,
      ].join("\n"),
    },
    { role: "user", content: `Candidate reply:\n${candidateText}` },
  ];
}

export function parseJudgeResponse(raw: string): JudgeVerdict {
  try {
    // Models sometimes wrap JSON in prose or code fences despite instructions — grab the
    // first {...} block rather than requiring the whole response to be valid JSON.
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as {
      violated?: boolean;
      ruleId?: string | null;
      reason?: string | null;
    };
    return {
      violated: Boolean(parsed.violated),
      ruleId: parsed.ruleId ?? undefined,
      reason: parsed.reason ?? undefined,
    };
  } catch {
    // Fail closed on unparseable output would block every reply; fail open
    // instead and let the mismatch surface in logs — a malformed judge
    // response is a provider/prompt bug to fix, not grounds to silently
    // suppress every agent reply.
    return { violated: false, reason: "judge response was not valid JSON" };
  }
}
