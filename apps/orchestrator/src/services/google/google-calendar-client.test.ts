import { describe, it, expect, vi } from "vitest";
import { createGoogleCalendarClient, GOOGLE_CALENDAR_EVENTS_URL, parseGoogleCalendarEvent } from "./google-calendar-client.js";
import { GoogleProviderError } from "./google-client.js";

const window = { start: new Date("2025-10-05T15:00:00Z"), end: new Date("2027-10-05T15:00:00Z") };
const event = { id: "event-1", summary: "Planning", start: { dateTime: "2026-10-05T09:00:00-07:00" },
  end: { dateTime: "2026-10-05T10:00:00-07:00" }, etag: "etag-1" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Google Calendar snapshots", () => {
  it("reads only the fixed primary-calendar endpoint and safely encodes opaque page tokens", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ items: [event], nextPageToken: "https://evil.example/?token=secret" }))
      .mockResolvedValueOnce(json({ items: [{ ...event, id: "event-2" }] }));
    const result = await createGoogleCalendarClient(fetcher).readPrimaryCalendar("access-secret", window);
    expect(result.map((row) => row.externalUid)).toEqual(["event-1", "event-2"]);
    for (const [urlText, init] of fetcher.mock.calls as [string, RequestInit][]) {
      const url = new URL(urlText);
      expect(url.origin + url.pathname).toBe(GOOGLE_CALENDAR_EVENTS_URL);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        timeMin: window.start.toISOString(), timeMax: window.end.toISOString(), singleEvents: "true", showDeleted: "false",
        maxResults: "1000", orderBy: "startTime", timeZone: "UTC",
      });
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers).toEqual({ Authorization: "Bearer access-secret" });
    }
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("pageToken")).toBe("https://evil.example/?token=secret");
  });

  it("keeps all-day exclusive calendar dates at UTC midnight and timed event offsets exact", () => {
    const day = parseGoogleCalendarEvent({ id: "holiday", start: { date: "2026-10-05" }, end: { date: "2026-10-07" } });
    expect(day).toMatchObject({ allDay: true, startsAt: new Date("2026-10-05T00:00:00Z"), endsAt: new Date("2026-10-07T00:00:00Z") });
    expect(parseGoogleCalendarEvent(event)).toMatchObject({ allDay: false,
      startsAt: new Date("2026-10-05T16:00:00Z"), endsAt: new Date("2026-10-05T17:00:00Z") });
  });

  it("accepts Google's empty-calendar response with no items property", async () => {
    const client = createGoogleCalendarClient(vi.fn(async () => json({ kind: "calendar#events" })));
    expect(await client.readPrimaryCalendar("access", window)).toEqual([]);
  });

  it("uses stable recurring instance IDs and resolves explicit named-zone clocks", () => {
    const recurring = parseGoogleCalendarEvent({ ...event, id: "series_20261005T160000Z", recurringEventId: "series",
      start: { dateTime: "2026-10-05T09:00:00", timeZone: "America/Los_Angeles" },
      end: { dateTime: "2026-10-05T10:00:00", timeZone: "America/Los_Angeles" } });
    expect(recurring).toMatchObject({ externalUid: "series_20261005T160000Z", recurrence: "occurrence",
      startsAt: new Date("2026-10-05T16:00:00Z") });
    expect(parseGoogleCalendarEvent({ ...event,
      start: { dateTime: "2026-10-05T09:00:00.123456", timeZone: "America/Los_Angeles" } })?.startsAt)
      .toEqual(new Date("2026-10-05T16:00:00.123Z"));
    expect(parseGoogleCalendarEvent({ id: "cancelled-instance", status: "cancelled" })).toBeNull();
  });

  it("admits only HTTPS video links without sniffing a location string", () => {
    expect(parseGoogleCalendarEvent({ ...event, hangoutLink: "https://meet.google.com/abc" })?.meetingUrl).toBe("https://meet.google.com/abc");
    expect(parseGoogleCalendarEvent({ ...event, hangoutLink: "javascript:alert(1)", location: "https://evil.example" })?.meetingUrl).toBeNull();
    expect(parseGoogleCalendarEvent({ ...event, conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://conference.example/join" }] } })?.meetingUrl)
      .toBe("https://conference.example/join");
  });

  it("does not return a partial snapshot after malformed events, cycles or truncated page limits", async () => {
    const malformed = createGoogleCalendarClient(vi.fn(async () => json({ items: [{ ...event, end: { date: "2026-02-30" } }] })));
    await expect(malformed.readPrimaryCalendar("access", window)).rejects.toBeInstanceOf(GoogleProviderError);
    const cycle = createGoogleCalendarClient(vi.fn(async () => json({ items: [event], nextPageToken: "same-page" })));
    await expect(cycle.readPrimaryCalendar("access", window)).rejects.toBeInstanceOf(GoogleProviderError);
    let index = 0;
    const bounded = vi.fn(async () => json({ items: [], nextPageToken: `page-${index++}` }));
    await expect(createGoogleCalendarClient(bounded).readPrimaryCalendar("access", window)).rejects.toBeInstanceOf(GoogleProviderError);
    expect(bounded).toHaveBeenCalledTimes(20);
  });

  it("requires a real instant or an explicit named zone and never guesses floating local times", () => {
    expect(() => parseGoogleCalendarEvent({ ...event, start: { dateTime: "2026-10-05T09:00:00" } })).toThrow(GoogleProviderError);
    expect(() => parseGoogleCalendarEvent({ ...event, start: { dateTime: "2026-10-05T09:00:00", timeZone: "Invalid/Zone" } })).toThrow(GoogleProviderError);
    expect(() => parseGoogleCalendarEvent({ ...event, start: { date: "2026-02-30" }, end: { date: "2026-03-02" } })).toThrow(GoogleProviderError);
    expect(() => parseGoogleCalendarEvent({ ...event, start: { dateTime: "2026-02-30T09:00:00Z" } })).toThrow(GoogleProviderError);
    expect(() => parseGoogleCalendarEvent({ ...event, start: { dateTime: "2026-10-05T25:00:00", timeZone: "America/Los_Angeles" } })).toThrow(GoogleProviderError);
  });

  it("redacts provider failures and rejects redirects instead of forwarding a bearer", async () => {
    for (const fetcher of [vi.fn(async () => json({ error: { message: "TOKEN_SECRET" } }, 403)),
      vi.fn(async () => { throw new Error("TOKEN_SECRET redirect"); })]) {
      const result = await createGoogleCalendarClient(fetcher).readPrimaryCalendar("access", window).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(GoogleProviderError);
      expect(String(result)).not.toContain("TOKEN_SECRET");
    }
    await expect(createGoogleCalendarClient(vi.fn(async () => json({}, 401))).readPrimaryCalendar("access", window))
      .rejects.toMatchObject({ needsReconnect: true });
  });
});
