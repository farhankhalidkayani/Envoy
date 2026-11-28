import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { models } = vi.hoisted(() => ({
  models: { catalog: vi.fn(), listCredentials: vi.fn(), status: vi.fn(), getConfig: vi.fn(), usage: vi.fn(), setConfig: vi.fn() },
}));
vi.mock("../../../lib/api", () => ({ api: { models } }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: { role: "owner" } }) }));
vi.mock("../../../components/Toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import ModelsPage from "./page";

const key = (id: string, provider: string, label: string) => ({ id, provider, label, last4: "1234", baseUrl: null, status: "active", lastUsedAt: null, lastError: null, createdAt: "2030-01-01" });
const platform = { source: "platform" };

describe("AI models page — voice", () => {
  beforeEach(() => {
    Object.values(models).forEach((m) => m.mockReset());
    models.catalog.mockResolvedValue({ providers: [] });
    models.listCredentials.mockResolvedValue([key("k-ant", "anthropic", "Claude key"), key("k-oai", "openai", "OpenAI key"), key("k-groq", "groq", "Groq key"), key("k-gem", "gemini", "Gemini key")]);
    models.status.mockResolvedValue({ usingPlatformDefault: false, hasInvalidCredential: false, credentialCount: 4, roles: { chat: platform, judge: platform, extract: platform, summarize: platform }, voice: { stt: platform, tts: platform }, config: {} });
    models.getConfig.mockResolvedValue({ allowPlatformFallback: true });
    models.usage.mockResolvedValue({ rows: [{ model: "whisper-large-v3", role: "stt", keySource: "tenant", provider: "groq", calls: 3, inputTokens: 0, outputTokens: 0, failures: 0 }] });
    models.setConfig.mockResolvedValue({});
  });

  const options = (label: string) => within(screen.getByLabelText(label)).getAllByRole("option").map((o) => o.textContent);

  it("only offers keys whose provider can do each voice job", async () => {
    render(<ModelsPage />);
    await screen.findByLabelText("Listening key");
    expect(options("Listening key")).toEqual(["Shared default", "OpenAI key", "Groq key"]);
    expect(options("Speaking key")).toEqual(["Shared default", "OpenAI key", "Gemini key"]);
  });

  it("picking a key suggests that provider's model, and speaking also takes a voice; saving sends exactly that", async () => {
    render(<ModelsPage />);
    fireEvent.change(await screen.findByLabelText("Listening key"), { target: { value: "k-groq" } });
    expect(screen.getByLabelText("Listening model")).toHaveValue("whisper-large-v3");
    fireEvent.change(screen.getByLabelText("Speaking key"), { target: { value: "k-gem" } });
    expect(screen.getByLabelText("Speaking model")).toHaveValue("gemini-2.5-pro-preview-tts");
    expect(screen.getByLabelText("Speaking voice")).toHaveAttribute("placeholder", "voice (default: Kore)");
    fireEvent.change(screen.getByLabelText("Speaking voice"), { target: { value: "Puck" } });
    fireEvent.click(screen.getByRole("button", { name: "Save model settings" }));
    await waitFor(() => expect(models.setConfig).toHaveBeenCalled());
    expect(models.setConfig.mock.calls[0]![0]).toEqual({
      allowPlatformFallback: true,
      stt: { credentialId: "k-groq", model: "whisper-large-v3" },
      tts: { credentialId: "k-gem", model: "gemini-2.5-pro-preview-tts", voice: "Puck" },
    });
  });

  it("an empty voice name is left out, so the provider's default is used", async () => {
    render(<ModelsPage />);
    fireEvent.change(await screen.findByLabelText("Speaking key"), { target: { value: "k-oai" } });
    fireEvent.change(screen.getByLabelText("Speaking voice"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save model settings" }));
    await waitFor(() => expect(models.setConfig).toHaveBeenCalled());
    expect(models.setConfig.mock.calls[0]![0].tts).toEqual({ credentialId: "k-oai", model: "gpt-4o-mini-tts" });
  });

  it("going back to the shared default removes the choice", async () => {
    models.getConfig.mockResolvedValue({ allowPlatformFallback: true, stt: { credentialId: "k-oai", model: "gpt-4o-transcribe" } });
    render(<ModelsPage />);
    expect(await screen.findByLabelText("Listening model")).toHaveValue("gpt-4o-transcribe");
    fireEvent.change(screen.getByLabelText("Listening key"), { target: { value: "" } });
    expect(screen.queryByLabelText("Listening model")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save model settings" }));
    await waitFor(() => expect(models.setConfig).toHaveBeenCalled());
    expect(models.setConfig.mock.calls[0]![0]).not.toHaveProperty("stt");
  });

  it("says which key to add when none can do the job", async () => {
    models.listCredentials.mockResolvedValue([key("k-ant", "anthropic", "Claude key")]);
    render(<ModelsPage />);
    expect(await screen.findByText("Add an OpenAI or Groq key to use your own.")).toBeInTheDocument();
    expect(screen.getByText("Add an OpenAI or Gemini key to use your own.")).toBeInTheDocument();
  });

  it("names voice jobs in plain words in the usage table", async () => {
    render(<ModelsPage />);
    const row = (await screen.findByText("whisper-large-v3")).closest("tr")!;
    expect(row).toHaveTextContent("Listening");
  });
});
