import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentSpec } from "@envoy/types";
import { AgentBehaviorEditor } from "./AgentBehaviorEditor";

const classic = AgentSpec.parse({});
const agentic = AgentSpec.parse({ runtime: { mode: "agentic" } });

describe("AgentBehaviorEditor", () => {
  it("hides agentic options in classic mode", () => {
    render(<AgentBehaviorEditor spec={classic} onChange={() => {}} />);
    expect(screen.queryByText("Goals")).toBeNull();
    expect(screen.queryByText("Tools")).toBeNull();
  });

  it("switches mode through onChange without losing the rest of the spec", () => {
    const onChange = vi.fn();
    render(<AgentBehaviorEditor spec={classic} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "agentic" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ runtime: expect.objectContaining({ mode: "agentic", maxSteps: 6 }) }));
  });

  it("adds a goal and derives a stable id from its title", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AgentBehaviorEditor spec={agentic} onChange={onChange} />);
    fireEvent.click(screen.getByText("+ Add goal"));
    const added = onChange.mock.calls[0]![0] as AgentSpec;
    expect(added.goals).toHaveLength(1);

    rerender(<AgentBehaviorEditor spec={added} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Goal 1 title"), { target: { value: "Book a demo" } });
    const renamed = onChange.mock.calls[1]![0] as AgentSpec;
    expect(renamed.goals[0]).toMatchObject({ title: "Book a demo", id: "bookADemo" });
    // The spec the editor produces always passes the shared validator.
    expect(AgentSpec.safeParse({ ...renamed, goals: [{ ...renamed.goals[0]!, successCriteria: "x" }] }).success).toBe(true);
  });

  it("does not change a goal's id when its title is edited later", () => {
    const spec = AgentSpec.parse({
      runtime: { mode: "agentic" },
      goals: [{ id: "closeSale", title: "Close the sale", successCriteria: "paid" }],
    });
    const onChange = vi.fn();
    render(<AgentBehaviorEditor spec={spec} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Goal 1 title"), { target: { value: "Win the deal" } });
    expect((onChange.mock.calls[0]![0] as AgentSpec).goals[0]!.id).toBe("closeSale");
  });

  it("locks core tools on and only records non-default tool permissions", () => {
    const onChange = vi.fn();
    render(<AgentBehaviorEditor spec={agentic} onChange={onChange} />);
    expect(screen.getByLabelText(/Capture field/, { selector: "input[type=checkbox]" })).toBeDisabled();
    expect(screen.getByLabelText(/End conversation/, { selector: "input[type=checkbox]" })).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/Hand off to a human/, { selector: "input[type=checkbox]" }));
    const disabled = onChange.mock.calls[0]![0] as AgentSpec;
    expect(disabled.tools).toEqual([{ name: "handoff_to_human", enabled: false }]);
    expect(AgentSpec.safeParse(disabled).success).toBe(true);
  });

  it("clamps step limits into the valid range", () => {
    const onChange = vi.fn();
    render(<AgentBehaviorEditor spec={agentic} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Max steps per message"), { target: { value: "99" } });
    expect((onChange.mock.calls[0]![0] as AgentSpec).runtime.maxSteps).toBe(12);
  });

  it("keeps CRM and calendar tools off by default and stores only an explicit opt-in", () => {
    const onChange = vi.fn();
    render(<AgentBehaviorEditor spec={agentic} onChange={onChange} />);
    const book = screen.getByLabelText(/Book a meeting/, { selector: "input[type=checkbox]" });
    expect(book).not.toBeChecked();

    fireEvent.click(book);
    const on = onChange.mock.calls[0]![0] as AgentSpec;
    expect(on.tools).toEqual([{ name: "book_meeting", enabled: true }]);
    expect(AgentSpec.safeParse(on).success).toBe(true);
  });

  it("drops the stored permission again when an opt-in tool goes back to its default", () => {
    const optedIn = AgentSpec.parse({ runtime: { mode: "agentic" }, tools: [{ name: "book_meeting", enabled: true }] });
    const onChange = vi.fn();
    render(<AgentBehaviorEditor spec={optedIn} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/Book a meeting/, { selector: "input[type=checkbox]" }));
    expect((onChange.mock.calls[0]![0] as AgentSpec).tools).toEqual([]);
  });
});
