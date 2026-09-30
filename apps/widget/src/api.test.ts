import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetConfig } from "@envoy/types";
import { AgentConnection, type PublicAgent } from "./api.js";

/** Deterministic stand-in for the browser's WebSocket — no real socket, full control over event timing. */
class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.emit("close", {});
  }

  // Test helpers, not part of the real WebSocket API:
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  message(data: unknown) {
    this.emit("message", { data: JSON.stringify(data) });
  }

  private emit(type: string, event: unknown) {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
}

const agent: PublicAgent = {
  id: "agent1",
  publicToken: "tok123",
  widgetConfig: WidgetConfig.parse({}),
  locked: false,
  voiceEnabled: false,
  leadFormToken: null,
};

describe("AgentConnection", () => {
  let sockets: MockWebSocket[];

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    sockets = MockWebSocket.instances;
  });

  afterEach(() => vi.unstubAllGlobals());

  it("sends session.start with the agent's id and publicToken once the socket opens", () => {
    new AgentConnection(agent, { onMessage: vi.fn(), onClose: vi.fn() });
    const ws = sockets[0]!;
    expect(ws.sent).toEqual([]); // nothing before open
    ws.open();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "session.start", agentId: "agent1", publicToken: "tok123" });
  });

  it("parses a valid server message and forwards it to onMessage", () => {
    const onMessage = vi.fn();
    new AgentConnection(agent, { onMessage, onClose: vi.fn() });
    const ws = sockets[0]!;
    ws.open();
    ws.message({ type: "agent.message", text: "hi there", done: true });
    expect(onMessage).toHaveBeenCalledWith({ type: "agent.message", text: "hi there", done: true });
  });

  it("silently drops a message that doesn't match the protocol instead of throwing", () => {
    const onMessage = vi.fn();
    new AgentConnection(agent, { onMessage, onClose: vi.fn() });
    const ws = sockets[0]!;
    ws.open();
    expect(() => ws.message({ type: "not.a.real.type" })).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("calls onClose when the socket closes", () => {
    const onClose = vi.fn();
    new AgentConnection(agent, { onMessage: vi.fn(), onClose });
    sockets[0]!.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sendMessage only writes to the socket once it's open — a message sent while still connecting is dropped, not queued", () => {
    const conn = new AgentConnection(agent, { onMessage: vi.fn(), onClose: vi.fn() });
    const ws = sockets[0]!;
    conn.sendMessage("too early");
    expect(ws.sent).toEqual([]);

    ws.open();
    ws.sent = []; // clear the session.start the open triggered
    conn.sendMessage("hello");
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "user.message", text: "hello" });
  });

  it("sendAudio sends the correct shape once open", () => {
    const conn = new AgentConnection(agent, { onMessage: vi.fn(), onClose: vi.fn() });
    const ws = sockets[0]!;
    ws.open();
    ws.sent = [];
    conn.sendAudio("base64data", "audio/webm");
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "user.audio", chunk: "base64data", mimeType: "audio/webm" });
  });

  it("close() closes the underlying socket", () => {
    const conn = new AgentConnection(agent, { onMessage: vi.fn(), onClose: vi.fn() });
    const ws = sockets[0]!;
    ws.open();
    conn.close();
    expect(ws.readyState).toBe(3);
  });
});
