import { Injectable } from "@nestjs/common";

const GOOGLE_CALENDAR_URL = "https://www.googleapis.com/calendar/v3";

export interface BusyInterval {
  start: string;
  end: string;
}

export type CalendarResult<T> = ({ success: true } & T) | { success: false; error: string };

/**
 * Interactive Google Calendar calls for the agent runtime: free/busy and
 * create-event with explicit arguments (CalendarSender, by contrast, builds
 * an event from captured data after the conversation). Mock mode — the same
 * switch as the calendar connection, GOOGLE_CLIENT_ID unset — is
 * deterministic: every UTC day is busy 10:00–11:00. The real calls are
 * code-complete against the documented API, not live-tested.
 */
@Injectable()
export class CalendarClient {
  private get mock(): boolean {
    return !process.env.GOOGLE_CLIENT_ID;
  }

  async freeBusy(accessToken: string, calendarId: string, from: Date, to: Date): Promise<CalendarResult<{ busy: BusyInterval[] }>> {
    if (this.mock) return { success: true, busy: mockBusy(from, to) };
    const response = await fetch(`${GOOGLE_CALENDAR_URL}/freeBusy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calendarId }] }),
    });
    if (!response.ok) return { success: false, error: `Google Calendar API error ${response.status}` };
    const data = (await response.json()) as { calendars?: Record<string, { busy?: BusyInterval[] }> };
    return { success: true, busy: data.calendars?.[calendarId]?.busy ?? [] };
  }

  async createEvent(
    accessToken: string,
    calendarId: string,
    event: { title: string; description?: string; start: Date; end: Date; attendeeEmail?: string },
  ): Promise<CalendarResult<{ eventId: string; link?: string }>> {
    if (this.mock) return { success: true, eventId: `mock_event_${event.start.getTime()}` };
    const response = await fetch(`${GOOGLE_CALENDAR_URL}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        summary: event.title,
        description: event.description,
        start: { dateTime: event.start.toISOString() },
        end: { dateTime: event.end.toISOString() },
        ...(event.attendeeEmail ? { attendees: [{ email: event.attendeeEmail }] } : {}),
      }),
    });
    if (!response.ok) return { success: false, error: `Google Calendar API error ${response.status}` };
    const data = (await response.json()) as { id?: string; htmlLink?: string };
    return data.id ? { success: true, eventId: data.id, link: data.htmlLink } : { success: false, error: "Google Calendar returned no event id" };
  }
}

/** 10:00–11:00 UTC on every day the range touches. */
function mockBusy(from: Date, to: Date): BusyInterval[] {
  const out: BusyInterval[] = [];
  const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (let guard = 0; day < to && guard < 100; guard++, day.setUTCDate(day.getUTCDate() + 1)) {
    const start = new Date(day.getTime() + 10 * 3_600_000);
    const end = new Date(day.getTime() + 11 * 3_600_000);
    if (end > from && start < to) out.push({ start: start.toISOString(), end: end.toISOString() });
  }
  return out;
}
