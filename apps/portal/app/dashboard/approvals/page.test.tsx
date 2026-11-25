import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { approvals, auth } = vi.hoisted(() => ({ approvals: { list: vi.fn(), approve: vi.fn(), reject: vi.fn() }, auth: { role: "owner" } }));
vi.mock("../../../lib/api", () => ({ api: { approvals } }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
vi.mock("../../../components/Toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import ApprovalsPage from "./page";

const req = (over: Record<string, unknown> = {}) => ({
  id: "r1", kind: "set_hard_rules", kindLabel: "Change an agent's hard rules", status: "pending", agentId: "a1", agentName: "Booker", requestedBy: "Claude desktop",
  reason: "Refund wording is risky.", baseVersion: 2, currentVersion: 2, stale: false, note: null, createdAt: "2030-01-01T10:00:00Z", expiresAt: new Date(Date.now() + 5 * 3_600_000).toISOString(), decidedAt: null, result: null,
  summary: { title: "Change hard rules on “Booker”", lines: ["ADD: “Never promise refunds” (block, high)", "REMOVE: “Never quote prices”"], warnings: ["Removing a rule lets the agent say things it is currently blocked from saying."] }, ...over,
});

describe("Approvals page", () => {
  beforeEach(() => { Object.values(approvals).forEach((m) => m.mockReset()); auth.role = "owner"; approvals.list.mockResolvedValue([req()]); });

  it("shows what would really happen, the warnings, and the requester's reason as an unverified quote", async () => {
    render(<ApprovalsPage />);
    expect(await screen.findByText("Change hard rules on “Booker”")).toBeInTheDocument();
    expect(screen.getByText("ADD: “Never promise refunds” (block, high)")).toBeInTheDocument();
    expect(screen.getByText("REMOVE: “Never quote prices”")).toBeInTheDocument();
    expect(screen.getByText(/Removing a rule lets the agent say things/)).toBeInTheDocument();
    expect(screen.getByText(/asked by/)).toHaveTextContent("Claude desktop");
    expect(screen.getByText(/expires in 5 hours/)).toBeInTheDocument();
    expect(screen.getByText(/their words, not verified/)).toBeInTheDocument();
    expect(screen.getByText("Refund wording is risky.")).toBeInTheDocument();
  });

  it("lets the owner approve, then refreshes the list", async () => {
    approvals.approve.mockResolvedValue({ status: "approved" });
    render(<ApprovalsPage />);
    approvals.list.mockResolvedValue([]);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approvals.approve).toHaveBeenCalledWith("r1"));
    expect(await screen.findByText("Nothing is waiting for you.")).toBeInTheDocument();
  });

  it("lets the owner reject", async () => {
    approvals.reject.mockResolvedValue({ status: "rejected" });
    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(approvals.reject).toHaveBeenCalledWith("r1"));
    expect(approvals.approve).not.toHaveBeenCalled();
  });

  it("won't let you approve one that is out of date, and says why", async () => {
    approvals.list.mockResolvedValue([req({ stale: true, currentVersion: 3 })]);
    render(<ApprovalsPage />);
    expect(await screen.findByText(/Out of date/)).toBeInTheDocument();
    expect(screen.getByText(/version 2 → 3/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("shows the server's reason when approving fails, and still refreshes", async () => {
    approvals.approve.mockRejectedValue(new Error("The agent has changed since this was requested."));
    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed since this was requested/);
    await waitFor(() => expect(approvals.list).toHaveBeenCalledTimes(2));
  });

  it("gives staff the view but not the decision", async () => {
    auth.role = "staff";
    render(<ApprovalsPage />);
    expect(await screen.findByText(/Only the workspace owner can approve or reject/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("keeps decided requests in a history, with the reason they ended", async () => {
    approvals.list.mockResolvedValue([req({ id: "r2", status: "stale", summary: null, note: "The agent changed (v2 → v3) after this was requested." }), req({ id: "r3", status: "approved", summary: null })]);
    render(<ApprovalsPage />);
    expect(await screen.findByText("Nothing is waiting for you.")).toBeInTheDocument();
    expect(screen.getByText("Earlier requests (2)")).toBeInTheDocument();
    expect(screen.getByText("stale")).toBeInTheDocument();
    expect(screen.getByText(/The agent changed \(v2 → v3\)/)).toBeInTheDocument();
    expect(screen.getByText("approved")).toBeInTheDocument();
  });
});
