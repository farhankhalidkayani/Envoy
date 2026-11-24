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
