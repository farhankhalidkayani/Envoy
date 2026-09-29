"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Active,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Over,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  findBlock,
  findContainerIndex,
  insertBlock,
  moveBlock,
  moveContainer,
  removeBlock,
  updateBlock,
  type BuilderAdapter,
} from "./tree";

export interface PaletteItem<B> {
  type: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  group?: string;
  create(): B;
}

export type Selection<C, B> =
  | { kind: "block"; block: B; container: C; containerIndex: number; blockIndex: number }
  | { kind: "container"; container: C; containerIndex: number }
  | null;

export interface BuilderApi<C, B> {
  updateBlock(blockId: string, update: (block: B) => B): void;
  updateContainer(containerId: string, update: (container: C) => C): void;
  removeBlock(blockId: string): void;
  removeContainer(containerId: string): void;
  duplicateBlock(blockId: string): void;
  select(target: { kind: "block" | "container"; id: string } | null): void;
}

export interface BlockBuilderProps<C, B> {
  adapter: BuilderAdapter<C, B>;
  containers: C[];
  onChange(containers: C[]): void;
  palette: PaletteItem<B>[];
  /** Canvas preview of a block (not interactive — clicks select it). */
  renderBlock(block: B): ReactNode;
  renderContainerHeader(container: C, index: number): ReactNode;
  renderInspector(selection: Selection<C, B>, api: BuilderApi<C, B>): ReactNode;
  createContainer(): C;
  /** Copy of a block with fresh ids/keys — domain-specific, so the caller supplies it. */
  cloneBlock(block: B): B;
  blockLabel(block: B): string;
  containerNoun?: string;
  paletteTitle?: string;
  /** Error text per block/container id, shown as a badge on the canvas. */
  issues?: Record<string, string>;
  /**
   * For a single fixed container (e.g. one flat, orderable list — no
   * multi-container structure like form steps): hides the container header
   * chrome (title, drag handle, delete) and the "+ Add {noun}" button.
   * `containers` should have exactly one entry.
   */
  fixedContainers?: boolean;
}

type DragKind = "palette" | "block" | "container" | "body";
const PALETTE = "palette:";
const CONTAINER = "container:";
const BODY = "body:";

const kindOf = (x: Active | Over | null | undefined): DragKind | undefined =>
  (x?.data.current as { kind?: DragKind } | undefined)?.kind;

/**
 * Registry-driven visual builder: a palette of block types, a canvas of
 * sortable containers holding sortable blocks, and an inspector for the
 * selection. Knows nothing about forms — the adapter + render props supply
 * all domain behaviour, which is what lets the widget builder reuse it.
 *
 * Keyboard: Tab to a block or palette item, Space to pick up, arrows to
 * move, Space to drop, Escape to cancel. Enter on a palette item appends it
 * to the selected (or last) container; Delete on a focused block removes it.
 */
