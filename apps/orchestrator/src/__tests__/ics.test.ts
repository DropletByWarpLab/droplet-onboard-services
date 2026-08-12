import { describe, it, expect } from "vitest";
import { parseIcs, serializeIcs } from "../services/ics.js";

const SAMPLE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:abc-123@example.com
SUMMARY:Coffee with Bob
DESCRIPTION:Talk about the new project\\nBring laptop.
LOCATION:Blue Bottle
DTSTART:20260423T140000Z
DTEND:20260423T150000Z
END:VEVENT
BEGIN:VEVENT
UID:all-day-1@example.com
SUMMARY:Vacation
DTSTART;VALUE=DATE:20260501
DTEND;VALUE=DATE:20260508
END:VEVENT
END:VCALENDAR
`;

describe("parseIcs", () => {
  it("parses a basic VEVENT with UTC timestamps", () => {
    const events = parseIcs(SAMPLE);
    expect(events).toHaveLength(2);
    const [coffee, vacation] = events;
    expect(coffee.uid).toBe("abc-123@example.com");
    expect(coffee.summary).toBe("Coffee with Bob");
    expect(coffee.description).toBe("Talk about the new project\nBring laptop.");
    expect(coffee.location).toBe("Blue Bottle");
    expect(coffee.startsAt.toISOString()).toBe("2026-04-23T14:00:00.000Z");
    expect(coffee.endsAt.toISOString()).toBe("2026-04-23T15:00:00.000Z");
    expect(coffee.allDay).toBe(false);

    expect(vacation.allDay).toBe(true);
    expect(vacation.startsAt.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(vacation.endsAt.toISOString()).toBe("2026-05-08T00:00:00.000Z");
  });

  it("unfolds continuation lines (RFC 5545 §3.1)", () => {
    const folded = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:1@x
SUMMARY:Long summary that
 continues onto the next
 line via leading whitespace
DTSTART:20260423T140000Z
DTEND:20260423T150000Z
END:VEVENT
END:VCALENDAR
`;
    const [ev] = parseIcs(folded);
    expect(ev.summary).toBe("Long summary thatcontinues onto the nextline via leading whitespace");
  });

  it("handles CRLF line endings", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    expect(parseIcs(crlf)).toHaveLength(2);
  });

  it("drops malformed events without UID, missing dates, or invalid timestamps", () => {
    const broken = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:No UID
DTSTART:20260423T140000Z
DTEND:20260423T150000Z
END:VEVENT
BEGIN:VEVENT
UID:no-dates@x
SUMMARY:Missing dates
END:VEVENT
BEGIN:VEVENT
UID:bad-date@x
SUMMARY:Garbled date
DTSTART:not-a-date
DTEND:also-not
END:VEVENT
BEGIN:VEVENT
UID:good@x
SUMMARY:OK
DTSTART:20260423T140000Z
DTEND:20260423T150000Z
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(broken);
    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe("good@x");
  });

  it("synthesises endsAt for all-day events with no DTEND", () => {
    const oneDay = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:oneday@x
SUMMARY:One day
DTSTART;VALUE=DATE:20260423
END:VEVENT
END:VCALENDAR`;
    const [ev] = parseIcs(oneDay);
    expect(ev.allDay).toBe(true);
    expect(ev.endsAt.getTime() - ev.startsAt.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("preserves RRULE text on the event", () => {
    const recurring = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:weekly@x
SUMMARY:Standup
DTSTART:20260427T160000Z
DTEND:20260427T163000Z
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT
END:VCALENDAR`;
    const [ev] = parseIcs(recurring);
    expect(ev.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });
});

