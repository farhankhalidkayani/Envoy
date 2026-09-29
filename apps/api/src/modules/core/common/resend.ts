import { Logger } from "@nestjs/common";

const RESEND_URL = "https://api.resend.com/emails";
const logger = new Logger("Resend");

export interface SendEmailResult {
  success: boolean;
  error?: string;
}

/**
 * Resend's HTTP API via plain fetch — no SDK, one API key, one POST. Shared
 * by the "email on capture" integration and system mail (password reset,
 * email verification). Same mock-fallback posture as CrmService.
 * initiateConnect: without RESEND_API_KEY this logs and reports success
 * instead of failing, so registration/reset flows stay testable without a
 * live account — never happens when a real key is configured.
 */
export async function sendEmail(to: string, subject: string, text: string): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL ?? "envoy@resend.dev";

  if (!apiKey) {
    logger.warn(`RESEND_API_KEY not set — skipping real send, would have emailed ${to}: "${subject}"\n${text}`);
    return { success: true };
  }

  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    return { success: false, error: `Resend API error ${response.status}: ${body}` };
  }
  return { success: true };
}
