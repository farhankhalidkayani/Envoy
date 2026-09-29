export interface WebhookConfig {
  url: string;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  /** `{{field}}` placeholders resolved against capturedData; omit to send capturedData as-is. */
  payloadTemplate?: string;
}

export interface EmailConfig {
  to: string;
  subject: string;
  /** `{{field}}` placeholders resolved against capturedData. */
  bodyTemplate: string;
}

export interface CalendarConfig {
  calendarId?: string; // defaults to "primary"
  titleTemplate: string;
  descriptionTemplate?: string;
  /** capturedData key holding an ISO 8601 start time. */
  startField: string;
  durationMinutes?: number; // defaults to 30
}

export type IntegrationConfig = WebhookConfig | EmailConfig | CalendarConfig;

/** Where the captured data being pushed lives. */
export type PushSource = { conversationId: string } | { formSubmissionId: string };

export interface IntegrationPushResult {
  success: boolean;
  error?: string;
}
