import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const preview = vi.fn();
vi.mock("../../lib/api", () => ({ api: { workflows: { preview: (...a: unknown[]) => preview(...a) } } }));

import { emptyDraft } from "../../lib/workflow-editor";
import { WorkflowEditor } from "./WorkflowEditor";

const agents = [{ id: "a1", name: "Sales bot", requiredFields: [{ key: "name" }, { key: "email" }, { key: "budget" }] }] as never;
const forms = [{ id: "f1", name: "Contact", schema: { steps: [{ fields: [{ key: "company" }] }] } }] as never;
const draft = () => ({ ...emptyDraft(), settings: { ...emptyDraft().settings, timezone: "UTC" } });
const setup = (over: Record<string, unknown> = {}) => {
  const onSave = vi.fn(async (_def: unknown) => {});
  render(<WorkflowEditor initial={draft()} readOnly={false} agents={agents} forms={forms} onSave={onSave} {...over} />);
  return { onSave };
};
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("WorkflowEditor", () => {
  beforeEach(() => preview.mockReset());

  it("won't save an incomplete workflow, and says what is missing", async () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/name/i);
    expect(onSave).not.toHaveBeenCalled();
    type("Name", "Hot leads");
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/step 1/i); // the empty subject
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves a complete workflow as the exact definition the server validates", async () => {
    const { onSave } = setup();
    type("Name", "Hot leads");
    type("Subject", "Welcome {{name}}");
    type("Message", "Thanks for your interest.");
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      name: "Hot leads",
      trigger: { type: "conversation_completed" },
      conditions: { match: "all", conditions: [] },
      steps: [{ type: "send_email", to: "lead", subject: "Welcome {{name}}", body: "Thanks for your interest." }],
      settings: { emailField: "email", phoneField: "phone", exitOnReply: true },
    });
  });

  it("shows the server's reason when saving fails", async () => {
    const { onSave } = setup({ onSave: vi.fn().mockRejectedValue(new Error("A workspace can have at most 25 workflows.")) });
    void onSave;
    type("Name", "x"); type("Subject", "s"); type("Message", "b");
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    expect(await screen.findByText(/at most 25 workflows/)).toBeInTheDocument();
  });

  it("builds conditions, including on the conversation outcome", async () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    type("Condition 1 field", "budget");
    type("Condition 1 test", "gt");
    type("Condition 1 value", "5000");
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    type("Condition 2 field", "$outcome");
    type("Condition 2 value", "demo_booking");
    expect(screen.getByLabelText("Match")).toBeInTheDocument(); // appears once there are two
    type("Match", "any");
    type("Name", "n"); type("Subject", "s"); type("Message", "b");
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0]![0] as { conditions: unknown }).conditions).toEqual({
      match: "any",
      conditions: [{ field: "budget", op: "gt", value: "5000" }, { field: "$outcome", op: "equals", value: "demo_booking" }],
    });
  });

  it("offers the fields of the chosen agent as variables and inserts the one clicked into the focused box", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Which agent"), { target: { value: "a1" } });
    expect(screen.getByRole("button", { name: "{{budget}}" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "{{outcome}}" })).toBeInTheDocument();
    fireEvent.focus(screen.getByLabelText("Subject"));
    type("Subject", "Hi");
    fireEvent.click(screen.getByRole("button", { name: "{{name}}" }));
    expect(screen.getByLabelText("Subject")).toHaveValue("Hi {{name}}");
    fireEvent.focus(screen.getByLabelText("Message"));
    fireEvent.click(screen.getByRole("button", { name: "{{email}}" }));
    expect(screen.getByLabelText("Message")).toHaveValue("{{email}}");
  });

  it("switching to a form trigger offers that form's fields instead", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Trigger"), { target: { value: "form_submitted" } });
    fireEvent.change(screen.getByLabelText("Which form"), { target: { value: "f1" } });
    expect(screen.getByRole("button", { name: "{{company}}" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "{{budget}}" })).toBeNull();
  });

  it("adds, reorders and removes steps, and edits a wait", async () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: "+ Wait" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Send text message" }));
    expect(screen.getByRole("button", { name: "Remove step 1" })).toBeEnabled();
    type("Step 2 wait amount", "3");
    type("Step 2 wait unit", "hours");
    fireEvent.click(screen.getByRole("button", { name: "Move step 3 up" })); // text before the wait
    expect(screen.getByText("2. Send text message")).toBeInTheDocument();
    expect(screen.getByText("3. Wait")).toBeInTheDocument();
    type("Name", "n"); type("Subject", "s");
    fireEvent.change(document.getElementById("body-0")!, { target: { value: "b" } });
    fireEvent.change(document.getElementById("sms-1")!, { target: { value: "Hi there" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove step 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0]![0] as { steps: unknown[] }).steps).toEqual([
      { type: "send_email", to: "lead", subject: "s", body: "b" },
      { type: "send_sms", body: "Hi there" },
    ]);
  });

  it("can send a notification to your own team instead of the lead, and drops the lead footer note", () => {
    setup();
    expect(screen.getByText(/footer naming your business and an unsubscribe link/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "team" } });
    type("Step 1 team address", "sales@acme.co");
    expect(screen.queryByText(/footer naming your business/)).toBeNull();
  });

  it("warns that texting without a consent field texts everyone, and clears the warning once one is named", () => {
    setup();
    expect(screen.queryByText(/Quiet hours|quiet hours/)).toBeNull(); // no SMS step → no SMS rules
    fireEvent.click(screen.getByRole("button", { name: "+ Send text message" }));
    expect(screen.getByText(/every lead with a valid number is texted/)).toBeInTheDocument();
    expect(screen.getByText(/Texts only go to numbers written internationally/)).toBeInTheDocument();
    type(/Only text leads who ticked/, "sms_consent");
    expect(screen.queryByText(/every lead with a valid number is texted/)).toBeNull();
  });

  it("is read-only while a workflow is live", () => {
    setup({ readOnly: true });
    expect(screen.queryByRole("button", { name: "Save workflow" })).toBeNull();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "+ Wait" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled(); // you can still look
  });

  it("previews with a typed sample lead and shows what would be sent, when, and what's missing", async () => {
    preview.mockResolvedValue({
      qualifies: true,
      steps: [
        { index: 0, type: "send_email", result: "send", atMs: 0, to: "ada@example.com", subject: "Hi Ada", body: "Re {{company}}\n\n--\nUnsubscribe", missingVariables: ["company"] },
        { index: 1, type: "wait", result: "wait", atMs: 7_200_000, detail: "Wait 2 hours" },
        { index: 2, type: "send_sms", result: "skip", atMs: 7_200_000, detail: "No SMS consent" },
      ],
    });
    setup();
    type("Name", "n"); type("Subject", "s"); type("Message", "b");
    type("Sample lead", "name = Ada\nbudget = 9000");
    type("Sample outcome", "demo_booking");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByLabelText("Preview result");
    expect(preview.mock.calls[0]![1]).toEqual({ data: { name: "Ada", budget: 9000 }, outcome: "demo_booking" });
    expect(screen.getByText("qualifies")).toBeInTheDocument();
    expect(screen.getByText("right away")).toBeInTheDocument();
    expect(screen.getAllByText("after 2 hours")).toHaveLength(2);
    expect(screen.getByText(/ada@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/no value for {{company}}/)).toBeInTheDocument();
    expect(screen.getByText(/skipped: No SMS consent/)).toBeInTheDocument();
  });

  it("won't preview an invalid workflow", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(preview).not.toHaveBeenCalled();
  });

  describe("conditional steps", () => {
    const fill = () => { type("Name", "Branchy"); type("Subject", "VIP offer"); type("Message", "Hi"); };

    it("gives a step an “only if…” condition and saves it on that step only", async () => {
      const { onSave } = setup();
      fill();
      fireEvent.click(screen.getByRole("button", { name: "+ Only if…" }));
      expect(screen.getByText("Only do this if the lead…")).toBeInTheDocument();
      type("Step 1 condition 1 field", "budget");
      fireEvent.change(screen.getByLabelText("Step 1 condition 1 test"), { target: { value: "gt" } });
      type("Step 1 condition 1 value", "5000");
      fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      const def = onSave.mock.calls[0]![0] as { conditions: { conditions: unknown[] }; steps: Array<{ when?: unknown }> };
      expect(def.steps[0]!.when).toEqual({ match: "all", conditions: [{ field: "budget", op: "gt", value: "5000" }] });
      expect(def.conditions.conditions).toEqual([]); // the workflow's own entry conditions are untouched
    });

    it("removing a step's last condition makes it unconditional again", () => {
      setup();
      fireEvent.click(screen.getByRole("button", { name: "+ Only if…" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove step 1 condition 1" }));
      expect(screen.queryByText("Only do this if the lead…")).toBeNull();
      expect(screen.getByRole("button", { name: "+ Only if…" })).toBeInTheDocument();
    });

    it("adds an “end here” step, which comes with a condition and needs it filled in", async () => {
      const { onSave } = setup();
      fill();
      fireEvent.click(screen.getByRole("button", { name: "+ End here" }));
      expect(screen.getByText("2. End here")).toBeInTheDocument();
      expect(screen.getByText("End the sequence here if the lead…")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
      expect(await screen.findByRole("alert")).toBeInTheDocument(); // empty field
      expect(onSave).not.toHaveBeenCalled();
      type("Step 2 condition 1 field", "$outcome");
      type("Step 2 condition 1 value", "complaint");
      fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      expect((onSave.mock.calls[0]![0] as { steps: unknown[] }).steps[1]).toEqual({ type: "exit", when: { match: "all", conditions: [{ field: "$outcome", op: "equals", value: "complaint" }] } });
    });

    it("an “end here” step can't lose its condition entirely", () => {
      setup();
      fireEvent.click(screen.getByRole("button", { name: "+ End here" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove step 2 condition 1" }));
      expect(screen.getByText("End the sequence here if the lead…")).toBeInTheDocument(); // still there, now empty; saving will say why
    });

    it("previews which branch is skipped and where a lead's sequence ends", async () => {
      preview.mockResolvedValue({ qualifies: true, steps: [
        { index: 0, type: "send_email", result: "skip", atMs: 0, detail: "Condition not met: budget is more than 5000" },
        { index: 1, type: "exit", result: "end", atMs: 0, detail: "Ends here: outcome is complaint" },
      ] });
      setup();
      fill();
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      const out = await screen.findByLabelText("Preview result");
      expect(out).toHaveTextContent("Send email skipped: Condition not met: budget is more than 5000");
      expect(out).toHaveTextContent("ends");
      expect(out).toHaveTextContent("Ends here: outcome is complaint");
      expect(out).not.toHaveTextContent("End here skipped");
    });
  });
});
