import { describe, expect, it } from "vitest";
import {
  parseAnthropicResponse,
  toAnthropicShape,
  parseGeminiToolResponse,
  parseOpenAiToolResponse,
  toGeminiToolShape,
  toOpenAiMessages,
} from "./tool-wire.js";
import type { LlmMessage } from "./types.js";

const history: LlmMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "my email is a@b.co" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "capture_field", arguments: { key: "email", value: "a@b.co" } }] },
  { role: "tool", content: '{"ok":true}', toolCallId: "c1", toolName: "capture_field" },
];

describe("OpenAI-compatible wire", () => {
  it("maps assistant tool calls and tool results", () => {
    const out = toOpenAiMessages(history);
    expect(out[2]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "capture_field" } }],
    });
    expect(JSON.parse((out[2] as any).tool_calls[0].function.arguments)).toEqual({ key: "email", value: "a@b.co" });
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"ok":true}' });
  });

  it("parses tool calls and tolerates malformed argument JSON", () => {
    const parsed = parseOpenAiToolResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "x", function: { name: "capture_field", arguments: '{"key":"a","value":1}' } },
              { function: { name: "update_goal", arguments: "{not json" } },
              { function: {} },
            ],
          },
        },
      ],
    });
    expect(parsed.text).toBe("");
    expect(parsed.toolCalls).toEqual([
      { id: "x", name: "capture_field", arguments: { key: "a", value: 1 } },
      { id: "call_1", name: "update_goal", arguments: {} },
    ]);
  });
});

describe("Gemini wire", () => {
  it("folds system text out and pairs function calls with responses", () => {
    const { systemText, contents } = toGeminiToolShape(history);
    expect(systemText).toBe("sys");
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[1]!.parts[0]).toEqual({ functionCall: { name: "capture_field", args: { key: "email", value: "a@b.co" } } });
    expect(contents[2]!.parts[0]).toEqual({ functionResponse: { name: "capture_field", response: { result: { ok: true } } } });
  });

  it("groups consecutive tool results into one user turn", () => {
    const { contents } = toGeminiToolShape([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [
        { id: "a", name: "t1", arguments: {} },
        { id: "b", name: "t2", arguments: {} },
      ] },
      { role: "tool", content: "1", toolCallId: "a", toolName: "t1" },
      { role: "tool", content: "2", toolCallId: "b", toolName: "t2" },
    ]);
    expect(contents).toHaveLength(3);
    expect(contents[2]!.parts).toHaveLength(2);
  });

  it("parses text and function calls with synthesised ids", () => {
    const parsed = parseGeminiToolResponse({
      candidates: [{ content: { parts: [{ text: "ok " }, { functionCall: { name: "end_conversation", args: { outcomeType: "order" } } }] } }],
    });
    expect(parsed.text).toBe("ok ");
    expect(parsed.toolCalls).toEqual([{ id: "call_0", name: "end_conversation", arguments: { outcomeType: "order" } }]);
  });
});

describe("Anthropic wire", () => {
  it("splits system text and maps tool calls to tool_use blocks and results to tool_result blocks", () => {
    const { system, messages } = toAnthropicShape(history);
    expect(system).toBe("sys");
    expect(messages[0]).toEqual({ role: "user", content: "my email is a@b.co" });
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "capture_field", input: { key: "email", value: "a@b.co" } }],
    });
    expect(messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: '{"ok":true}' }] });
  });

  it("keeps assistant text alongside tool calls and groups parallel results in one user message", () => {
    const { messages } = toAnthropicShape([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Checking.", toolCalls: [{ id: "a", name: "t1", arguments: {} }, { id: "b", name: "t2", arguments: {} }] },
      { role: "tool", content: "1", toolCallId: "a", toolName: "t1" },
      { role: "tool", content: "2", toolCallId: "b", toolName: "t2" },
    ]);
    expect((messages[1]!.content as unknown[])[0]).toEqual({ type: "text", text: "Checking." });
    expect(messages).toHaveLength(3);
    expect(messages[2]!.content as unknown[]).toHaveLength(2);
  });

  it("never emits an empty text block", () => {
    const { messages } = toAnthropicShape([{ role: "assistant", content: "", toolCalls: [{ id: "a", name: "t", arguments: {} }] }]);
    expect(JSON.stringify(messages)).not.toContain('"text":""');
  });

  it("parses text, tool_use and usage", () => {
    expect(
      parseAnthropicResponse({
        content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "x", name: "end_conversation", input: { outcomeType: "order" } }],
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
    ).toEqual({
      text: "ok",
      toolCalls: [{ id: "x", name: "end_conversation", arguments: { outcomeType: "order" } }],
      usage: { inputTokens: 10, outputTokens: 4 },
    });
  });
});