describe("serializeIcs", () => {
  it("produces a valid VCALENDAR document with CRLF line endings", () => {
    const out = serializeIcs([
      {
        uid: "ev-1",
        summary: "Test",
        description: "Line one\nLine two",
        location: "Office",
        startsAt: new Date("2026-04-23T14:00:00Z"),
        endsAt: new Date("2026-04-23T15:00:00Z"),
        allDay: false,
        updatedAt: new Date("2026-04-22T10:00:00Z"),
      },
    ]);
    expect(out).toContain("BEGIN:VCALENDAR\r\n");
    expect(out).toContain("END:VCALENDAR\r\n");
    expect(out).toContain("UID:ev-1");
    expect(out).toContain("DTSTART:20260423T140000Z");
    expect(out).toContain("DTEND:20260423T150000Z");
    expect(out).toContain("SUMMARY:Test");
    expect(out).toContain("DESCRIPTION:Line one\\nLine two");
    expect(out).toContain("LOCATION:Office");
    expect(out).toContain("LAST-MODIFIED:20260422T100000Z");
  });

  it("escapes special characters in text fields", () => {
    const out = serializeIcs([
      {
        uid: "ev-1",
        summary: "Comma, semi; backslash\\",
        startsAt: new Date("2026-04-23T14:00:00Z"),
        endsAt: new Date("2026-04-23T15:00:00Z"),
        allDay: false,
      },
    ]);
    expect(out).toContain("SUMMARY:Comma\\, semi\\; backslash\\\\");
  });

  it("emits all-day events with VALUE=DATE", () => {
    const out = serializeIcs([
      {
        uid: "vacation-1",
        summary: "Vacation",
        startsAt: new Date("2026-05-01T00:00:00Z"),
        endsAt: new Date("2026-05-08T00:00:00Z"),
        allDay: true,
      },
    ]);
    expect(out).toContain("DTSTART;VALUE=DATE:20260501");
    expect(out).toContain("DTEND;VALUE=DATE:20260508");
  });

  it("emits the video-call link as a URL property so external clients can join", () => {
    // WARP-1874 — a household member who subscribes from Apple Calendar or
    // Outlook sees the meeting there, not in the dashboard. Without URL the
    // one thing they need at 2:59 is the one thing missing. URL is the RFC
    // 5545 property both clients render as a join target.
    const out = serializeIcs([
      {
        uid: "ev-1",
        summary: "Sprint sync",
        location: "Living Room",
        meetingUrl: "https://warplab.zoom.us/j/98765?pwd=abc",
        startsAt: new Date("2026-04-23T14:00:00Z"),
        endsAt: new Date("2026-04-23T15:00:00Z"),
        allDay: false,
      },
    ]);
    expect(out).toContain("URL:https://warplab.zoom.us/j/98765?pwd=abc");
    // The room and the call are separate facts, as they are in the
    // database — LOCATION must not be displaced by the link.
    expect(out).toContain("LOCATION:Living Room");
  });

  it("omits URL entirely when the event has no link", () => {
    const out = serializeIcs([
      {
        uid: "ev-1",
        summary: "Sprint sync",
        meetingUrl: null,
        startsAt: new Date("2026-04-23T14:00:00Z"),
        endsAt: new Date("2026-04-23T15:00:00Z"),
        allDay: false,
      },
    ]);
    expect(out).not.toContain("URL:");
  });

  it("escapes the link like every other text value", () => {
    // Stored values are parser-normalized hrefs, so CR/LF are already
    // percent-encoded — but serializeIcs takes a plain interface, and a
    // caller that skipped the parser must not be able to inject a content
    // line through it.
    const out = serializeIcs([
      {
        uid: "ev-1",
        summary: "x",
        meetingUrl: "https://vc.warp-lab.ai/room;a,b",
        startsAt: new Date("2026-04-23T14:00:00Z"),
        endsAt: new Date("2026-04-23T15:00:00Z"),
        allDay: false,
      },
    ]);
    expect(out).toContain("URL:https://vc.warp-lab.ai/room\\;a\\,b");
  });

  it("round-trips: serialize then parse returns the same events", () => {
    const original = [
      {
        uid: "rt-1",
        summary: "Round trip",
        description: "Multi-line\ndescription",
        location: "Earth",
        startsAt: new Date("2026-04-23T14:00:00Z"),
        endsAt: new Date("2026-04-23T15:30:00Z"),
        allDay: false,
      },
    ];
    const ics = serializeIcs(original);
    const parsed = parseIcs(ics);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].uid).toBe("rt-1");
    expect(parsed[0].summary).toBe("Round trip");
    expect(parsed[0].description).toBe("Multi-line\ndescription");
    expect(parsed[0].location).toBe("Earth");
    expect(parsed[0].startsAt.toISOString()).toBe("2026-04-23T14:00:00.000Z");
    expect(parsed[0].endsAt.toISOString()).toBe("2026-04-23T15:30:00.000Z");
  });
});
