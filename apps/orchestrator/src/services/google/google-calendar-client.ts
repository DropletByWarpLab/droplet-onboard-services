/** Read-only primary-calendar snapshots. Provider recurrence expansion supplies stable instance IDs. */
import { parseMeetingLink } from "@droplet/shared-types";
import { zonedWallClockToUtc } from "../../lib/zoned-time.js";
import type { ExternalCalendarEvent } from "../cloud-calendar-store.service.js";
import { GoogleProviderError } from "./google-client.js";

export const GOOGLE_CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MAX_PAGES = 20;
const MAX_EVENTS = 20_000;
const PAGE_SIZE = 1000;
type GoogleDate = { date?: unknown; dateTime?: unknown; timeZone?: unknown };
type GoogleEvent = {
  id?: unknown; status?: unknown; summary?: unknown; description?: unknown; location?: unknown; etag?: unknown;
  start?: GoogleDate; end?: GoogleDate; recurringEventId?: unknown; hangoutLink?: unknown;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: unknown; uri?: unknown }> };
};
export interface GoogleCalendarClient {
  readPrimaryCalendar(accessToken: string, window: { start: Date; end: Date }): Promise<ExternalCalendarEvent[]>;
}

function googleDate(value: GoogleDate | undefined): { instant: Date; allDay: boolean } {
  let instant: Date;
  if (typeof value?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
    instant = new Date(`${value.date}T00:00:00.000Z`);
    if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== value.date) throw new GoogleProviderError();
    return { instant, allDay: true };
  }
  if (typeof value?.dateTime !== "string") throw new GoogleProviderError();
  const time = value.dateTime;
  const date = time.slice(0, 10);
  const calendarDate = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(calendarDate.getTime()) ||
      calendarDate.toISOString().slice(0, 10) !== date) throw new GoogleProviderError();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(time)) {
    instant = new Date(time);
  } else {
    const wall = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(time);
    if (!wall || typeof value.timeZone !== "string") throw new GoogleProviderError();
    if (Number(wall[4]) > 23 || Number(wall[5]) > 59 || Number(wall[6]) > 59) throw new GoogleProviderError();
    instant = zonedWallClockToUtc(Number(wall[1]), Number(wall[2]), Number(wall[3]),
      Number(wall[4]), Number(wall[5]), Number(wall[6]), value.timeZone);
    if (wall[7]) instant = new Date(instant.getTime() + Number(wall[7].padEnd(3, "0").slice(0, 3)));
  }
  if (!Number.isFinite(instant.getTime())) throw new GoogleProviderError();
  return { instant, allDay: false };
}

/** An invalid live event fails the snapshot, preserving prior local data. */
export function parseGoogleCalendarEvent(value: unknown): ExternalCalendarEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoogleProviderError();
  const event = value as GoogleEvent;
  if (event.status === "cancelled") return null;
  if (typeof event.id !== "string" || !event.id || event.id.length > 1024) throw new GoogleProviderError();
  const start = googleDate(event.start);
  const end = googleDate(event.end);
  if (start.allDay !== end.allDay || end.instant <= start.instant) throw new GoogleProviderError();
  const video = event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri;
  const meetingUrl = parseMeetingLink(event.hangoutLink)?.url ?? parseMeetingLink(video)?.url ?? null;
  const text = (value: unknown, length: number): string | null => typeof value === "string" ? value.slice(0, length) : null;
  return {
    externalUid: event.id, title: text(event.summary, 500)?.trim() || "Untitled event",
    description: text(event.description, 10_000), location: text(event.location, 500), meetingUrl,
    startsAt: start.instant, endsAt: end.instant, allDay: start.allDay,
    recurrence: typeof event.recurringEventId === "string" ? "occurrence" : "none",
    externalEtag: text(event.etag, 1024),
  };
}

export function createGoogleCalendarClient(fetcher: typeof fetch = fetch): GoogleCalendarClient {
  return {
    async readPrimaryCalendar(accessToken, window) {
      const events: ExternalCalendarEvent[] = [];
      const seen = new Set<string>();
      let pageToken: string | undefined;
      const deadline = AbortSignal.timeout(60_000);
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = new URL(GOOGLE_CALENDAR_EVENTS_URL);
        url.search = new URLSearchParams({
          timeMin: window.start.toISOString(), timeMax: window.end.toISOString(),
          singleEvents: "true", showDeleted: "false", orderBy: "startTime", timeZone: "UTC",
          maxResults: String(PAGE_SIZE), ...(pageToken ? { pageToken } : {}),
          fields: "nextPageToken,items(id,status,summary,description,location,start,end,recurringEventId,etag,hangoutLink,conferenceData(entryPoints))",
        }).toString();
        let response: Response;
        try {
          response = await fetcher(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` },
            redirect: "error", signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]) });
        } catch { throw new GoogleProviderError(); }
        if (!response.ok) throw new GoogleProviderError(response.status === 401);
        const body: unknown = await response.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new GoogleProviderError();
        const result = body as { items?: unknown; nextPageToken?: unknown };
        const items = result.items === undefined ? [] : result.items;
        if (!Array.isArray(items)) throw new GoogleProviderError();
        if (events.length + items.length > MAX_EVENTS) throw new GoogleProviderError();
        for (const event of items) {
          const parsed = parseGoogleCalendarEvent(event);
          if (parsed) events.push(parsed);
        }
        if (result.nextPageToken === undefined || result.nextPageToken === "") return events;
        if (typeof result.nextPageToken !== "string" || result.nextPageToken.length > 4096 || seen.has(result.nextPageToken)) throw new GoogleProviderError();
        seen.add(result.nextPageToken);
        pageToken = result.nextPageToken;
      }
      throw new GoogleProviderError();
    },
  };
}
