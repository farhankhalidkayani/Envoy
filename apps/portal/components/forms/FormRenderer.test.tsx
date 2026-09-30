import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicFormSchema } from "@envoy/types";
import { FormRenderer, type SubmitResult } from "./FormRenderer";

const schema: PublicFormSchema = {
  steps: [
    {
      id: "s1",
      fields: [
        { id: "f1", key: "name", type: "text", label: "Name", required: true },
        {
          id: "f2",
          key: "interests",
          type: "multiselect",
          label: "Interests",
          required: false,
          options: [
            { label: "Sales", value: "sales" },
            { label: "Support", value: "support" },
          ],
        },
        {
          id: "f3",
          key: "utm_source",
          type: "hidden",
          label: "UTM source",
          required: false,
          hiddenSource: { queryParam: "utm_source", defaultValue: "direct" },
        },
        { id: "f4", key: "note", type: "content", label: "Note", required: false, content: "We reply within 24 hours." },
      ],
    },
  ],
  submitLabel: "Send",
  successMessage: "Thanks!",
};

function setUrl(search: string) {
  window.history.pushState({}, "", `/f/test${search}`);
}

describe("FormRenderer", () => {
  beforeEach(() => setUrl(""));
  afterEach(() => setUrl(""));

  it("renders a content block as static text, never as an input", () => {
    render(<FormRenderer schema={schema} loadOptions={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByText("We reply within 24 hours.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Note")).not.toBeInTheDocument();
  });

  it("never renders the hidden field as a visible input", () => {
    render(<FormRenderer schema={schema} loadOptions={vi.fn()} onSubmit={vi.fn()} />);
    expect(document.querySelector('input[name="utm_source"]')).not.toBeInTheDocument();
  });

  it("renders multiselect options as checkboxes and toggles them into an array on submit", async () => {
    const onSubmit = vi.fn<(values: Record<string, unknown>) => Promise<SubmitResult>>(async (values) => {
      expect(values.interests).toEqual(["sales", "support"]);
      return { ok: true, successMessage: "Thanks!" };
    });
    render(<FormRenderer schema={schema} loadOptions={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Jane" } });
    fireEvent.click(screen.getByLabelText("Sales"));
    fireEvent.click(screen.getByLabelText("Support"));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("captures the hidden field's value from the page's URL query param on submit", async () => {
    setUrl("?utm_source=newsletter");
    const onSubmit = vi.fn<(values: Record<string, unknown>) => Promise<SubmitResult>>(async (values) => {
      expect(values.utm_source).toBe("newsletter");
      return { ok: true, successMessage: "Thanks!" };
    });
    render(<FormRenderer schema={schema} loadOptions={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Jane" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("falls back to the hidden field's default value when the URL has no query param", async () => {
    const onSubmit = vi.fn<(values: Record<string, unknown>) => Promise<SubmitResult>>(async (values) => {
      expect(values.utm_source).toBe("direct");
      return { ok: true, successMessage: "Thanks!" };
    });
    render(<FormRenderer schema={schema} loadOptions={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Jane" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("blocks submission and shows an error when a required field is empty", async () => {
    const onSubmit = vi.fn();
    render(<FormRenderer schema={schema} loadOptions={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("This field is required")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the success message and hides the form after a successful submit", async () => {
    const onSubmit = vi.fn<(values: Record<string, unknown>) => Promise<SubmitResult>>(async () => ({
      ok: true,
      successMessage: "We'll be in touch!",
    }));
    render(<FormRenderer schema={schema} loadOptions={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Jane" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("We'll be in touch!")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Name/)).not.toBeInTheDocument();
  });
});
