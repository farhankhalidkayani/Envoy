import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { BlockBuilder, type PaletteItem } from "./BlockBuilder.js";
import type { BuilderAdapter } from "./tree.js";

afterEach(cleanup);

interface Block {
  id: string;
  label: string;
}
interface Container {
  id: string;
  blocks: Block[];
}

const adapter: BuilderAdapter<Container, Block> = {
  containerId: (c) => c.id,
  blockId: (b) => b.id,
  blocks: (c) => c.blocks,
  withBlocks: (c, blocks) => ({ ...c, blocks }),
};

let nextId = 0;
const palette: PaletteItem<Block>[] = [
  { type: "text", label: "Text block", create: () => ({ id: `b${nextId++}`, label: "Text block" }) },
];

function Harness() {
  const [containers, setContainers] = useState<Container[]>([{ id: "c1", blocks: [] }]);
  return (
    <BlockBuilder<Container, Block>
      adapter={adapter}
      containers={containers}
      onChange={setContainers}
      palette={palette}
      renderBlock={(b) => <span>{b.label}</span>}
      renderContainerHeader={() => <span>Step</span>}
      renderInspector={() => <div>Inspector</div>}
      createContainer={() => ({ id: `c${nextId++}`, blocks: [] })}
      cloneBlock={(b) => ({ ...b, id: `b${nextId++}` })}
      blockLabel={(b) => b.label}
      fixedContainers
    />
  );
}

// The palette button's own label text also reads "Text block", so scope
// content assertions to the canvas region to count only rendered blocks.
function canvas() {
  return within(screen.getByRole("region", { name: "Canvas" }));
}

describe("BlockBuilder undo/redo", () => {
  it("undo/redo buttons start disabled, and adding a block enables Undo", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /text block/i }));
    expect(canvas().getAllByText("Text block")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("Undo reverts the last settled edit, Redo re-applies it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /text block/i }));
    expect(canvas().getAllByText("Text block")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(canvas().queryByText("Text block")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(canvas().getAllByText("Text block")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  it("a new edit after undoing clears the redo stack", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /text block/i })); // add #1
    fireEvent.click(screen.getByRole("button", { name: "Undo" })); // back to empty
    fireEvent.click(screen.getByRole("button", { name: /text block/i })); // add #2 (a fresh edit)
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  it("Cmd+Z undoes when focus is on the canvas, but is ignored while typing in an input", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /text block/i }));
    expect(canvas().getAllByText("Text block")).toHaveLength(1);

    // Ignored: keydown target is a text input (native undo should own this keystroke instead).
    const probe = document.createElement("input");
    document.body.appendChild(probe);
    fireEvent.keyDown(probe, { key: "z", metaKey: true });
    expect(canvas().getAllByText("Text block")).toHaveLength(1);
    probe.remove();

    // Handled: keydown target is not an editable field.
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(canvas().queryByText("Text block")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
    expect(canvas().getAllByText("Text block")).toHaveLength(1);
  });

  it("deleting a block is one undo step", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /text block/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete Text block/ }));
    expect(canvas().queryByText("Text block")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(canvas().getAllByText("Text block")).toHaveLength(1);
  });
});
