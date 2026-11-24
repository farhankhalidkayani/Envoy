import type { LlmMessage, LlmToolCall, LlmToolDef, LlmToolResult } from "./types.js";

/**
 * Wire-format translation for tool calling, kept out of the provider classes
 * so it's unit-testable without network. Two shapes: OpenAI-compatible
 * (Groq) and Gemini's generateContent.
 */

// ── OpenAI-compatible (Groq) ────────────────────────────────────

export function toOpenAiMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function toOpenAiTools(tools: LlmToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

export function parseOpenAiToolResponse(data: OpenAiResponse): LlmToolResult {
  const message = data.choices?.[0]?.message;
  const toolCalls: LlmToolCall[] = [];
  for (const [i, call] of (message?.tool_calls ?? []).entries()) {
    if (!call.function?.name) continue;
    toolCalls.push({
      id: call.id ?? `call_${i}`,
      name: call.function.name,
      arguments: parseArguments(call.function.arguments),
    });
  }
  return { text: message?.content ?? "", toolCalls };
}

/** Models occasionally emit malformed argument JSON; surface it as empty args so schema validation rejects it with a clear error rather than the loop crashing. */
function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ── Gemini ──────────────────────────────────────────────────────

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface GeminiToolContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export function toGeminiToolShape(messages: LlmMessage[]): {
  systemText: string;
  contents: GeminiToolContent[];
} {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const contents: GeminiToolContent[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const part: GeminiPart = {
        functionResponse: { name: m.toolName ?? "tool", response: { result: tryJson(m.content) } },
      };
      // Consecutive tool results must share one user turn, one part per call.
      const last = contents[contents.length - 1];
      if (last?.role === "user" && last.parts.every((p) => "functionResponse" in p)) {
        last.parts.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
      continue;
    }
    if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.arguments } });
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }
    contents.push({ role: "user", parts: [{ text: m.content }] });
  }
  return { systemText, contents };
}

export function toGeminiTools(tools: LlmToolDef[]): Array<Record<string, unknown>> {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> };
  }>;
}

export function parseGeminiToolResponse(data: GeminiResponse): LlmToolResult {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const toolCalls: LlmToolCall[] = [];
  let text = "";
  for (const part of parts) {
    if (part.text) text += part.text;
    if (part.functionCall?.name) {
      // Gemini calls carry no id; synthesise a stable one so results can be paired.
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? {},
      });
    }
  }
  return { text, toolCalls };
}

function tryJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

// ── Anthropic Messages API ──────────────────────────────────────

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

export function toAnthropicShape(messages: LlmMessage[]): { system: string; messages: AnthropicMessage[] } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block: AnthropicBlock = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content };
      // All results answering one assistant turn go in a single user message.
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
      if (blocks.length > 0) out.push({ role: "assistant", content: m.toolCalls?.length ? blocks : m.content });
      continue;
    }
    out.push({ role: "user", content: m.content });
  }
  return { system, messages: out };
}

export function toAnthropicTools(tools: LlmToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function parseAnthropicResponse(data: AnthropicResponse): LlmToolResult {
  let text = "";
  const toolCalls: LlmToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text" && block.text) text += block.text;
    if (block.type === "tool_use" && block.name) {
      toolCalls.push({ id: block.id ?? `call_${toolCalls.length}`, name: block.name, arguments: block.input ?? {} });
    }
  }
  return {
    text,
    toolCalls,
    usage: data.usage ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 } : undefined,
  };
}
