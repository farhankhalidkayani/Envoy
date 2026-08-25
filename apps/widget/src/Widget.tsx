import { useEffect, useRef, useState } from "preact/hooks";
import { AgentConnection, resolveAgent, type PublicAgent } from "./api.js";

type ChatMessage = { role: "agent" | "user"; text: string; heard?: boolean };
type Status = "connecting" | "chatting" | "completed" | "locked" | "error";
type RecordingState = "idle" | "recording" | "processing";

/** FileReader-based base64 encode — works uniformly across browsers, no manual byte-to-string loop. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function getPublicToken(): string | null {
  return new URLSearchParams(window.location.search).get("token");
}

export function Widget() {
  const [status, setStatus] = useState<Status>("connecting");
  const [agent, setAgent] = useState<PublicAgent | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [errorText, setErrorText] = useState("");
  const [recording, setRecording] = useState<RecordingState>("idle");
  const connectionRef = useRef<AgentConnection | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);

  useEffect(() => {
    const publicToken = getPublicToken();
    if (!publicToken) {
      setStatus("error");
      setErrorText("Missing agent token.");
      return;
    }

    let cancelled = false;
    resolveAgent(publicToken)
      .then((resolved) => {
        if (cancelled) return;
        if (resolved.locked) {
          setStatus("locked");
          return;
        }
        setAgent(resolved);
        setMessages([{ role: "agent", text: resolved.widgetConfig.greeting }]);

        connectionRef.current = new AgentConnection(resolved, {
          onMessage: (msg) => {
            switch (msg.type) {
              case "session.ready":
                setStatus("chatting");
                break;
              case "agent.message":
                setMessages((prev) => [...prev, { role: "agent", text: msg.text ?? "" }]);
                break;
              case "transcript":
                setRecording("idle");
                setMessages((prev) => [...prev, { role: "user", text: msg.text, heard: true }]);
                break;
              case "agent.audio": {
                const audioEl = audioRef.current;
                if (audioEl) {
                  audioEl.src = `data:${msg.mimeType};base64,${msg.chunk}`;
                  void audioEl.play().catch(() => {});
                }
                break;
              }
              case "session.completed":
                setStatus("completed");
                break;
              case "locked":
                setStatus("locked");
                break;
              case "error":
                setStatus("error");
                setErrorText(msg.message);
                setRecording("idle");
                break;
            }
          },
          onClose: () => {
            setStatus((prev) => (prev === "completed" ? prev : "error"));
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
          setErrorText("This chat is unavailable right now.");
        }
      });

    return () => {
      cancelled = true;
      connectionRef.current?.close();
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function submit(e: Event) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || status !== "chatting") return;
    setMessages((prev) => [...prev, { role: "user", text }]);
    connectionRef.current?.sendMessage(text);
    setDraft("");
  }

  async function toggleRecording() {
    if (status !== "chatting") return;

    if (recording === "recording") {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (recording !== "idle") return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording("processing");
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
        void blobToBase64(blob).then((base64) => {
          connectionRef.current?.sendAudio(base64, recorder.mimeType);
        });
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording("recording");
    } catch {
      setErrorText("Microphone access was denied or unavailable.");
    }
  }

  const accent = agent?.widgetConfig.primaryColor ?? "#235a97";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header
        style={{
          background: accent,
          color: "#fff",
          padding: "12px 16px",
          fontWeight: 600,
          fontSize: 15,
        }}
      >
        Chat
      </header>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "8px 12px",
                borderRadius: 12,
                fontSize: 14,
                lineHeight: 1.4,
                background: m.role === "user" ? accent : "#f0f1f3",
                color: m.role === "user" ? "#fff" : "#1a1a1a",
                fontStyle: m.heard ? "italic" : "normal",
                opacity: m.heard ? 0.85 : 1,
              }}
            >
              {m.heard ? `🎤 ${m.text}` : m.text}
            </div>
          </div>
        ))}

        {status === "locked" && (
          <div style={{ textAlign: "center", color: "#888", fontSize: 13, marginTop: 16 }}>
            This chat is temporarily unavailable.
          </div>
        )}
        {status === "error" && (
          <div style={{ textAlign: "center", color: "#b23b3b", fontSize: 13, marginTop: 16 }}>
            {errorText || "Something went wrong."}
          </div>
        )}
        {status === "completed" && (
          <div style={{ textAlign: "center", color: "#888", fontSize: 13, marginTop: 16 }}>
            Conversation complete — thanks for chatting!
          </div>
        )}
      </div>

      <audio ref={audioRef} style={{ display: "none" }} />

      <form onSubmit={submit} style={{ display: "flex", borderTop: "1px solid #e6eaf0", padding: 8 }}>
        {agent?.voiceEnabled && (
          <button
            type="button"
            onClick={toggleRecording}
            disabled={status !== "chatting" || recording === "processing"}
            aria-label={recording === "recording" ? "Stop recording" : "Record a voice message"}
            style={{
              background: recording === "recording" ? "#b23b3b" : "transparent",
              color: recording === "recording" ? "#fff" : accent,
              border: `1px solid ${recording === "recording" ? "#b23b3b" : accent}`,
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 14,
              marginRight: 6,
              cursor: "pointer",
            }}
          >
            {recording === "recording" ? "⏹" : recording === "processing" ? "…" : "🎤"}
          </button>
        )}
        <input
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          disabled={status !== "chatting"}
          placeholder={status === "chatting" ? "Type a message…" : ""}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            padding: "8px 10px",
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={status !== "chatting" || !draft.trim()}
          style={{
            background: accent,
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "8px 14px",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
