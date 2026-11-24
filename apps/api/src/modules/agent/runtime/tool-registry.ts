import { Injectable } from "@nestjs/common";
import { OPT_IN_TOOL_NAMES, type AgentSpec } from "@envoy/types";
import { BUILT_IN_TOOLS } from "./built-in-tools.js";
import type { RunState } from "./run-state.js";
import type { AgentTool, ToolConfig, ToolContext, ToolOutcome, ToolServices } from "./tool.js";
import type { LlmToolCall, LlmToolDef } from "../providers/llm/types.js";

export interface ExecutedTool {
  outcome: ToolOutcome;
  latencyMs: number;
}

/**
 * Decides which tools an agent may use and runs them under the harness's
 * rules: permission, per-conversation cap, schema validation, timeout, and
 * "a throwing tool never breaks the conversation".
 */
@Injectable()
export class ToolRegistry {
  /** Tools offered for this agent: available for its config, and not disabled in its spec. */
  resolve(spec: AgentSpec, config: Omit<ToolConfig, "offeredTools">): AgentTool[] {
    // Regular tools are on unless switched off; opt-in tools (CRM, calendar) are off unless switched on.
    const optedIn = new Set(spec.tools.filter((t) => t.enabled).map((t) => t.name));
    const disabled = new Set<string>([
      ...spec.tools.filter((t) => !t.enabled).map((t) => t.name),
      ...OPT_IN_TOOL_NAMES.filter((n) => !optedIn.has(n)),
    ]);
    // Availability of one tool can depend on others (end_conversation checks goals only when update_goal is offered),
    // so resolve in one pass against the name set of everything that survives permission filtering.
    const permitted = BUILT_IN_TOOLS.filter((t) => !disabled.has(t.name));
    const offeredTools = new Set(permitted.map((t) => t.name as string));
    const probe: ToolConfig = { ...config, offeredTools };
    const offered = permitted.filter((t) => t.isAvailable(probe));
    return offered;
  }

  toolConfig(tools: AgentTool[], config: Omit<ToolConfig, "offeredTools">): ToolConfig {
    return { ...config, offeredTools: new Set(tools.map((t) => t.name as string)) };
  }

  definitions(tools: AgentTool[]): LlmToolDef[] {
    return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  async execute(params: {
    tools: AgentTool[];
    call: LlmToolCall;
    spec: AgentSpec;
    toolConfig: ToolConfig;
    state: RunState;
    services: ToolServices;
    timeoutMs: number;
  }): Promise<ExecutedTool> {
    const started = Date.now();
    const finish = (outcome: ToolOutcome): ExecutedTool => ({ outcome, latencyMs: Date.now() - started });

    const tool = params.tools.find((t) => t.name === params.call.name);
    if (!tool) return finish({ ok: false, error: `Tool "${params.call.name}" is not available.` });

    const cap = params.spec.tools.find((t) => t.name === tool.name)?.maxCallsPerConversation ?? tool.defaultMaxCallsPerConversation;
    if (cap !== undefined && (params.state.toolCallCounts[tool.name] ?? 0) >= cap) {
      return finish({ ok: false, error: `Tool "${tool.name}" has reached its limit for this conversation.` });
    }

    const parsed = tool.input.safeParse(params.call.arguments);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
      return finish({ ok: false, error: `Invalid arguments: ${issues}` });
    }

    params.state.toolCallCounts[tool.name] = (params.state.toolCallCounts[tool.name] ?? 0) + 1;
    params.state.toolCallsThisTurn += 1;

    const ctx: ToolContext = { config: params.toolConfig, state: params.state, services: params.services };
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race<ToolOutcome>([
        tool.execute(parsed.data, ctx),
        new Promise<ToolOutcome>((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, error: `Tool "${tool.name}" timed out.` }), params.timeoutMs);
        }),
      ]);
      return finish(outcome);
    } catch {
      // Never leak internals to the model (or through it to the visitor).
      return finish({ ok: false, error: `Tool "${tool.name}" failed.` });
    } finally {
      clearTimeout(timer);
    }
  }
}
