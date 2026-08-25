import type { IncomingMessage, Server as HttpServer } from "node:http";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { WebSocket, WebSocketServer } from "ws";
import {
  ClientMessage,
  HardRulesSpec,
  RequiredFieldsSpec,
  WidgetConfig,
  type ServerMessage,
} from "@envoy/types";
import { PrismaService } from "../../core/prisma/prisma.service.js";
import type { AgentPromptConfig } from "../prompt/system-prompt.builder.js";
import { ConversationEngineService } from "../conversation/conversation-engine.service.js";
import { ConversationSessionStore } from "../conversation/conversation-session.store.js";
import { ConversationsService } from "../conversation/conversations.service.js";
import { STT_PROVIDER, TTS_PROVIDER } from "../providers/voice/voice-provider.module.js";
import type { SttProvider, TtsProvider } from "../providers/voice/types.js";

const WS_PATH_PATTERN = /^\/ws\/agent\/([^/?]+)/;

interface ConnectionState {
  conversationId?: string;
  agentConfig?: AgentPromptConfig;
}

/**
 * Raw `ws` server attached directly to the underlying HTTP server's
 * `upgrade` event, matching the build plan's `WS /ws/agent/:agentId` path
 * exactly. NestJS's `@WebSocketGateway` is built around socket.io namespaces
 * and doesn't map cleanly onto a path-parameterized raw-WS route, so this
 * bypasses that abstraction in favor of directly implementing the
 * ClientMessage/ServerMessage protocol from @envoy/types.
 */
@Injectable()
export class AgentGateway {
  private readonly logger = new Logger(AgentGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: ConversationSessionStore,
    private readonly conversations: ConversationsService,
    private readonly engine: ConversationEngineService,
    @Inject(STT_PROVIDER) private readonly stt: SttProvider,
    @Inject(TTS_PROVIDER) private readonly tts: TtsProvider,
  ) {}

