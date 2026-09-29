/**
 * The builder edits an ordered list of containers (form steps, widget
 * sections, ...) each holding an ordered list of blocks (fields, widget
 * elements, ...). The adapter maps the caller's own domain types onto that
 * shape, so the builder never needs to know what a "step" or "field" is.
 */
export interface BuilderAdapter<C, B> {
  containerId(container: C): string;
  blockId(block: B): string;
  blocks(container: C): B[];
  withBlocks(container: C, blocks: B[]): C;
}

export interface BlockLocation {
  containerIndex: number;
  blockIndex: number;
}

export function findBlock<C, B>(a: BuilderAdapter<C, B>, containers: C[], blockId: string): BlockLocation | null {
  for (let ci = 0; ci < containers.length; ci++) {
    const bi = a.blocks(containers[ci]!).findIndex((b) => a.blockId(b) === blockId);
    if (bi !== -1) return { containerIndex: ci, blockIndex: bi };
  }
  return null;
}

export function findContainerIndex<C, B>(a: BuilderAdapter<C, B>, containers: C[], containerId: string): number {
  return containers.findIndex((c) => a.containerId(c) === containerId);
}

function arrayMove<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function moveContainer<C>(containers: C[], from: number, to: number): C[] {
  if (from === to || from < 0 || to < 0 || from >= containers.length || to >= containers.length) return containers;
  return arrayMove(containers, from, to);
}

/** Inserts `block` into the container at `index` (clamped; omitted = append). */
export function insertBlock<C, B>(
  a: BuilderAdapter<C, B>,
  containers: C[],
  block: B,
  containerId: string,
  index?: number,
): C[] {
  return containers.map((c) => {
    if (a.containerId(c) !== containerId) return c;
    const blocks = a.blocks(c).slice();
    const at = index === undefined ? blocks.length : Math.max(0, Math.min(index, blocks.length));
    blocks.splice(at, 0, block);
    return a.withBlocks(c, blocks);
  });
}

export function removeBlock<C, B>(a: BuilderAdapter<C, B>, containers: C[], blockId: string): C[] {
  return containers.map((c) => {
    const blocks = a.blocks(c);
    const next = blocks.filter((b) => a.blockId(b) !== blockId);
    return next.length === blocks.length ? c : a.withBlocks(c, next);
  });
}

/**
 * Moves a block to `index` within `containerId` — same container (reorder)
 * or another one. `index` is the position in the destination list as it
 * looks BEFORE the move, matching what the pointer was over.
 */
export function moveBlock<C, B>(
  a: BuilderAdapter<C, B>,
  containers: C[],
  blockId: string,
  containerId: string,
  index: number,
): C[] {
  const from = findBlock(a, containers, blockId);
  const toCi = findContainerIndex(a, containers, containerId);
  if (!from || toCi === -1) return containers;

  if (from.containerIndex === toCi) {
    const blocks = a.blocks(containers[toCi]!);
    const to = Math.max(0, Math.min(index, blocks.length - 1));
    if (to === from.blockIndex) return containers;
    return containers.map((c, i) => (i === toCi ? a.withBlocks(c, arrayMove(blocks, from.blockIndex, to)) : c));
  }

  const block = a.blocks(containers[from.containerIndex]!)[from.blockIndex]!;
  return insertBlock(a, removeBlock(a, containers, blockId), block, containerId, index);
}

export function updateBlock<C, B>(a: BuilderAdapter<C, B>, containers: C[], blockId: string, update: (b: B) => B): C[] {
  return containers.map((c) => {
    const blocks = a.blocks(c);
    const i = blocks.findIndex((b) => a.blockId(b) === blockId);
    if (i === -1) return c;
    const next = blocks.slice();
    next[i] = update(blocks[i]!);
    return a.withBlocks(c, next);
  });
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
