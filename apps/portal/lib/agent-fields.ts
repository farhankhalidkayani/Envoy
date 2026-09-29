import { newId, type BuilderAdapter, type PaletteItem } from "@envoy/builder";
import type { RequiredFieldType } from "@envoy/types";

/** requiredFields as authored in the portal — `id` is a client-only key for the builder, never sent to the API. */
export interface FieldRow {
  id: string;
  key: string;
  label: string;
  type: RequiredFieldType;
  required: boolean;
  prompt: string;
  options: string[];
}

export interface FieldRowContainer {
  id: "required-fields";
  items: FieldRow[];
}

export const fieldRowAdapter: BuilderAdapter<FieldRowContainer, FieldRow> = {
  containerId: (c) => c.id,
  blockId: (f) => f.id,
  blocks: (c) => c.items,
  withBlocks: (c, items) => ({ ...c, items }),
};

export const FIELD_TYPE_LABELS: Record<RequiredFieldType, string> = {
  text: "Text",
  email: "Email",
  phone: "Phone",
  number: "Number",
  date: "Date",
  select: "Dropdown",
  boolean: "Yes / No",
};

export function newFieldRow(): FieldRow {
  return { id: newId("fld"), key: "", label: "", type: "text", required: true, prompt: "", options: [] };
}

export function cloneFieldRow(f: FieldRow): FieldRow {
  return { ...f, id: newId("fld") };
}

export const FIELD_ROW_PALETTE: PaletteItem<FieldRow>[] = [
  { type: "field", label: "Required field", icon: "＋", create: newFieldRow },
];
