import { Injectable, Logger } from "@nestjs/common";
import { renderTemplate } from "../template.js";
import type { EmailConfig, IntegrationPushResult } from "../types.js";

const RESEND_URL = "https://api.resend.com/emails";

/**
 * Resend's HTTP API via plain fetch — no SDK, one API key, one POST. Same
 * mock-fallback posture as CrmService.initiateConnect: without
 * RESEND_API_KEY this logs and reports success instead of failing every
 * job, so the queue/retry/trigger mechanism stays testable without a live
 * account.
 */
@Injectable()
export class EmailSender {
  private readonly logger = new Logger(EmailSender.name);

  async send(config: EmailConfig, capturedData: Record<string, unknown>): Promise<IntegrationPushResult> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL ?? "envoy@resend.dev";
    const subject = renderTemplate(config.subject, capturedData);
    const body = renderTemplate(config.bodyTemplate, capturedData);

    if (!apiKey) {
      this.logger.warn(`RESEND_API_KEY not set — skipping real send, would have emailed ${config.to}: "${subject}"`);
      return { success: true };
    }

    const response = await fetch(RESEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: config.to, subject, text: body }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      return { success: false, error: `Resend API error ${response.status}: ${text}` };
    }
    return { success: true };
  }
}
