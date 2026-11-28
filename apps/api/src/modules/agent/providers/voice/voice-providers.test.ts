import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelProviderFactory } from "../../../models/provider-factory.js";
import { LlmHttpError } from "../llm/types.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());
const factory = new ModelProviderFactory();
const ok = (body: unknown, raw?: ArrayBuffer) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => raw ?? new ArrayBuffer(0), text: async () => "" });

describe("speech-to-text clients", () => {
  it.each([
    ["openai", null, "https://api.openai.com/v1/audio/transcriptions"],
    ["groq", null, "https://api.groq.com/openai/v1/audio/transcriptions"],
    ["openai_compatible", "https://voice.example.com/v1/", "https://voice.example.com/v1/audio/transcriptions"],
  ] as const)("%s posts the audio as multipart to the right endpoint with the key", async (kind, baseUrl, url) => {
    fetchMock.mockResolvedValue(ok({ text: "hello" }));
    const out = await factory.createStt(kind, "key-123", "whisper-x", baseUrl).transcribe(Buffer.from("audio").toString("base64"), "audio/ogg");
    expect(out).toEqual({ text: "hello" });
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe(url);
    expect(init.headers).toEqual({ Authorization: "Bearer key-123" });
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-x");
    expect((form.get("file") as File).name).toBe("audio.ogg");
    expect(Buffer.from(await (form.get("file") as File).arrayBuffer()).toString()).toBe("audio");
  });

  it("reports a provider refusal with its status, so routing can fail over and flag the key", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "bad key" });
    const err = await factory.createStt("openai", "k", "m").transcribe("", "audio/webm").catch((e) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.status).toBe(401);
  });

  it("can't be built for providers without speech-to-text, or a custom endpoint without a URL", () => {
    expect(() => factory.createStt("anthropic", "k", "m")).toThrow(/can't transcribe/);
    expect(() => factory.createStt("gemini", "k", "m")).toThrow(/can't transcribe/);
    expect(() => factory.createStt("openai_compatible", "k", "m")).toThrow(/base URL/);
  });
});

describe("text-to-speech clients", () => {
  it("OpenAI asks for WAV in the chosen voice and returns it as base64", async () => {
    fetchMock.mockResolvedValue(ok(null, new TextEncoder().encode("RIFF....").buffer as ArrayBuffer));
    const out = await factory.createTts("openai", "sk-1", "gpt-4o-mini-tts", "nova").synthesize("Hi there");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-1" });
    expect(JSON.parse(init.body)).toEqual({ model: "gpt-4o-mini-tts", input: "Hi there", voice: "nova", response_format: "wav" });
    expect(out).toEqual({ audioBase64: Buffer.from("RIFF....").toString("base64"), mimeType: "audio/wav" });
  });

  it("OpenAI defaults to the alloy voice; a custom endpoint uses its own URL", async () => {
    fetchMock.mockResolvedValue(ok(null));
    await factory.createTts("openai_compatible", "k", "tts", undefined, "https://tts.example.com/v1").synthesize("x");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://tts.example.com/v1/audio/speech");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).voice).toBe("alloy");
  });

  it("Gemini sends the voice name and wraps its raw PCM in a WAV header", async () => {
    fetchMock.mockResolvedValue(ok({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(480).toString("base64") } }] } }] }));
    const out = await factory.createTts("gemini", "gk", "gemini-2.5-flash-preview-tts", "Puck").synthesize("Hello");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/models/gemini-2.5-flash-preview-tts:generateContent?key=gk");
    expect(JSON.parse(init.body).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
    const wav = Buffer.from(out.audioBase64, "base64");
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.length).toBe(44 + 480);
  });

  it("Gemini falls back to its default voice when none is chosen", async () => {
    fetchMock.mockResolvedValue(ok({ candidates: [{ content: { parts: [{ inlineData: { data: "AAAA" } }] } }] }));
    await factory.createTts("gemini", "gk", "m").synthesize("x");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
  });

  it("reports refusals with their status, and can't be built for providers without speech", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => "slow down" });
    expect((await factory.createTts("gemini", "k", "m").synthesize("x").catch((e) => e)).status).toBe(429);
    expect(() => factory.createTts("anthropic", "k", "m")).toThrow(/can't generate speech/);
    expect(() => factory.createTts("groq", "k", "m")).toThrow(/can't generate speech/);
  });
});
