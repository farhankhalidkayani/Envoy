import type { WorkflowDef, WorkflowStep } from "@envoy/types";

export type Draft = Omit<WorkflowDef, "settings"> & { settings: WorkflowDef["settings"] };

export function emptyDraft(): Draft {
  return {
    name: "",
    trigger: { type: "conversation_completed" },
    conditions: { match: "all", conditions: [] },
    steps: [{ type: "send_email", to: "lead", subject: "", body: "" }],
    settings: { emailField: "email", phoneField: "phone", timezone: browserTimeZone(), quietHours: { enabled: true, startHour: 21, endHour: 8 }, exitOnReply: true },
  };
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const blankCondition = () => ({ field: "", op: "equals" as const, value: "" });

/** Give a step an "only if…" condition, or take it away. An "end here" step always keeps one (it's meaningless without). */
export function toggleStepCondition(step: WorkflowStep): WorkflowStep {
  if (step.when) {
    if (step.type === "exit") return step;
    const { when: _drop, ...rest } = step;
    return rest as WorkflowStep;
  }
  return { ...step, when: { match: "all", conditions: [blankCondition()] } };
}

export function newStep(type: WorkflowStep["type"]): WorkflowStep {
  if (type === "wait") return { type: "wait", amount: 1, unit: "days" };
  if (type === "send_sms") return { type: "send_sms", body: "" };
  if (type === "exit") return { type: "exit", when: { match: "all", conditions: [blankCondition()] } };
  return { type: "send_email", to: "lead", subject: "", body: "" };
}

export const addStep = (steps: WorkflowStep[], type: WorkflowStep["type"]): WorkflowStep[] => [...steps, newStep(type)];
export const removeStep = (steps: WorkflowStep[], i: number): WorkflowStep[] => steps.filter((_, idx) => idx !== i);
export const replaceStep = (steps: WorkflowStep[], i: number, step: WorkflowStep): WorkflowStep[] => steps.map((s, idx) => (idx === i ? step : s));

/** Swaps a step with its neighbour; moving past either end is a no-op. */
export function moveStep(steps: WorkflowStep[], i: number, direction: -1 | 1): WorkflowStep[] {
  const j = i + direction;
  if (j < 0 || j >= steps.length) return steps;
  const next = [...steps];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** "right away", "after 30 minutes", "after 1 day 3 hours" — how long after the lead arrives a step happens. */
export function formatOffset(ms: number): string {
  if (ms <= 0) return "right away";
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [days && `${days} day${days === 1 ? "" : "s"}`, hours && `${hours} hour${hours === 1 ? "" : "s"}`, mins && `${mins} minute${mins === 1 ? "" : "s"}`].filter(Boolean);
  return `after ${parts.join(" ")}`;
}

/** `name = Ada` lines → a sample lead. Numbers and true/false become typed values, so conditions like "budget > 5000" behave as they will for real leads. */
export function parseSampleLead(text: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    if (!key) continue;
    out[key] = raw === "true" ? true : raw === "false" ? false : raw !== "" && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

export const insertVariable = (text: string, key: string) => `${text}${text && !/\s$/.test(text) ? " " : ""}{{${key}}}`;

/** Field keys a template can use, from what the trigger's agent or form collects, always plus the conversation outcome. */
export function variableKeys(collected: string[]): string[] {
  return [...new Set([...collected, "outcome"])];
}
