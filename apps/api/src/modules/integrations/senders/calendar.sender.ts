import { Injectable } from "@nestjs/common";
import { renderTemplate } from "../template.js";
import type { CalendarConfig, IntegrationPushResult } from "../types.js";

const GOOGLE_CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars";

/**
 * Google Calendar REST API via plain fetch — code-complete against the
 * documented Events.insert shape, same posture as HubSpotCrmProvider (not
 * live-tested, no Google Cloud project available here).
 */
@Injectable()
export class CalendarSender {
  async send(
    accessToken: string,
    config: CalendarConfig,
    capturedData: Record<string, unknown>,
  ): Promise<IntegrationPushResult> {
    const startIso = capturedData[config.startField];
    if (typeof startIso !== "string") {
      return { success: false, error: `capturedData.${config.startField} is missing or not a string` };
    }
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) {
      return { success: false, error: `capturedData.${config.startField} is not a valid date` };
    }
    const end = new Date(start.getTime() + (config.durationMinutes ?? 30) * 60_000);

    const calendarId = config.calendarId ?? "primary";
    const response = await fetch(
      `${GOOGLE_CALENDAR_EVENTS_URL}/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          summary: renderTemplate(config.titleTemplate, capturedData),
          description: config.descriptionTemplate
            ? renderTemplate(config.descriptionTemplate, capturedData)
            : undefined,
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      return { success: false, error: `Google Calendar API error ${response.status}: ${text}` };
    }
    return { success: true };
  }
}