export function BlockBuilder<C, B>(props: BlockBuilderProps<C, B>) {
  const { adapter: a, containers, onChange, palette } = props;
  const [selected, setSelected] = useState<{ kind: "block" | "container"; id: string } | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const snapshot = useRef<C[] | null>(null);
  const dragStartContainer = useRef<string | null>(null);
  // dnd-kit handlers can fire several times between renders (dragOver);
  // read the freshest tree rather than a stale closure.
  const latest = useRef(containers);
  latest.current = containers;
  const commit = (next: C[]) => {
    latest.current = next;
    onChange(next);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), // so a click still selects
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const selection: Selection<C, B> = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === "container") {
      const ci = findContainerIndex(a, containers, selected.id);
      return ci === -1 ? null : { kind: "container", container: containers[ci]!, containerIndex: ci };
    }
    const loc = findBlock(a, containers, selected.id);
    if (!loc) return null;
    const container = containers[loc.containerIndex]!;
    return { kind: "block", block: a.blocks(container)[loc.blockIndex]!, container, ...loc };
  }, [a, containers, selected]);

  const api: BuilderApi<C, B> = {
    updateBlock: (id, update) => commit(updateBlock(a, latest.current, id, update)),
    updateContainer: (id, update) => commit(latest.current.map((c) => (a.containerId(c) === id ? update(c) : c))),
    removeBlock: (id) => {
      commit(removeBlock(a, latest.current, id));
      if (selected?.id === id) setSelected(null);
    },
    removeContainer: (id) => {
      if (latest.current.length <= 1) return;
      commit(latest.current.filter((c) => a.containerId(c) !== id));
      if (selected?.id === id) setSelected(null);
    },
    duplicateBlock: (id) => {
      const loc = findBlock(a, latest.current, id);
      if (!loc) return;
      const container = latest.current[loc.containerIndex]!;
      const copy = props.cloneBlock(a.blocks(container)[loc.blockIndex]!);
      commit(insertBlock(a, latest.current, copy, a.containerId(container), loc.blockIndex + 1));
      setSelected({ kind: "block", id: a.blockId(copy) });
    },
    select: setSelected,
  };

  function containerIdForOver(over: Over): string | null {
    const id = String(over.id);
    if (kindOf(over) === "body") return id.slice(BODY.length);
    if (kindOf(over) === "container") return id.slice(CONTAINER.length);
    const loc = findBlock(a, latest.current, id);
    return loc ? a.containerId(latest.current[loc.containerIndex]!) : null;
  }

  /** Index to insert at when dropping over `over`: before a block, or after it if the pointer is past its middle. */
  function insertionIndex(over: Over, activeNode: Active): number {
    const cid = containerIdForOver(over)!;
    const blocks = a.blocks(latest.current[findContainerIndex(a, latest.current, cid)]!);
    if (kindOf(over) !== "block") return blocks.length;
    const idx = blocks.findIndex((b) => a.blockId(b) === String(over.id));
    const dragged = activeNode.rect.current.translated;
    const below = dragged ? dragged.top + dragged.height / 2 > over.rect.top + over.rect.height / 2 : false;
    return idx + (below ? 1 : 0);
  }

  const collisionDetection: CollisionDetection = (args) => {
    const dragging = kindOf(args.active);
    const droppableContainers = args.droppableContainers.filter((d) => {
      const k = (d.data.current as { kind?: DragKind } | undefined)?.kind;
      return dragging === "container" ? k === "container" : k === "block" || k === "body";
    });
    const scoped = { ...args, droppableContainers };
    const hits = pointerWithin(scoped);
    // A block sits inside its container's body, so the pointer is "within"
    // both — the block is the more specific target.
    const blockHits = hits.filter((h) => droppableContainers.find((d) => d.id === h.id)?.data.current?.kind === "block");
    if (blockHits.length) return blockHits;
    return hits.length ? hits : closestCenter(scoped);
  };

  function onDragStart(e: DragStartEvent) {
    snapshot.current = latest.current;
    const loc = findBlock(a, latest.current, String(e.active.id));
    dragStartContainer.current = loc ? a.containerId(latest.current[loc.containerIndex]!) : null;
    setActive(e.active);
  }

  function onDragOver(e: DragOverEvent) {
    // Blocks hop containers live while dragging so the target list opens a
    // gap under the pointer; same-container reorders settle on drop.
    if (kindOf(e.active) !== "block" || !e.over) return;
    const toCid = containerIdForOver(e.over);
    const from = findBlock(a, latest.current, String(e.active.id));
    if (!toCid || !from || a.containerId(latest.current[from.containerIndex]!) === toCid) return;
    commit(moveBlock(a, latest.current, String(e.active.id), toCid, insertionIndex(e.over, e.active)));
  }

  function onDragEnd(e: DragEndEvent) {
    setActive(null);
    snapshot.current = null;
    const { active: act, over } = e;
    if (!over) return;
    const kind = kindOf(act);

    if (kind === "container") {
      const from = findContainerIndex(a, latest.current, String(act.id).slice(CONTAINER.length));
      const to = findContainerIndex(a, latest.current, String(over.id).slice(CONTAINER.length));
      commit(moveContainer(latest.current, from, to));
      return;
    }

    const toCid = containerIdForOver(over);
    if (!toCid) return;

    if (kind === "palette") {
      const item = palette.find((p) => p.type === String(act.id).slice(PALETTE.length));
      if (!item) return;
      const block = item.create();
      commit(insertBlock(a, latest.current, block, toCid, insertionIndex(over, act)));
      setSelected({ kind: "block", id: a.blockId(block) });
      return;
    }

    // A block that hopped containers was already placed by onDragOver using
    // the pointer position; re-applying a same-list reorder here would use
    // pre-hop rects and shift it by one.
    const from = findBlock(a, latest.current, String(act.id));
    const hopped = from && a.containerId(latest.current[from.containerIndex]!) !== dragStartContainer.current;
    if (kind === "block" && !hopped && kindOf(over) === "block" && over.id !== act.id) {
      const target = findBlock(a, latest.current, String(over.id));
      if (target) commit(moveBlock(a, latest.current, String(act.id), toCid, target.blockIndex));
    }
  }

  function onDragCancel() {
    if (snapshot.current) commit(snapshot.current);
    snapshot.current = null;
    setActive(null);
  }

  function addFromPalette(item: PaletteItem<B>) {
    const target =
      selection?.container ?? (latest.current.length ? latest.current[latest.current.length - 1] : undefined);
    if (!target) return;
    const block = item.create();
    commit(insertBlock(a, latest.current, block, a.containerId(target)));
    setSelected({ kind: "block", id: a.blockId(block) });
  }

  function labelFor(id: string | number): string {
    const s = String(id);
    if (s.startsWith(PALETTE)) return `new ${palette.find((p) => PALETTE + p.type === s)?.label ?? "block"}`;
    if (s.startsWith(CONTAINER) || s.startsWith(BODY)) {
      const ci = findContainerIndex(a, latest.current, s.replace(CONTAINER, "").replace(BODY, ""));
      return `${props.containerNoun ?? "section"} ${ci + 1}`;
    }
    const loc = findBlock(a, latest.current, s);
    return loc ? props.blockLabel(a.blocks(latest.current[loc.containerIndex]!)[loc.blockIndex]!) : "item";
  }
  const announcements: Announcements = {
    onDragStart: ({ active: x }) => `Picked up ${labelFor(x.id)}.`,
    onDragOver: ({ active: x, over }) => (over ? `${labelFor(x.id)} is over ${labelFor(over.id)}.` : `${labelFor(x.id)} is not over a drop target.`),
    onDragEnd: ({ active: x, over }) => (over ? `Dropped ${labelFor(x.id)} at ${labelFor(over.id)}.` : `Dropped ${labelFor(x.id)}.`),
    onDragCancel: ({ active: x }) => `Cancelled moving ${labelFor(x.id)}.`,
  };

  const groups = useMemo(() => {
    const map = new Map<string, PaletteItem<B>[]>();
    for (const item of palette) map.set(item.group ?? "", [...(map.get(item.group ?? "") ?? []), item]);
    return [...map.entries()];
  }, [palette]);

  const activeBlock = active && kindOf(active) === "block" ? findBlock(a, containers, String(active.id)) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
      accessibility={{ announcements }}
    >
      <div className="eb-root">
        <aside className="eb-palette" aria-label={props.paletteTitle ?? "Blocks"}>
          <div className="eb-pane-title">{props.paletteTitle ?? "Blocks"}</div>
          {groups.map(([group, items]) => (
            <div key={group} className="eb-palette-group">
              {group && <div className="eb-palette-group-title">{group}</div>}
              {items.map((item) => (
                <PaletteButton key={item.type} item={item} onAdd={() => addFromPalette(item)} />
              ))}
            </div>
          ))}
        </aside>

        <section className="eb-canvas" aria-label="Canvas">
          <SortableContext
            items={containers.map((c) => CONTAINER + a.containerId(c))}
            strategy={verticalListSortingStrategy}
          >
            {containers.map((container, ci) => (
              <SortableContainer
                key={a.containerId(container)}
                id={a.containerId(container)}
                selected={selected?.kind === "container" && selected.id === a.containerId(container)}
                issue={props.issues?.[a.containerId(container)]}
                header={props.renderContainerHeader(container, ci)}
                noun={props.containerNoun ?? "section"}
                canDelete={containers.length > 1}
                hideChrome={props.fixedContainers}
                onSelect={() => setSelected({ kind: "container", id: a.containerId(container) })}
                onDelete={() => api.removeContainer(a.containerId(container))}
              >
                <SortableContext
                  items={a.blocks(container).map((b) => a.blockId(b))}
                  strategy={verticalListSortingStrategy}
                >
                  {a.blocks(container).map((block) => (
                    <SortableBlock
                      key={a.blockId(block)}
                      id={a.blockId(block)}
                      label={props.blockLabel(block)}
                      selected={selected?.kind === "block" && selected.id === a.blockId(block)}
                      issue={props.issues?.[a.blockId(block)]}
                      onSelect={() => setSelected({ kind: "block", id: a.blockId(block) })}
                      onDuplicate={() => api.duplicateBlock(a.blockId(block))}
                      onDelete={() => api.removeBlock(a.blockId(block))}
                    >
                      {props.renderBlock(block)}
                    </SortableBlock>
                  ))}
                </SortableContext>
              </SortableContainer>
            ))}
          </SortableContext>
          {!props.fixedContainers && (
            <button
              type="button"
              className="eb-add-container"
              onClick={() => {
                const c = props.createContainer();
                commit([...latest.current, c]);
                setSelected({ kind: "container", id: a.containerId(c) });
              }}
            >
              + Add {props.containerNoun ?? "section"}
            </button>
          )}
        </section>

        <aside className="eb-inspector" aria-label="Inspector">
          {props.renderInspector(selection, api)}
        </aside>
      </div>

      <DragOverlay dropAnimation={null}>
        {active && kindOf(active) === "palette" ? (
          <div className="eb-overlay">{labelFor(active.id)}</div>
        ) : activeBlock ? (
          <div className="eb-overlay eb-block">
            {props.renderBlock(a.blocks(containers[activeBlock.containerIndex]!)[activeBlock.blockIndex]!)}
          </div>
        ) : active && kindOf(active) === "container" ? (
          <div className="eb-overlay">{labelFor(active.id)}</div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function PaletteButton<B>({ item, onAdd }: { item: PaletteItem<B>; onAdd(): void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: PALETTE + item.type,
    data: { kind: "palette" },
  });
  return (
    <button
      type="button"
      ref={setNodeRef}
      className={`eb-palette-item${isDragging ? " eb-dragging" : ""}`}
      {...attributes}
      {...listeners}
      onClick={onAdd}
      title={item.description}
      aria-label={`${item.label} — drag onto the canvas, or press Enter to add`}
    >
      {item.icon && <span className="eb-palette-icon">{item.icon}</span>}
      <span>{item.label}</span>
    </button>
  );
}

function SortableContainer(props: {
  id: string;
  selected: boolean;
  issue?: string;
  header: ReactNode;
  noun: string;
  canDelete: boolean;
  hideChrome?: boolean;
  onSelect(): void;
  onDelete(): void;
  children: ReactNode;
}) {
  const sortable = useSortable({ id: CONTAINER + props.id, data: { kind: "container" } });
  const body = useDroppable({ id: BODY + props.id, data: { kind: "body" } });
  const style = { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={`eb-container${props.hideChrome ? " eb-bare" : ""}${props.selected ? " eb-selected" : ""}${sortable.isDragging ? " eb-dragging" : ""}`}
    >
      {!props.hideChrome && (
        <div className="eb-container-header" onClick={props.onSelect}>
          <button
            type="button"
            className="eb-handle"
            aria-label={`Reorder ${props.noun}`}
            {...sortable.attributes}
            {...sortable.listeners}
            onClick={(e) => e.stopPropagation()}
          >
            ⋮⋮
          </button>
          <div className="eb-container-title">{props.header}</div>
          {props.issue && <span className="eb-issue" title={props.issue}>!</span>}
          {props.canDelete && (
            <button
              type="button"
              className="eb-icon-btn"
              aria-label={`Delete ${props.noun}`}
              onClick={(e) => {
                e.stopPropagation();
                props.onDelete();
              }}
            >
              ✕
            </button>
          )}
        </div>
      )}
      <div ref={body.setNodeRef} className={`eb-container-body${body.isOver ? " eb-over" : ""}`}>
        {props.children}
        <div className="eb-drop-hint">Drop blocks here</div>
      </div>
    </div>
  );
}

function SortableBlock(props: {
  id: string;
  label: string;
  selected: boolean;
  issue?: string;
  onSelect(): void;
  onDuplicate(): void;
  onDelete(): void;
  children: ReactNode;
}) {
  // role=group, not dnd-kit's default role=button: the card contains its own buttons.
  const s = useSortable({
    id: props.id,
    data: { kind: "block" },
    attributes: { role: "group", roleDescription: "draggable block" },
  });
  const style = { transform: CSS.Translate.toString(s.transform), transition: s.transition };
  return (
    <div
      ref={s.setNodeRef}
      style={style}
      className={`eb-block${props.selected ? " eb-selected" : ""}${s.isDragging ? " eb-dragging" : ""}${props.issue ? " eb-has-issue" : ""}`}
      {...s.attributes}
      {...s.listeners}
      aria-label={`${props.label}. Press Space to move, Enter to edit, Delete to remove.`}
      aria-current={props.selected ? "true" : undefined}
      onClick={props.onSelect}
      onKeyDown={(e) => {
        s.listeners?.onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter") props.onSelect();
        if (e.key === "Delete" || e.key === "Backspace") props.onDelete();
      }}
    >
      <div className="eb-block-content">{props.children}</div>
      {props.issue && <div className="eb-block-issue">{props.issue}</div>}
      <div className="eb-block-actions">
        <button
          type="button"
          className="eb-icon-btn"
          aria-label={`Duplicate ${props.label}`}
          onClick={(e) => {
            e.stopPropagation();
            props.onDuplicate();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          ⧉
        </button>
        <button
          type="button"
          className="eb-icon-btn"
          aria-label={`Delete ${props.label}`}
          onClick={(e) => {
            e.stopPropagation();
            props.onDelete();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
