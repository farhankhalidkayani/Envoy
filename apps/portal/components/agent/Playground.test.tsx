import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const simulate = vi.fn();
const resetSimulation = vi.fn(async (..._args: unknown[]) => ({ reset: true }));
const create = vi.fn(async (..._args: unknown[]) => ({ id: "s1" }));
vi.mock("../../lib/api", () => ({ api: { agents: { simulate: (...a: unknown[]) => simulate(...a), resetSimulation: (...a: unknown[]) => resetSimulation(...a), scenarios: { create: (...a: unknown[]) => create(...a) } } } }));
vi.mock("../Toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { Playground } from "./Playground";

const agent = { id: "a1", name: "Bot", version: 2 } as never;
const turn = (over: Record<string, unknown> = {}) => ({
  sessionId: "sess-1", agentVersion: 2, reply: "Could you share your email?", isComplete: false, capturedData: {}, goalProgress: {}, blockedViolations: 0, steps: [], ...over,
});
const say = async (text: string) => {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(simulate).toHaveBeenCalled());
};

describe("Playground", () => {
  beforeEach(() => { simulate.mockReset(); resetSimulation.mockClear(); create.mockClear(); });

  it("shows the agent's reply and what it did, and continues the same session", async () => {
    simulate.mockResolvedValueOnce(turn({ steps: [{ turn: 1, seq: 0, kind: "tool", name: "capture_field", input: { key: "email" }, output: { captured: "email" } }] }));
    render(<Playground agent={agent} onSaved={() => {}} />);
    await say("Hello");
    expect(await screen.findByText("Could you share your email?")).toBeInTheDocument();
    expect(screen.getByText(/What the agent did \(1 steps\)/)).toBeInTheDocument();
    expect(simulate).toHaveBeenLastCalledWith("a1", "Hello", undefined, { knownContacts: [], busy: [] });

    simulate.mockResolvedValueOnce(turn({ reply: "Thanks!", capturedData: { email: "a@b.co" } }));
    await say("a@b.co");
    await screen.findByText("Thanks!");
    expect(simulate).toHaveBeenLastCalledWith("a1", "a@b.co", "sess-1", expect.anything());
    expect(screen.getByRole("cell", { name: "a@b.co" })).toBeInTheDocument(); // captured panel
  });

  it("locks the input once the conversation ends, and starting over forgets the session", async () => {
    simulate.mockResolvedValueOnce(turn({ reply: "All done.", isComplete: true, outcomeType: "demo_booking" }));
    render(<Playground agent={agent} onSaved={() => {}} />);
    await say("hi");
    await screen.findByText("All done.");
    expect(screen.getByLabelText("Message")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(resetSimulation).toHaveBeenCalledWith("a1", "sess-1");
    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(screen.queryByText("All done.")).toBeNull();
  });

  it("sends the sandbox with each message", async () => {
    simulate.mockResolvedValue(turn());
    render(<Playground agent={agent} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Contacts in the pretend CRM"), { target: { value: "ada@example.com, Ada" } });
    await say("hi");
    expect(simulate).toHaveBeenLastCalledWith("a1", "hi", undefined, { knownContacts: [{ email: "ada@example.com", firstName: "Ada" }], busy: [] });
  });

  it("saves the conversation as a scenario whose expectations come from what happened", async () => {
    simulate.mockResolvedValueOnce(turn({
      reply: "You're booked.", isComplete: true, outcomeType: "demo_booking", capturedData: { email: "a@b.co" },
      steps: [{ turn: 1, seq: 0, kind: "tool", name: "book_meeting" }, { turn: 1, seq: 1, kind: "tool", name: "capture_field" }],
    }));
    const onSaved = vi.fn();
    render(<Playground agent={agent} onSaved={onSaved} />);
    await say("book me in");
    await screen.findByText("You're booked.");
    fireEvent.change(screen.getByLabelText("Scenario name"), { target: { value: "Booking" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as scenario" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![1]).toMatchObject({
      name: "Booking",
      turns: ["book me in"],
      expect: { completes: true, outcomeType: "demo_booking", capturedKeys: ["email"], toolsCalled: ["book_meeting"] },
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("shows an error from the server without losing the conversation", async () => {
    simulate.mockRejectedValueOnce(new Error("Daily simulation limit reached"));
    render(<Playground agent={agent} onSaved={() => {}} />);
    await say("hi");
    expect(await screen.findByText(/Daily simulation limit reached/)).toBeInTheDocument();
    expect(screen.getByText("hi")).toBeInTheDocument();
  });
});