  /**
   * Called explicitly from main.ts once the HTTP server exists (and from
   * tests once their in-process server exists) — deliberately NOT wired via
   * OnModuleInit/OnApplicationBootstrap + HttpAdapterHost. Both lifecycle
   * hooks fire during app.init(), before HttpAdapterHost.httpAdapter is
   * reliably populated (this throws intermittently, especially under
   * Test.createTestingModule()). Taking the server as an explicit argument
   * sidesteps that timing ambiguity entirely.
   */
  attach(httpServer: HttpServer) {
    httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
      const path = req.url?.split("?")[0] ?? "";
      const match = WS_PATH_PATTERN.exec(path);
      if (!match) {
        // Not our path — leave it for any other upgrade handler (none yet, but don't destroy blindly).
        return;
      }
      const agentIdFromPath = match[1]!;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, agentIdFromPath);
      });
    });

    this.wss.on("connection", (ws: WebSocket, agentIdFromPath: string) => {
      this.handleConnection(ws, agentIdFromPath);
    });
  }

  private handleConnection(ws: WebSocket, agentIdFromPath: string) {
    const state: ConnectionState = {};

    ws.on("message", (raw) => {
      void this.handleMessage(ws, agentIdFromPath, state, raw.toString());
    });

    ws.on("close", () => {
      if (state.conversationId) {
        void this.conversations.abandon(state.conversationId);
        void this.sessions.clear(state.conversationId);
      }
    });
  }

  private async handleMessage(
    ws: WebSocket,
    agentIdFromPath: string,
    state: ConnectionState,
    raw: string,
  ) {
    let parsed: ClientMessage;
    try {
      parsed = ClientMessage.parse(JSON.parse(raw));
    } catch {
      this.send(ws, { type: "error", message: "Malformed message" });
      return;
    }

    try {
      switch (parsed.type) {
        case "session.start":
          await this.onSessionStart(ws, agentIdFromPath, state, parsed);
          break;
        case "user.message":
          await this.onUserMessage(ws, state, parsed.text);
          break;
        case "user.audio":
          await this.onUserAudio(ws, state, parsed.chunk, parsed.mimeType);
          break;
      }
    } catch (err) {
      this.logger.error(`gateway error: ${(err as Error).message}`);
      this.send(ws, { type: "error", message: "Something went wrong. Please try again." });
    }
  }

  private async onSessionStart(
    ws: WebSocket,
    agentIdFromPath: string,
    state: ConnectionState,
    msg: Extract<ClientMessage, { type: "session.start" }>,
  ) {
    if (msg.agentId !== agentIdFromPath) {
      this.send(ws, { type: "error", message: "agentId mismatch" });
      ws.close();
      return;
    }

    const agent = await this.prisma.client.agent.findUnique({
      where: { id: agentIdFromPath },
      include: { tenant: true },
    });

    if (!agent || agent.publicToken !== msg.publicToken) {
      this.send(ws, { type: "error", message: "Invalid agent or token" });
      ws.close();
      return;
    }
    if (agent.tenant.subscriptionStatus === "locked") {
      this.send(ws, { type: "locked", message: "This chat is temporarily unavailable." });
      ws.close();
      return;
    }
    if (agent.status !== "live") {
      this.send(ws, { type: "error", message: "This agent is not currently live" });
      ws.close();
      return;
    }

    const conversation = await this.conversations.start(agent.id, agent.tenantId);
    await this.sessions.init(conversation.id);

    state.conversationId = conversation.id;
    state.agentConfig = {
      script: agent.script,
      requiredFields: RequiredFieldsSpec.parse(agent.requiredFields ?? []),
      hardRules: HardRulesSpec.parse(agent.hardRules ?? []),
    };

    this.send(ws, {
      type: "session.ready",
      widgetConfig: WidgetConfig.parse(agent.widgetConfig ?? {}),
    });
  }

  private async onUserMessage(ws: WebSocket, state: ConnectionState, text: string) {
    await this.respondToText(ws, state, text);
  }

  private async onUserAudio(ws: WebSocket, state: ConnectionState, chunk: string, mimeType: string) {
    if (!state.conversationId || !state.agentConfig) {
      this.send(ws, { type: "error", message: "Session not started" });
      return;
    }

    const { text } = await this.stt.transcribe(chunk, mimeType);
    this.send(ws, { type: "transcript", text });

    const visibleText = await this.respondToText(ws, state, text);
    if (visibleText === undefined) return;

    const { audioBase64, mimeType: replyMimeType } = await this.tts.synthesize(visibleText);
    this.send(ws, { type: "agent.audio", chunk: audioBase64, mimeType: replyMimeType });
  }

  /**
   * Shared by the text and voice paths: runs a turn through the (already
   * channel-agnostic) conversation engine, sends the text reply, and handles
   * completion. Returns the assistant's visible text so the voice path can
   * synthesize speech from it; returns undefined if the session wasn't
   * started (in which case an error was already sent and callers should stop).
   */
  private async respondToText(
    ws: WebSocket,
    state: ConnectionState,
    text: string,
  ): Promise<string | undefined> {
    if (!state.conversationId || !state.agentConfig) {
      this.send(ws, { type: "error", message: "Session not started" });
      return undefined;
    }

    const result = await this.engine.handleUserMessage({
      conversationId: state.conversationId,
      config: state.agentConfig,
      userText: text,
    });

    this.send(ws, { type: "agent.message", text: result.visibleText, done: true });

    if (result.isComplete) {
      const history = await this.engine.getHistory(state.conversationId);
      await this.conversations.complete({
        conversationId: state.conversationId,
        outcomeType: result.outcomeType,
        capturedData: result.capturedData,
        history,
      });
      this.send(ws, {
        type: "session.completed",
        outcomeType: result.outcomeType,
        capturedData: result.capturedData,
      });
      await this.sessions.clear(state.conversationId);
    }

    return result.visibleText;
  }

  private send(ws: WebSocket, message: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}
