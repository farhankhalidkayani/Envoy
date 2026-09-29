/** Replaces `{{field}}` with capturedData[field] (stringified); unknown fields become "". */
export function renderTemplate(template: string, capturedData: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = capturedData[key];
    return value === undefined || value === null ? "" : String(value);
  });
}
