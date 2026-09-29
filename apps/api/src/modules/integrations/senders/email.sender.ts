import { Injectable } from "@nestjs/common";
import { sendEmail } from "../../core/common/resend.js";
import { renderTemplate } from "../template.js";
import type { EmailConfig, IntegrationPushResult } from "../types.js";

@Injectable()
export class EmailSender {
  async send(config: EmailConfig, capturedData: Record<string, unknown>): Promise<IntegrationPushResult> {
    const subject = renderTemplate(config.subject, capturedData);
    const body = renderTemplate(config.bodyTemplate, capturedData);
    return sendEmail(config.to, subject, body);
  }
}
