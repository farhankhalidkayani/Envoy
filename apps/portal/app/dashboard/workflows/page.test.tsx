import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { wf, FakeApiError } = vi.hoisted(() => ({
  wf: { list: vi.fn(), optOuts: vi.fn(), addOptOut: vi.fn(), removeOptOut: vi.fn(), remove: vi.fn() },
  FakeApiError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
}));
vi.mock("@envoy/sdk", () => ({ ApiError: FakeApiError }));
vi.mock("../../../lib/api", () => ({ api: { workflows: wf } }));
vi.mock("../../../components/Toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import WorkflowsPage from "./page";

const w = (over: Record<string, unknown> = {}) => ({ id: "w1", name: "Hot leads", status: "live", trigger: { type: "conversation_completed" }, steps: [{ type: "send_email" }, { type: "wait" }, { type: "send_sms" }], runs: { running: 2, completed: 5 }, ...over });

describe("Follow-ups page", () => {
  beforeEach(() => { Object.values(wf).forEach((m) => m.mockReset()); wf.optOuts.mockResolvedValue([]); });

  it("explains the feature is off when the server says so", async () => {
    wf.list.mockRejectedValue(new FakeApiError(403, "Feature not enabled"));
    render(<WorkflowsPage />);
    expect(await screen.findByText(/aren't enabled for your account/)).toBeInTheDocument();
  });

  it("lists workflows with their state, message count and activity, and totals what was sent", async () => {
    wf.list.mockResolvedValue({ sentLast30Days: 1, workflows: [w(), w({ id: "w2", name: "Drafty", status: "draft", runs: {}, steps: [{ type: "send_sms" }], trigger: { type: "form_submitted" } })] });
    render(<WorkflowsPage />);
    expect(await screen.findByText("Hot leads")).toBeInTheDocument();
    expect(screen.getByText(/1 message sent in the last 30 days/)).toBeInTheDocument();
    expect(screen.getByText(/After a conversation · 2 messages · 2 running, 5 completed/)).toBeInTheDocument();
    expect(screen.getByText(/After a form · 1 message/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Hot leads" })).toHaveAttribute("href", "/dashboard/workflows/w1");
    // A live workflow can't be deleted out from under its leads; a draft can.
    expect(screen.queryByRole("button", { name: "Delete Hot leads" })).toBeNull();
    wf.remove.mockResolvedValue({ deleted: true });
    fireEvent.click(screen.getByRole("button", { name: "Delete Drafty" }));
    await waitFor(() => expect(wf.remove).toHaveBeenCalledWith("w2"));
  });

  it("invites you to create the first one", async () => {
    wf.list.mockResolvedValue({ sentLast30Days: 0, workflows: [] });
    render(<WorkflowsPage />);
    expect(await screen.findByText(/No follow-ups yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "+ New follow-up" })).toHaveAttribute("href", "/dashboard/workflows/new");
  });

  it("manages the do-not-contact list: people who opted out themselves can't be removed by the business", async () => {
    wf.list.mockResolvedValue({ sentLast30Days: 0, workflows: [] });
    wf.optOuts.mockResolvedValue([
      { id: "o1", channel: "sms", address: "+14155550100", reason: "stop", createdAt: "" },
      { id: "o2", channel: "email", address: "ada@example.com", reason: "unsubscribed", createdAt: "" },
      { id: "o3", channel: "email", address: "bob@example.com", reason: "manual", createdAt: "" },
    ]);
    wf.removeOptOut.mockResolvedValue({ removed: true });
    wf.addOptOut.mockResolvedValue({});
    render(<WorkflowsPage />);
    expect(await screen.findByText("+14155550100")).toBeInTheDocument();
    expect(screen.getByText("replied STOP")).toBeInTheDocument();
    expect(screen.getByText("unsubscribed")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove bob@example.com" }));
    await waitFor(() => expect(wf.removeOptOut).toHaveBeenCalledWith("o3"));

    fireEvent.change(screen.getByLabelText("Channel"), { target: { value: "sms" } });
    fireEvent.change(screen.getByLabelText("Address to add"), { target: { value: "+44 7700 900123" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(wf.addOptOut).toHaveBeenCalledWith("sms", "+44 7700 900123"));
  });

  it("shows why adding someone failed", async () => {
    wf.list.mockResolvedValue({ sentLast30Days: 0, workflows: [] });
    wf.addOptOut.mockRejectedValue(new Error("Enter the phone number in international format"));
    render(<WorkflowsPage />);
    fireEvent.change(await screen.findByLabelText("Address to add"), { target: { value: "0770" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/international format/)).toBeInTheDocument();
  });
});
