/**
 * A form "file" field's value is a base64 data: URL (see form-schema.ts's
 * FILE_DATA_URL_RE) — up to ~2MB. CRM contact properties, webhook JSON
 * bodies, and email templates were never meant to carry that: HubSpot
 * property values top out around 65KB, and stuffing a multi-MB string into
 * a webhook payload or email body just bloats/breaks the destination. Swap
 * it for a short marker before it leaves our system.
 */
const DATA_URL_RE = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s;

export function sanitizeCapturedData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      const match = DATA_URL_RE.exec(value);
      if (match) {
        const sizeKb = Math.round((match[2]!.length * 0.75) / 1024);
        out[key] = `[file: ${match[1]}, ${sizeKb}KB — not forwarded]`;
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}
