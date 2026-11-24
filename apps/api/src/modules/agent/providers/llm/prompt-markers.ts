import type { GoalDef, GoalProgressMap, RequiredFieldsSpec } from "@envoy/types";

/**
 * Delimited, machine-parseable blocks embedded in prompts alongside the
 * natural-language instructions aimed at real models. Real providers never
 * need to parse these back out — they just read the instructions. The mock
 * provider parses them directly so the whole engine (field collection, rule
 * enforcement, completion detection) is deterministically testable without
 * a live API key.
 */
export const REQUIRED_FIELDS_START = "<<REQUIRED_FIELDS>>";
export const REQUIRED_FIELDS_END = "<<END_REQUIRED_FIELDS>>";
export const COMPLETE_MARKER_PREFIX = "<<ENVOY_COMPLETE";
export const COMPLETE_MARKER_SUFFIX = ">>";
export const RETRY_NOTICE_MARKER = "<<ENVOY_RETRY_AFTER_VIOLATION>>";

export function embedRequiredFields(fields: RequiredFieldsSpec): string {
  return `${REQUIRED_FIELDS_START}\n${JSON.stringify(fields)}\n${REQUIRED_FIELDS_END}`;
}

export function extractRequiredFields(text: string): RequiredFieldsSpec | null {
  const start = text.indexOf(REQUIRED_FIELDS_START);
  const end = text.indexOf(REQUIRED_FIELDS_END);
  if (start === -1 || end === -1 || end <= start) return null;
  const json = text.slice(start + REQUIRED_FIELDS_START.length, end).trim();
  try {
    return JSON.parse(json) as RequiredFieldsSpec;
  } catch {
    return null;
  }
}

/** Strips the completion marker out of visible agent text and returns the outcomeType if present. */
export function stripCompletionMarker(text: string): { visibleText: string; outcomeType?: string } {
  const start = text.indexOf(COMPLETE_MARKER_PREFIX);
  if (start === -1) return { visibleText: text };
  const end = text.indexOf(COMPLETE_MARKER_SUFFIX, start);
  if (end === -1) return { visibleText: text };
  const marker = text.slice(start, end + COMPLETE_MARKER_SUFFIX.length);
  const match = marker.match(/outcomeType="([a-zA-Z_]+)"/);
  const visibleText = (text.slice(0, start) + text.slice(end + COMPLETE_MARKER_SUFFIX.length)).trim();
  return { visibleText, outcomeType: match?.[1] };
}

// ── Agentic-runtime blocks (same idea: real models read the prose, the mock parses these) ──

const CAPTURED_START = "<<CAPTURED_DATA>>";
const CAPTURED_END = "<<END_CAPTURED_DATA>>";
const GOALS_START = "<<AGENT_GOALS>>";
const GOALS_END = "<<END_AGENT_GOALS>>";
const GOAL_PROGRESS_START = "<<GOAL_PROGRESS>>";
const GOAL_PROGRESS_END = "<<END_GOAL_PROGRESS>>";

function embed<T>(start: string, end: string, value: T): string {
  return `${start}\n${JSON.stringify(value)}\n${end}`;
}

function extract<T>(text: string, start: string, end: string): T | null {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a + start.length, b).trim()) as T;
  } catch {
    return null;
  }
}

export const embedCapturedData = (data: Record<string, unknown>) => embed(CAPTURED_START, CAPTURED_END, data);
export const extractCapturedData = (text: string) => extract<Record<string, unknown>>(text, CAPTURED_START, CAPTURED_END);
export const embedGoals = (goals: GoalDef[]) => embed(GOALS_START, GOALS_END, goals);
export const extractGoals = (text: string) => extract<GoalDef[]>(text, GOALS_START, GOALS_END);
export const embedGoalProgress = (p: GoalProgressMap) => embed(GOAL_PROGRESS_START, GOAL_PROGRESS_END, p);
export const extractGoalProgress = (text: string) => extract<GoalProgressMap>(text, GOAL_PROGRESS_START, GOAL_PROGRESS_END);
