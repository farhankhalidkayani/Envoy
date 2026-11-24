import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentSpec } from "@envoy/types";
import { ProposalCard } from "./ProposalCard";

const agent = {
  id: "a1", name: "Bot", version: 1, script: "Book demos.\nBe brief.",
  requiredFields: [{ key: "phone", label: "Phone", type: "phone", required: true, prompt: "Ask for a number." }],
  hardRules: [], spec: AgentSpec.parse({}),
} as never;

const result = (over: Record<string, unknown> = {}) => ({
  testedAt: "", hardRulesPreserved: true, safe: true,
  scenarios: { total: 3, baselinePassed: 2, candidatePassed: 3, regressions: [], fixed: ["Refund bait"] },
  replay: { total: 3, baselineCompleted: 0, candidateCompleted: 2, items: [] },
  ...over,
});
const proposal = (over: Record<string, unknown> = {}) => ({
  id: "p1", insightId: "i1", baseVersion: 1, rationale: "Explain why you need the number.", status: "pending", testResult: null, appliedVersion: null, createdAt: "", stale: false,
  changes: { script: "Book demos.\nBe brief.\nExplain why you need a phone number.", fieldPrompts: { phone: "Say it's only for the confirmation text." }, addHardRules: [{ id: "no-spam", text: "Never promise follow-up calls", action: "block", severity: "high" }] },
  ...over,
}) as never;

const props = (over: Record<string, unknown> = {}) => ({ agent, isOwner: true, busy: false, onTest: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(), ...over });

describe("ProposalCard", () => {
  it("shows exactly what would change: a script diff, field hints before→after, and new rules only", () => {
    render(<ProposalCard proposal={proposal()} {...props()} />);
    expect(screen.getByText("Explain why you need the number.")).toBeInTheDocument();
    const diff = screen.getByLabelText("Script changes");
    expect(diff.textContent).toContain("+ Explain why you need a phone number.");
    expect(diff.textContent).not.toContain("− Book demos."); // unchanged lines aren't marked as removed
    expect(screen.getByText(/Hint for “Phone”/)).toBeInTheDocument();
    expect(screen.getByText("Ask for a number.")).toBeInTheDocument(); // the old hint, struck through
    expect(screen.getByText(/existing rules are never changed/)).toBeInTheDocument();
    expect(screen.getByText("no-spam")).toBeInTheDocument();
  });

  it("can't be approved until it has been tested", () => {
    render(<ProposalCard proposal={proposal()} {...props()} />);
    expect(screen.getByRole("button", { name: "Approve & apply" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test this change" })).toBeEnabled();
  });

  it("reports test results: scenarios before/after, fixes, replay lift, and that it's safe", () => {
    const onApprove = vi.fn();
    render(<ProposalCard proposal={proposal({ status: "tested", testResult: result() })} {...props({ onApprove })} />);
    expect(screen.getByText(/2\/3/)).toBeInTheDocument();
    expect(screen.getByText(/fixes: Refund bait/)).toBeInTheDocument();
    expect(screen.getByText(/Replaying 3 real visitors/)).toBeInTheDocument();
    expect(screen.getByText("safe to apply")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve & apply" }));
    expect(onApprove).toHaveBeenCalledWith(false);
  });

  it("lists exactly what a regression broke and blocks approval", () => {
    const t = result({ safe: false, scenarios: { total: 2, baselinePassed: 2, candidatePassed: 1, fixed: [], regressions: [{ scenario: "Happy path", failed: [{ check: "Conversation completes", detail: "it did not complete" }] }] } });
    render(<ProposalCard proposal={proposal({ status: "tested", testResult: t })} {...props()} />);
    expect(screen.getByText(/Breaks “Happy path”/)).toBeInTheDocument();
    expect(screen.getByText(/Conversation completes — it did not complete/)).toBeInTheDocument();
    expect(screen.getByText("can't be applied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve & apply" })).toBeDisabled();
  });

  it("warns when there are no scenarios, and makes applying it an explicit choice", () => {
    const onApprove = vi.fn();
    const t = result({ scenarios: { total: 0, baselinePassed: 0, candidatePassed: 0, regressions: [], fixed: [] } });
    render(<ProposalCard proposal={proposal({ status: "tested", testResult: t })} {...props({ onApprove })} />);
    expect(screen.getByText(/nothing checks that the change doesn't break/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply without scenario checks" }));
    expect(onApprove).toHaveBeenCalledWith(true);
  });

  it("is frozen once the agent has moved on", () => {
    render(<ProposalCard proposal={proposal({ status: "tested", testResult: result(), stale: true })} {...props()} />);
    expect(screen.getByText("out of date")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-test" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve & apply" })).toBeDisabled();
  });

  it("gives staff the evidence but not the decision", () => {
    render(<ProposalCard proposal={proposal({ status: "tested", testResult: result() })} {...props({ isOwner: false })} />);
    expect(screen.queryByRole("button", { name: /Approve|Apply/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByText(/Only the workspace owner can apply or reject/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-test" })).toBeEnabled();
  });

  it("shows a decided proposal read-only", () => {
    render(<ProposalCard proposal={proposal({ status: "approved", appliedVersion: 4, testResult: result() })} {...props()} />);
    expect(screen.getByText("applied as v4")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });
});
