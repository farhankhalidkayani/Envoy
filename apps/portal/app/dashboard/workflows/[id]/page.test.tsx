import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { wf, replace, auth, params } = vi.hoisted(() => ({
  wf: { get: vi.fn(), create: vi.fn(), update: vi.fn(), setStatus: vi.fn(), runs: vi.fn(), getRun: vi.fn(), cancelRun: vi.fn(), preview: vi.fn() },
  replace: vi.fn(),
  auth: { role: "owner" },
  params: { id: "w1" },
}));
vi.mock("../../../../lib/api", () => ({ api: { workflows: wf, agents: { list: async () => [] }, forms: { list: async () => [] } } }));
vi.mock("../../../../lib/auth", () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
vi.mock("../../../../components/Toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useParams: () => params, useRouter: () => ({ replace }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import WorkflowPage from "./page";

const stored = (over: Record<string, unknown> = {}) => ({
  id: "w1", name: "Hot leads", status: "draft", updatedAt: "t1", trigger: { type: "conversation_completed" }, conditions: { match: "all", conditions: [] },
  steps: [{ type: "send_email", to: "lead", subject: "s", body: "b" }],
  settings: { emailField: "email", phoneField: "phone", timezone: "UTC", quietHours: { enabled: true, startHour: 21, endHour: 8 }, exitOnReply: true }, ...over,
});

describe("Follow-up page", () => {
  beforeEach(() => { Object.values(wf).forEach((m) => m.mockReset()); replace.mockReset(); auth.role = "owner"; params.id = "w1"; });

  it("creates a new workflow as a draft and moves to its page", async () => {
    params.id = "new";
    wf.create.mockResolvedValue(stored({ id: "w9" }));
    render(<WorkflowPage />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Welcome" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hi" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Thanks" } });
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    await waitFor(() => expect(wf.create).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith("/dashboard/workflows/w9");
    expect(screen.queryByRole("tab")).toBeNull(); // no activity tab for something not saved yet
  });

  it("lets the owner take a draft live — and tells them what that means once it is", async () => {
    wf.get.mockResolvedValue(stored());
    wf.setStatus.mockResolvedValue(stored({ status: "live" }));
    render(<WorkflowPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Go live" }));
    await waitFor(() => expect(wf.setStatus).toHaveBeenCalledWith("w1", "live"));
    expect(await screen.findByText(/it can't be edited/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save workflow" })).toBeNull();
    expect(screen.getByLabelText("Name")).toBeDisabled();
  });

  it("pauses a live workflow, which makes it editable again", async () => {
    wf.get.mockResolvedValue(stored({ status: "live" }));
    wf.setStatus.mockResolvedValue(stored({ status: "paused", updatedAt: "t2" }));
    render(<WorkflowPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save workflow" })).toBeInTheDocument();
  });

  it("doesn't let staff switch a workflow on", async () => {
    auth.role = "staff";
    wf.get.mockResolvedValue(stored());
    render(<WorkflowPage />);
    expect(await screen.findByRole("button", { name: "Go live" })).toBeDisabled();
  });

  it("shows the server's reason if switching on fails", async () => {
    wf.get.mockResolvedValue(stored());
    wf.setStatus.mockRejectedValue(new Error("This workflow isn't valid: Waits add up to more than 60 days"));
    render(<WorkflowPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Go live" }));
    expect(await screen.findByText(/Waits add up to more than 60 days/)).toBeInTheDocument();
  });

  it("shows each lead's run with what happened at every step, and can cancel one in flight", async () => {
    wf.get.mockResolvedValue(stored({ status: "paused" }));
    wf.runs.mockResolvedValue([
      { id: "r1", status: "running", stopReason: null, sourceType: "conversation", createdAt: "2030-01-01T10:00:00Z" },
      { id: "r2", status: "stopped", stopReason: "replied", sourceType: "form_submission", createdAt: "2030-01-01T09:00:00Z" },
    ]);
    wf.getRun.mockResolvedValue({ id: "r1", status: "running", logs: [
      { id: "l1", stepIndex: 0, type: "send_email", status: "sent", toMasked: "a***@example.com", detail: null },
      { id: "l2", stepIndex: 1, type: "send_sms", status: "skipped", toMasked: null, detail: "Lead opted out of SMS" },
    ] });
    wf.cancelRun.mockResolvedValue({ cancelled: true });
    render(<WorkflowPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Activity" }));
    expect(await screen.findByText(/stopped because the lead replied/)).toBeInTheDocument();
    fireEvent.click((await screen.findAllByRole("button", { name: "Details" }))[0]!);
    expect(await screen.findByText(/Step 1: email to a\*\*\*@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/Lead opted out of SMS/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Cancel this lead/ }));
    await waitFor(() => expect(wf.cancelRun).toHaveBeenCalledWith("r1"));
  });
});
