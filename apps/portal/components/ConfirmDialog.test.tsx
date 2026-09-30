import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

function setup(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ConfirmDialog
      open
      title="Delete this?"
      description="This can't be undone."
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel, ...utils };
}

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    render(<ConfirmDialog open={false} title="x" description="y" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows the title and description, and focuses the confirm button", () => {
    setup();
    expect(screen.getByText("Delete this?")).toBeInTheDocument();
    expect(screen.getByText("This can't be undone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
  });

  it("uses custom labels and the danger style when given", () => {
    setup({ confirmLabel: "Delete forever", cancelLabel: "Never mind", danger: true });
    const confirmBtn = screen.getByRole("button", { name: "Delete forever" });
    expect(confirmBtn).toHaveClass("btn-danger");
    expect(screen.getByRole("button", { name: "Never mind" })).toBeInTheDocument();
  });

  it("calls onConfirm when the confirm button is clicked", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the cancel button, the overlay, or Escape is used — but not a click inside the panel", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Delete this?")); // inside the panel
    expect(onCancel).toHaveBeenCalledTimes(1); // unchanged

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("disables both buttons and shows a busy label on the confirm button while busy", () => {
    setup({ busy: true });
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
