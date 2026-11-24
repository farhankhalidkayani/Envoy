import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
const status = vi.fn();
const run = vi.fn();
const remove = vi.fn(async (..._args: unknown[]) => ({ deleted: true }));
const create = vi.fn(async (..._args: unknown[]) => ({ id: "n" }));
const listCredentials = vi.fn();
vi.mock("../../lib/api", () => ({
  api: {
    agents: { scenarios: { list: () => list(), status: () => status(), run: (...a: unknown[]) => run(...a), remove: (...a: unknown[]) => remove(...a), create: (...a: unknown[]) => create(...a), update: vi.fn() } },
    models: { listCredentials: () => listCredentials() },
  },
}));
vi.mock("../Toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { ScenarioManager } from "./ScenarioManager";

const agent = { id: "a1", name: "Bot", version: 2, spec: { goals: [] } } as never;
const scenario = (id: string, name: string, lastRun: unknown = null) => ({ id, name, description: null, turns: ["hi"], expect: {}, sandbox: { knownContacts: [], busy: [] }, createdAt: "", lastRun });

describe("ScenarioManager", () => {
  beforeEach(() => {
    [list, status, run, remove, create, listCredentials].forEach((m) => m.mockReset?.());
    listCredentials.mockResolvedValue([]);
    status.mockResolvedValue({ agentVersion: 2, total: 2, passing: 1, failing: 1, notRun: 0 });
  });

  it("shows each scenario's state for the current version, and says when a result is stale", async () => {
    list.mockResolvedValue([
      scenario("s1", "Happy path", { id: "r", passed: true, error: null, agentVersion: 2, createdAt: "", onCurrentVersion: true }),
      scenario("s2", "Refunds", { id: "r2", passed: false, error: null, agentVersion: 2, createdAt: "", onCurrentVersion: true }),
      scenario("s3", "Old", { id: "r3", passed: true, error: null, agentVersion: 1, createdAt: "", onCurrentVersion: false }),
      scenario("s4", "Fresh", null),
    ]);
    render(<ScenarioManager agent={agent} refreshKey={0} />);
    expect(await screen.findByText("Happy path")).toBeInTheDocument();
    expect(screen.getByText("passing")).toBeInTheDocument();
    expect(screen.getByText("failing")).toBeInTheDocument();
    expect(screen.getByText("not run on this version")).toBeInTheDocument();
    expect(screen.getByText("not run")).toBeInTheDocument();
    expect(screen.getByText(/v2: 1 passing · 1 failing · 0 not run/)).toBeInTheDocument();
  });

  it("runs everything and lists exactly which expectations failed and why", async () => {
    list.mockResolvedValue([scenario("s1", "Happy path"), scenario("s2", "Refunds")]);
    run.mockResolvedValue({
      agentVersion: 2,
      variants: [{ label: "current", passed: 1, total: 2, inputTokens: 100, outputTokens: 20, avgLatencyMs: 1500 }],
      results: [
        { variant: "current", scenarioId: "s1", name: "Happy path", runId: "r1", passed: true, checks: [{ name: "Conversation completes", passed: true, detail: "it completed" }], tokens: { calls: 1, inputTokens: 50, outputTokens: 10 }, latencyMs: 1000 },
        { variant: "current", scenarioId: "s2", name: "Refunds", runId: "r2", passed: false, checks: [{ name: "No reply mentions “guaranteed”", passed: false, detail: "a reply contained it" }], tokens: { calls: 1, inputTokens: 50, outputTokens: 10 }, latencyMs: 2000 },
      ],
    });
    render(<ScenarioManager agent={agent} refreshKey={0} />);
    await screen.findByText("Happy path");
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    expect(await screen.findByText("Results (agent v2)")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByText(/a reply contained it/)).toBeInTheDocument(); // failing check detail shown (its scenario opens automatically)
    expect(run).toHaveBeenCalledWith("a1", {});
  });

  it("compares the current setup against another model side by side", async () => {
    list.mockResolvedValue([scenario("s1", "Happy path")]);
    listCredentials.mockResolvedValue([{ id: "k1", label: "Mine", provider: "anthropic", status: "active" }]);
    run.mockResolvedValue({
      agentVersion: 2,
      variants: [
        { label: "Current setup", passed: 0, total: 1, inputTokens: 0, outputTokens: 0, avgLatencyMs: 900 },
        { label: "Mine · claude-opus-5-5 (Anthropic (Claude))", passed: 1, total: 1, inputTokens: 300, outputTokens: 40, avgLatencyMs: 2400 },
      ],
      results: [
        { variant: "Current setup", scenarioId: "s1", name: "Happy path", runId: "a", passed: false, checks: [{ name: "X", passed: false, detail: "no" }], tokens: { calls: 1, inputTokens: 0, outputTokens: 0 }, latencyMs: 900 },
        { variant: "Mine · claude-opus-5-5 (Anthropic (Claude))", scenarioId: "s1", name: "Happy path", runId: "b", passed: true, checks: [], tokens: { calls: 1, inputTokens: 300, outputTokens: 40 }, latencyMs: 2400 },
      ],
    });
    render(<ScenarioManager agent={agent} refreshKey={0} />);
    await screen.findByText("Happy path");
    fireEvent.change(screen.getByLabelText("Key to compare with"), { target: { value: "k1" } });
    fireEvent.change(screen.getByLabelText("Model to compare with"), { target: { value: "claude-opus-5-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0]![1]).toEqual({
      variants: [{ label: "Current setup" }, { label: "Mine · claude-opus-5-5 (Anthropic (Claude))", models: { default: { credentialId: "k1", model: "claude-opus-5-5" } } }],
    });
    expect(await screen.findByText("0 / 1")).toBeInTheDocument();
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
  });

  it("asks for both halves of a comparison before running", async () => {
    list.mockResolvedValue([scenario("s1", "Happy path")]);
    listCredentials.mockResolvedValue([{ id: "k1", label: "Mine", provider: "anthropic", status: "active" }]);
    render(<ScenarioManager agent={agent} refreshKey={0} />);
    await screen.findByText("Happy path");
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText(/Pick a key and enter the model/)).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it("creates a scenario through the editor and rejects an invalid one before calling the server", async () => {
    list.mockResolvedValue([]);
    render(<ScenarioManager agent={agent} refreshKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "+ New scenario" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Booking" } });
    fireEvent.change(screen.getByLabelText("What the visitor says"), { target: { value: "hi\nada@example.com" } });
    fireEvent.change(screen.getByLabelText("Contacts that exist"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Save scenario" }));
    expect(await screen.findByText(/email/i, { selector: ".error-banner" })).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Contacts that exist"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Conversation completes"), { target: { value: "yes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save scenario" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![1]).toMatchObject({ name: "Booking", turns: ["hi", "ada@example.com"], expect: { completes: true } });
  });

  it("deletes a scenario", async () => {
    list.mockResolvedValue([scenario("s1", "Happy path")]);
    render(<ScenarioManager agent={agent} refreshKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Happy path" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("a1", "s1"));
  });
});
