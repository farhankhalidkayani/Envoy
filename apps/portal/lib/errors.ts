import { ApiError } from "@envoy/sdk";

const FALLBACK = "Something went wrong. Please try again.";

function humanizeFieldName(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldMessage(field: string, msg: string): string {
  const label = humanizeFieldName(field);
  if (msg === "Required") return `${label} is required.`;
  if (msg === "Invalid email") return `Enter a valid ${label.toLowerCase()}.`;
  const minLength = msg.match(/^String must contain at least (\d+) character/);
  if (minLength) {
    const n = Number(minLength[1]);
    return `${label} must be at least ${n} character${n === 1 ? "" : "s"}.`;
  }
  return `${label} — ${msg}`;
}

/**
 * Envoy's API sends two error shapes: Zod's `error.flatten()` for request
 * validation (`{ formErrors, fieldErrors }`), or Nest's default HttpException
 * body (`{ message, error, statusCode }`) for everything else. This turns
 * either into a sentence a user can act on instead of the raw JSON.
 */
function parseBackendMessage(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as Record<string, unknown>;

  if ("fieldErrors" in body || "formErrors" in body) {
    const fieldErrors = (body.fieldErrors ?? {}) as Record<string, string[]>;
    const formErrors = (body.formErrors ?? []) as string[];
    const parts: string[] = [];
    for (const [field, messages] of Object.entries(fieldErrors)) {
      if (messages?.[0]) parts.push(fieldMessage(field, messages[0]));
    }
    parts.push(...formErrors);
    if (parts.length) return parts.join(" ");
  }

  if (typeof body.message === "string") return body.message;
  if (Array.isArray(body.message) && body.message.every((m) => typeof m === "string")) {
    return (body.message as string[]).join(" ");
  }

  return null;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return parseBackendMessage(err.message) ?? FALLBACK;
  }
  // A plain Error (not ApiError) only ever comes from our own client code
  // with a hand-written message — safe to show as-is, unlike ApiError.message.
  if (err instanceof Error) {
    return err.message || FALLBACK;
  }
  return FALLBACK;
}
