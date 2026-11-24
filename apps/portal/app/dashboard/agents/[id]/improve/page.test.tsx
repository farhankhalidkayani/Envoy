import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSpec } from "@envoy/types";

const { imp, get, FakeApiError } = vi.hoisted(() => ({
  imp: { metrics: vi.fn(), insights: vi.fn(), proposals: vi.fn(), analyze: vi.fn(), propose: vi.fn(), setInsightStatus: vi.fn(), test: vi.fn(), approve: vi.fn(), reject: vi.fn() },
  get: vi.fn(),
  FakeApiError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
}));
vi.mock("@envoy/sdk", () => ({ ApiError: FakeApiError }));
vi.mock("../../../../../lib/api", () => ({ api: { agents: { get: () => get(), improvement: imp } } }));
vi.mock("../../../../../lib/auth", () => ({ useAuth: () => ({ user: { role: "owner" } }) }));
vi.mock("../../../../../components/Toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "a1" }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import ImprovePage from "./page";

const agent = { id: "a1", name: "Bot", version: 2, script: "s", requiredFields: [], hardRules: [], spec: AgentSpec.parse({}) };
const insight = { id: "i1", agentVersion: 2, kind: "abandon_at_field", fingerprint: "f", severity: "critical", title: "Visitors leave when asked for “Phone”", detail: "6 of 6 left at Phone.", evidence: { count: 6, total: 6, conversationIds: [], facts: {} }, status: "open", createdAt: "" };
const metrics = { days: 30, currentVersion: 2, truncated: false, versions: [
  { version: 1, conversations: 12, bounces: 0, engaged: 12, completed: 10, abandoned: 2, handoffs: 0, completionRate: 0.833, avgTurnsToComplete: 4, blockedViolations: 0, toolCalls: 0, toolErrors: 0 },
  { version: 2, conversations: 11, bounces: 2, engaged: 9, completed: 3, abandoned: 6, handoffs: 1, completionRate: 0.333, avgTurnsToComplete: 4.5, blockedViolations: 2, toolCalls: 5, toolErrors: 1 },
] };

describe("Improve page", () => {
  beforeEach(() => {
    Object.values(imp).forEach((m) => m.mockReset());
    get.mockResolvedValue(agent);
    imp.metrics.mockResolvedValue(metrics);
    imp.insights.mockResolvedValue([insight]);
    imp.proposals.mockResolvedValue([]);
  });

  it("explains the feature is off when the server says it isn't enabled", async () => {
    imp.metrics.mockRejectedValue(new FakeApiError(403, "Feature not enabled"));
    render(<ImprovePage />);
    expect(await screen.findByText(/isn't enabled for your account/)).toBeInTheDocument();
  });

  it("shows performance per version with the current one marked, and the diagnosed problems", async () => {
    render(<ImprovePage />);
    expect(await screen.findByText("v2 (current)")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByText("83%")).toBeInTheDocument();
    expect(screen.getByText(/left without saying anything/)).toBeInTheDocument();
    expect(screen.getByText("Visitors leave when asked for “Phone”")).toBeInTheDocument();
    expect(screen.getByText("critical")).toBeInTheDocument();
    expect(screen.getByText("Based on 6 of 6")).toBeInTheDocument();
  });

  it("drafts a fix for a finding, and can dismiss it", async () => {
    imp.propose.mockResolvedValue({});
    imp.setInsightStatus.mockResolvedValue({});
    render(<ImprovePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Propose a fix" }));
    await waitFor(() => expect(imp.propose).toHaveBeenCalledWith("a1", "i1"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(imp.setInsightStatus).toHaveBeenCalledWith("a1", "i1", "dismissed"));
  });

  it("surfaces an error from the server, e.g. no usable proposal", async () => {
    imp.propose.mockRejectedValue(new Error("The model couldn't produce a usable proposal."));
    render(<ImprovePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Propose a fix" }));
    expect(await screen.findByText(/couldn't produce a usable proposal/)).toBeInTheDocument();
  });

  it("asks for analysis when nothing has been diagnosed yet", async () => {
    imp.insights.mockResolvedValue([]);
    imp.analyze.mockResolvedValue([]);
    render(<ImprovePage />);
    expect(await screen.findByText(/at least 8 conversations/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Analyse conversations" }));
    await waitFor(() => expect(imp.analyze).toHaveBeenCalledWith("a1"));
  });

  it("lists proposals waiting on a decision", async () => {
    imp.proposals.mockResolvedValue([{ id: "p1", insightId: "i1", baseVersion: 2, rationale: "Explain why you need it.", status: "pending", testResult: null, appliedVersion: null, createdAt: "", stale: false, changes: { script: "new" } }]);
    render(<ImprovePage />);
    expect(await screen.findByText("Waiting for your decision")).toBeInTheDocument();
    expect(screen.getByText("Explain why you need it.")).toBeInTheDocument();
  });
});
