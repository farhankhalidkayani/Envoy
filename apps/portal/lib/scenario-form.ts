import { BUILT_IN_TOOL_NAMES, ScenarioDef, type BuiltInToolName, type OutcomeType } from "@envoy/types";

export type ToolRule = "any" | "must" | "never";
type Tri = "" | "yes" | "no";

/** The scenario editor's state: everything is text or a simple choice, converted to/from the real ScenarioDef here. */
export interface ScenarioForm {
  name: string;
  /** One visitor message per line. */
  turns: string;
  completes: Tri;
  outcomeType: "" | OutcomeType;
  handoff: Tri;
  /** Comma-separated field keys. */
  capturedKeys: string;
  /** One `key = value` per line. */
  capturedEquals: string;
  replyContains: string;
  replyNotContains: string;
  toolRules: Partial<Record<BuiltInToolName, ToolRule>>;
  goalsAchieved: string[];
  minBlocked: string;
  maxBlocked: string;
  maxTurns: string;
  /** One `email, first name` per line. */
  knownContacts: string;
  /** One `start, end` (ISO 8601) per line. */
  busy: string;
}

export const emptyScenarioForm = (): ScenarioForm => ({
  name: "", turns: "", completes: "", outcomeType: "", handoff: "", capturedKeys: "", capturedEquals: "",
  replyContains: "", replyNotContains: "", toolRules: {}, goalsAchieved: [], minBlocked: "", maxBlocked: "", maxTurns: "",
  knownContacts: "", busy: "",
});

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const list = (text: string) => text.split(/[,\n]/).map((l) => l.trim()).filter(Boolean);
const tri = (v: Tri): boolean | undefined => (v === "" ? undefined : v === "yes");
const int = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));
const fromTri = (v: boolean | undefined): Tri => (v === undefined ? "" : v ? "yes" : "no");

/** The sandbox text format, shared by the scenario editor and the playground. */
export function parseSandbox(knownContacts: string, busy: string) {
  return {
    knownContacts: lines(knownContacts).map((l) => {
      const [email = "", ...name] = l.split(",");
      return { email: email.trim(), firstName: name.join(",").trim() || undefined };
    }),
    busy: lines(busy).map((l) => {
      const [start = "", end = ""] = l.split(",");
      return { start: start.trim(), end: end.trim() };
    }),
  };
}

export function formToDef(form: ScenarioForm): { ok: true; def: ScenarioDef } | { ok: false; error: string } {
  const capturedEquals = Object.fromEntries(
    lines(form.capturedEquals).flatMap((l) => {
      const i = l.indexOf("=");
      return i > 0 ? [[l.slice(0, i).trim(), l.slice(i + 1).trim()] as const] : [];
    }),
  );
  const toolsCalled = BUILT_IN_TOOL_NAMES.filter((t) => form.toolRules[t] === "must");
  const toolsNotCalled = BUILT_IN_TOOL_NAMES.filter((t) => form.toolRules[t] === "never");

  const parsed = ScenarioDef.safeParse({
    name: form.name,
    turns: lines(form.turns),
    expect: {
      completes: tri(form.completes),
      outcomeType: form.outcomeType || undefined,
      handoff: tri(form.handoff),
      capturedEquals: Object.keys(capturedEquals).length ? capturedEquals : undefined,
      capturedKeys: list(form.capturedKeys).length ? list(form.capturedKeys) : undefined,
      toolsCalled: toolsCalled.length ? toolsCalled : undefined,
      toolsNotCalled: toolsNotCalled.length ? toolsNotCalled : undefined,
      goalsAchieved: form.goalsAchieved.length ? form.goalsAchieved : undefined,
      replyContains: lines(form.replyContains).length ? lines(form.replyContains) : undefined,
      replyNotContains: lines(form.replyNotContains).length ? lines(form.replyNotContains) : undefined,
      minBlockedViolations: int(form.minBlocked),
      maxBlockedViolations: int(form.maxBlocked),
      maxTurns: int(form.maxTurns),
    },
    sandbox: parseSandbox(form.knownContacts, form.busy),
  });
  if (parsed.success) return { ok: true, def: parsed.data };
  const issue = parsed.error.issues[0]!;
  const where = issue.path.length ? ` (${issue.path.join(" › ")})` : "";
  return { ok: false, error: `${issue.message}${where}` };
}

export function defToForm(def: ScenarioDef): ScenarioForm {
  const e = def.expect;
  const toolRules: ScenarioForm["toolRules"] = {};
  for (const t of e.toolsCalled ?? []) toolRules[t] = "must";
  for (const t of e.toolsNotCalled ?? []) toolRules[t] = "never";
  return {
    name: def.name,
    turns: def.turns.join("\n"),
    completes: fromTri(e.completes),
    outcomeType: e.outcomeType ?? "",
    handoff: fromTri(e.handoff),
    capturedKeys: (e.capturedKeys ?? []).join(", "),
    capturedEquals: Object.entries(e.capturedEquals ?? {}).map(([k, v]) => `${k} = ${v}`).join("\n"),
    replyContains: (e.replyContains ?? []).join("\n"),
    replyNotContains: (e.replyNotContains ?? []).join("\n"),
    toolRules,
    goalsAchieved: e.goalsAchieved ?? [],
    minBlocked: e.minBlockedViolations?.toString() ?? "",
    maxBlocked: e.maxBlockedViolations?.toString() ?? "",
    maxTurns: e.maxTurns?.toString() ?? "",
    knownContacts: def.sandbox.knownContacts.map((c) => (c.firstName ? `${c.email}, ${c.firstName}` : c.email)).join("\n"),
    busy: def.sandbox.busy.map((b) => `${b.start}, ${b.end}`).join("\n"),
  };
}
