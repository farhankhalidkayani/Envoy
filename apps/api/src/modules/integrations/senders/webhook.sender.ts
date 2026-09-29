import { Injectable } from "@nestjs/common";
import { renderTemplate } from "../template.js";
import type { IntegrationPushResult, WebhookConfig } from "../types.js";

@Injectable()
export class WebhookSender {
  async send(config: WebhookConfig, capturedData: Record<string, unknown>): Promise<IntegrationPushResult> {
    const body = config.payloadTemplate
      ? renderTemplate(config.payloadTemplate, capturedData)
      : JSON.stringify(capturedData);

    const response = await fetch(config.url, {
      method: config.method ?? "POST",
      headers: { "Content-Type": "application/json", ...(config.headers ?? {}) },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      return { success: false, error: `Webhook responded ${response.status}: ${text}` };
    }
    return { success: true };
  }
}
