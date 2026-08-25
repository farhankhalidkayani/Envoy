import { ServerMessage, type ClientMessage } from "@envoy/types";

const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? "http://localhost:4000";
const WS_ORIGIN = import.meta.env.VITE_WS_ORIGIN ?? "ws://localhost:4000";

export interface PublicAgent {
  id: string;
  publicToken: string;
  widgetConfig: {
    primaryColor: string;
    logoUrl?: string;
    position: "bottom-right" | "bottom-left";
    greeting: string;
    launcherLabel: string;
    themeMode: "light" | "dark" | "auto";
  };
  locked: boolean;
  voiceEnabled: boolean;
}

export async function resolveAgent(publicToken: string): Promise<PublicAgent> {
  const res = await fetch(`${API_ORIGIN}/agents/public/${publicToken}`);
  if (!res.ok) {
    throw new Error(`Agent not found (${res.status})`);
  }
  return res.json();
}

export type ConnectionHandlers = {
  onMessage: (msg: ServerMessage) => void;
  onClose: () => void;
};

/** Thin wrapper around the raw WS protocol from @envoy/types — see the build plan §Agent engine. */
export class AgentConnection {
  private ws: WebSocket;

  constructor(agent: PublicAgent, handlers: ConnectionHandlers) {
    this.ws = new WebSocket(`${WS_ORIGIN}/ws/agent/${agent.id}`);
    this.ws.addEventListener("open", () => {
      this.sendRaw({ type: "session.start", agentId: agent.id, publicToken: agent.publicToken });
    });
    this.ws.addEventListener("message", (event) => {
      const parsed = ServerMessage.safeParse(JSON.parse(event.data as string));
      if (parsed.success) handlers.onMessage(parsed.data);
    });
    this.ws.addEventListener("close", handlers.onClose);
  }

  sendMessage(text: string) {
    this.sendRaw({ type: "user.message", text });
  }

  sendAudio(base64: string, mimeType: string) {
    this.sendRaw({ type: "user.audio", chunk: base64, mimeType });
  }

  private sendRaw(msg: ClientMessage) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close() {
    this.ws.close();
  }
}
