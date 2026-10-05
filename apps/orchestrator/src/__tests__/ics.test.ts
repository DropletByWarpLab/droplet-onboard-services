import { describe, it, expect, vi } from "vitest";
import { parseIcs, serializeIcs, type IcsStatus } from "../services/ics.js";

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

  it("leaves ; and , verbatim in the link — URL is a URI value, not TEXT", () => {
    // RFC 5545 §3.8.4.6 types URL as URI. URI values are NOT text-escaped, so
    // the TEXT escaping of ; and , would corrupt the link. A self-hosted
    // Jitsi room like /Warp,Standup — exactly what parseMeetingLink
    // deliberately admits — must survive byte-for-byte, or the member who
    // taps Join in Apple Calendar lands in a different (invalid) room while
    // the dashboard Join button keeps working and hides the break.
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
    expect(out).toContain("URL:https://vc.warp-lab.ai/room;a,b");
    expect(out).not.toContain("\\;");
    expect(out).not.toContain("\\,");
  });

  it("still neutralizes CR/LF in the link so no content line can be injected", () => {
    // Stored values are parser-normalized hrefs, so CR/LF are already gone —
    // but serializeIcs takes a plain interface, and a caller that skipped the
    // parser must not be able to inject a content line through it. This is
    // the only part of TEXT escaping that ever served that defense.
    const out = serializeIcs([
      {
        uid: "ev-1",
        summary: "x",
        meetingUrl: "https://vc.warp-lab.ai/r\r\nSUMMARY:pwned",
        startsAt: new Date("2026-04-23T14:00:00Z"),
        endsAt: new Date("2026-04-23T15:00:00Z"),
        allDay: false,
      },
    ]);
    expect(out).toContain("URL:https://vc.warp-lab.ai/r\\nSUMMARY:pwned");
    // The injected SUMMARY never becomes a content line of its own.
    expect(out).not.toContain("\r\nSUMMARY:pwned");
    expect(out.split("\r\n").filter((l) => l.startsWith("SUMMARY:"))).toEqual(["SUMMARY:x"]);
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

// ── WARP-3533: the optional STATUS property ──
describe("serializeIcs — STATUS (WARP-3533)", () => {
  const base = {
    uid: "pm-1@droplet",
    summary: "ABC-1 Ship it",
    startsAt: new Date("2026-10-05T00:00:00Z"),
    endsAt: new Date("2026-10-06T00:00:00Z"),
    allDay: true,
  };

  it("writes STATUS for each value in the closed vocabulary, as its own CRLF-terminated line", () => {
    const vocabulary: readonly IcsStatus[] = ["TENTATIVE", "CONFIRMED", "CANCELLED", "COMPLETED"];
    // @ts-expect-error — a status outside the vocabulary does not type-check
    const outside: IcsStatus = "DONE";
    expect(vocabulary).not.toContain(outside);
    for (const status of vocabulary) {
      const out = serializeIcs([{ ...base, status }]);
      expect(out, status).toContain(`\r\nSTATUS:${status}\r\n`);
    }
  });

  it("writes nothing when there is no status, so every existing caller's output is unchanged", () => {
    const withUndefined = serializeIcs([{ ...base, status: undefined }]);
    expect(withUndefined).not.toContain("STATUS");
    // Byte-identical to a call that never mentions the field (DTSTAMP is the clock, so pin it).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    try {
      expect(serializeIcs([{ ...base, status: undefined }])).toBe(serializeIcs([{ ...base }]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts STATUS inside the VEVENT, once per event, and only on the events that have one", () => {
    const out = serializeIcs([
      { ...base, uid: "a@droplet", status: "COMPLETED" },
      { ...base, uid: "b@droplet" },
      { ...base, uid: "c@droplet", status: "CANCELLED" },
    ]);
    const events = out.split("BEGIN:VEVENT").slice(1);
    expect(events).toHaveLength(3);
    expect(events[0]).toContain("STATUS:COMPLETED");
    expect(events[1]).not.toContain("STATUS");
    expect(events[2]).toContain("STATUS:CANCELLED");
    expect(out.match(/STATUS:/g)).toHaveLength(2);
    // Before END:VEVENT of its own event, not after it.
    expect(events[0].indexOf("STATUS:COMPLETED")).toBeLessThan(events[0].indexOf("END:VEVENT"));
  });

  it("round-trips through parseIcs", () => {
    const parsed = parseIcs(serializeIcs([{ ...base, status: "COMPLETED" }, { ...base, uid: "n@droplet" }]));
    expect(parsed.find((e) => e.uid === "pm-1@droplet")?.status).toBe("COMPLETED");
    expect(parsed.find((e) => e.uid === "n@droplet")?.status).toBeUndefined();
  });
});

// ── WARP-3533: nothing a caller types may end a content line ──
//
// RFC 5545 ends a content line at CRLF, but consumers built on `str.splitlines()`
// (and any Unicode-aware line reader) also split on a bare CR, VT, FF, the
// 0x1C-0x1E separators, NEL, LS and PS. A work-item name is free text one person
// writes and a colleague's calendar app reads, so each of them must become a
// space. One case per character, through every text-typed and URI-typed field.
describe("serializeIcs — content-line injection (WARP-3533)", () => {
  /** Python's str.splitlines() boundaries: the strictest common reader. */
  const splitLikePython = (doc: string) => doc.split(/\r\n|[\n\r\u000B\u000C\u001C-\u001E\u0085\u{2028}\u{2029}]/u);

  const BREAKERS: Array<[string, string]> = [
    ["NUL", "\u0000"],
    ["bare CR", "\r"],
    ["VT", "\u000B"],
    ["FF", "\u000C"],
    ["FS (0x1C)", "\u001C"],
    ["US (0x1F)", "\u001F"],
    ["DEL", "\u007F"],
    ["NEL (U+0085)", "\u0085"],
    ["LS (U+2028)", String.fromCharCode(0x2028)],
    ["PS (U+2029)", String.fromCharCode(0x2029)],
  ];

  const base = {
    startsAt: new Date("2026-10-05T00:00:00Z"),
    endsAt: new Date("2026-10-06T00:00:00Z"),
    allDay: true,
  };

  it.each(BREAKERS)("%s in a name, description, place, link, calendar name or uid becomes a space and starts no line", (_name, ch) => {
    const out = serializeIcs(
      [
        {
          ...base,
          uid: `pm-1@droplet${ch}ATTENDEE:mailto:uid@x.test`,
          summary: `Standup${ch}BEGIN:VALARM${ch}ACTION:DISPLAY${ch}END:VALARM`,
          description: `Notes${ch}ATTENDEE:mailto:desc@x.test`,
          location: `Room${ch}ORGANIZER:mailto:loc@x.test`,
          meetingUrl: `https://box.test/projects?p=ABC${ch}URL:https://evil.test/`,
        },
      ],
      `Droplet${ch}X-EVIL:1`,
    );

    // The character itself is gone from the document (the CRLF line ends are the
    // only CRs there should be)…
    expect(out.replace(/\r\n/g, "")).not.toContain(ch);
    // …replaced by a space, in every field…
    expect(out).toContain("SUMMARY:Standup BEGIN:VALARM ACTION:DISPLAY END:VALARM\r\n");
    expect(out).toContain("DESCRIPTION:Notes ATTENDEE:mailto:desc@x.test\r\n");
    expect(out).toContain("LOCATION:Room ORGANIZER:mailto:loc@x.test\r\n");
    expect(out).toContain("URL:https://box.test/projects?p=ABC URL:https://evil.test/\r\n");
    expect(out).toContain("X-WR-CALNAME:Droplet X-EVIL:1\r\n");
    expect(out).toContain("UID:pm-1@droplet ATTENDEE:mailto:uid@x.test\r\n");
    // …so no reader, however it splits, finds a property or component the caller did not get.
    const lines = splitLikePython(out).filter(Boolean);
    expect(lines.filter((l) => l.startsWith("BEGIN:VALARM") || l.startsWith("END:VALARM"))).toEqual([]);
    for (const injected of ["ACTION:", "ATTENDEE", "ORGANIZER", "X-EVIL", "URL:https://evil"]) {
      expect(lines.filter((l) => l.startsWith(injected)), injected).toEqual([]);
    }
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("UID:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("URL:"))).toHaveLength(1);
  });

  it("still escapes a real line feed (CRLF or LF) as the \\n escape, and keeps a TAB", () => {
    const out = serializeIcs([{ ...base, uid: "a@droplet", summary: "one\r\ntwo\nthree\tfour", description: "x\r\ny" }]);
    expect(out).toContain("SUMMARY:one\\ntwo\\nthree\tfour\r\n");
    expect(out).toContain("DESCRIPTION:x\\ny\r\n");
  });

  it("a UID is one token: LF and TAB in it become spaces too", () => {
    const out = serializeIcs([{ ...base, uid: "a@droplet\nATTENDEE:mailto:x@y\tz", summary: "s" }]);
    expect(out).toContain("UID:a@droplet ATTENDEE:mailto:x@y z\r\n");
    expect(splitLikePython(out).some((l) => l.startsWith("ATTENDEE"))).toBe(false);
  });

  it("leaves ordinary text, Unicode and punctuation alone", () => {
    const out = serializeIcs([{ ...base, uid: "u@droplet", summary: "Café – naïve ✓ 日本語", description: "a; b, c \\ d" }]);
    expect(out).toContain("SUMMARY:Café – naïve ✓ 日本語\r\n");
    expect(out).toContain("DESCRIPTION:a\\; b\\, c \\\\ d\r\n");
  });
});

// ── WARP-2763: nested components must not leak into the parent VEVENT ──
//
// 🔴 Every fixture here puts the nested component AFTER the event's own
// properties, which is where real exporters put it. A fixture with the alarm
// FIRST passes against the broken parser too (last write wins), so it would be
// coverage in name only.
describe("parseIcs — nested components (WARP-2763)", () => {
  /** The same event, with and without a nested block appended before END:VEVENT. */
  function withAndWithout(nested: string): { plain: string; nestedIn: string } {
    const body = `UID:6h1abcdefg@google.com
SUMMARY:Coffee with Bob
DESCRIPTION:Bring the Q3 numbers and the signed lease. Parking code 4417.
LOCATION:Blue Bottle
DTSTART:20260423T140000Z
DTEND:20260423T150000Z`;
    const wrap = (inner: string) =>
      `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Test//EN\nBEGIN:VEVENT\n${inner}\nEND:VEVENT\nEND:VCALENDAR\n`;
    return { plain: wrap(body), nestedIn: wrap(`${body}\n${nested}`) };
  }

  it("a VALARM leaves the parent event byte-identical to having no VALARM", () => {
    const { plain, nestedIn } = withAndWithout(
      `BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:This is an event reminder
TRIGGER:-P0DT0H30M0S
END:VALARM`,
    );
    const [a] = parseIcs(plain);
    const [b] = parseIcs(nestedIn);
    expect(b.uid).toBe(a.uid);
    expect(b.summary).toBe(a.summary);
    expect(b.description).toBe(a.description);
    expect(b.location).toBe(a.location);
    // The regression this ticket exists for: Google's default popup reminder.
    expect(b.description).toBe("Bring the Q3 numbers and the signed lease. Parking code 4417.");
  });

  it("an ACTION:EMAIL alarm does not overwrite the event's SUMMARY", () => {
    // RFC 5545 makes SUMMARY *required* on an EMAIL alarm, so this one steals
    // the title as well as the body.
    const { nestedIn } = withAndWithout(
      `BEGIN:VALARM
ACTION:EMAIL
SUMMARY:Alarm notification
DESCRIPTION:This is an automated reminder
TRIGGER:-PT1H
END:VALARM`,
    );
    const [ev] = parseIcs(nestedIn);
    expect(ev.summary).toBe("Coffee with Bob");
    expect(ev.description).toBe("Bring the Q3 numbers and the signed lease. Parking code 4417.");
  });

  it("an alarm carrying its own UID does not re-key the event", () => {
    // The nastiest of the three: the upsert key is (sourceId, externalUid), so
    // a stolen UID writes the row under the alarm's identity and the duplicate
    // survives any later fix.
    const { nestedIn } = withAndWithout(
      `BEGIN:VALARM
ACTION:DISPLAY
UID:6E2A5F1C-ALARM
DESCRIPTION:Event reminder
TRIGGER:-PT15M
END:VALARM`,
    );
    const [ev] = parseIcs(nestedIn);
    expect(ev.uid).toBe("6h1abcdefg@google.com");
  });

  it("skips an unknown nested component without naming it", () => {
    // Depth-based, not a VALARM allow-list: a vendor extension nobody has
    // heard of must be inert by construction.
    const { nestedIn } = withAndWithout(
      `BEGIN:X-VENDOR-THING
UID:vendor-uid
SUMMARY:Vendor summary
DESCRIPTION:Vendor description
END:X-VENDOR-THING`,
    );
    const [ev] = parseIcs(nestedIn);
    expect(ev.uid).toBe("6h1abcdefg@google.com");
    expect(ev.summary).toBe("Coffee with Bob");
    expect(ev.description).toBe("Bring the Q3 numbers and the signed lease. Parking code 4417.");
  });

  it("tracks depth, so a nested-nested END does not end the skip early", () => {
    const { nestedIn } = withAndWithout(
      `BEGIN:VALARM
ACTION:DISPLAY
BEGIN:X-INNER
SUMMARY:Inner summary
END:X-INNER
DESCRIPTION:Alarm body that must not leak
END:VALARM`,
    );
    const [ev] = parseIcs(nestedIn);
    expect(ev.summary).toBe("Coffee with Bob");
    expect(ev.description).toBe("Bring the Q3 numbers and the signed lease. Parking code 4417.");
  });

  it("a VTIMEZONE with STANDARD/DAYLIGHT subcomponents yields no phantom events", () => {
    // VTIMEZONE sits at VCALENDAR level, and its subcomponents carry their own
    // DTSTART and RRULE. Nothing here may be mistaken for an event.
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTIMEZONE
TZID:America/Los_Angeles
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:real@example.com
SUMMARY:The only real event
DTSTART:20260423T140000Z
DTEND:20260423T150000Z
END:VEVENT
END:VCALENDAR
`;
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe("real@example.com");
  });
});

// ── WARP-2764: DTSTART/DTEND honour their TZID parameter ──
describe("parseIcs — TZID (WARP-2764)", () => {
  function eventWith(dtstart: string, dtend: string): string {
    return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:tz@example.com
SUMMARY:9am local
${dtstart}
${dtend}
END:VEVENT
END:VCALENDAR
`;
  }

  it("resolves a zoned wall clock west of UTC (PDT, -7)", () => {
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=America/Los_Angeles:20260423T090000",
        "DTEND;TZID=America/Los_Angeles:20260423T100000",
      ),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-04-23T16:00:00.000Z");
  });

  it("uses the offset in force on that date, not a fixed one (PST, -8)", () => {
    // Same wall clock, same zone, other side of the DST boundary. A hardcoded
    // -7 passes the test above and fails this one.
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=America/Los_Angeles:20261203T090000",
        "DTEND;TZID=America/Los_Angeles:20261203T100000",
      ),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-12-03T17:00:00.000Z");
  });

  it("resolves a zone east of UTC (CEST, +2)", () => {
    // A sign error passes both tests above and fails this one.
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=Europe/Berlin:20260423T090000",
        "DTEND;TZID=Europe/Berlin:20260423T100000",
      ),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-04-23T07:00:00.000Z");
  });

  it("converts DTEND on the same path, so the duration survives", () => {
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=America/Los_Angeles:20260423T090000",
        "DTEND;TZID=America/Los_Angeles:20260423T100000",
      ),
    );
    expect(ev.endsAt.getTime() - ev.startsAt.getTime()).toBe(60 * 60 * 1000);
    expect(ev.endsAt.toISOString()).toBe("2026-04-23T17:00:00.000Z");
  });

  it("drops an event whose TZID the runtime cannot resolve — never assumes UTC", () => {
    // Exchange still emits Windows zone names. Storing 09:00Z here would be
    // the exact defect this ticket fixed, so the event is dropped instead.
    const events = parseIcs(
      eventWith(
        "DTSTART;TZID=W. Europe Standard Time:20260423T090000",
        "DTEND;TZID=W. Europe Standard Time:20260423T100000",
      ),
    );
    expect(events).toHaveLength(0);
  });

  it("an explicit Z still wins, and a TZID alongside it is not double-applied", () => {
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=America/Los_Angeles:20260423T140000Z",
        "DTEND;TZID=America/Los_Angeles:20260423T150000Z",
      ),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-04-23T14:00:00.000Z");
  });

  it("a floating DATE-TIME with no TZID is unchanged (still treated as UTC)", () => {
    const [ev] = parseIcs(
      eventWith("DTSTART:20260423T140000", "DTEND:20260423T150000"),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-04-23T14:00:00.000Z");
  });

  // ── RFC 5545 §3.3.5, the two cases the naive two-pass version got wrong ──

  it("a repeated (fall-back) local time takes the FIRST occurrence, west of UTC", () => {
    // The RFC's own worked example, verbatim: "TZID=America/New_York:
    // 20071104T013000 indicates November 4, 2007 at 1:30 A.M. EDT (UTC-04:00)".
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=America/New_York:20071104T013000",
        "DTEND;TZID=America/New_York:20071104T023000",
      ),
    );
    expect(ev.startsAt.toISOString()).toBe("2007-11-04T05:30:00.000Z");
  });

  it("a repeated local time takes the FIRST occurrence EAST of UTC too", () => {
    // 02:30 occurs twice in Berlin on 2026-10-25 (00:30Z and 01:30Z). The
    // earlier is correct. The previous implementation returned the later one
    // here — and in all 73 DST zones east of UTC — while passing the test above,
    // because the west-of-UTC case happens to come out right by accident.
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=Europe/Berlin:20261025T023000",
        "DTEND;TZID=Europe/Berlin:20261025T033000",
      ),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("a nonexistent (spring-forward) local time shifts FORWARD past the gap", () => {
    // §3.3.5: a local time that does not occur is "interpreted using the UTC
    // offset before the gap". Berlin jumps 02:00→03:00 on 2026-03-29, so 02:30
    // never happens; the pre-gap offset (+01:00) puts it at 01:30Z.
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=Europe/Berlin:20260329T023000",
        "DTEND;TZID=Europe/Berlin:20260329T033000",
      ),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("a midnight gap does not move the event to the previous calendar day", () => {
    // Santiago transitions AT midnight, so 00:00 on 2026-09-06 does not exist.
    // Resolving it backward lands on 2026-09-05 — a whole day out on a date
    // nobody would think to check. Only a midnight-transition zone catches this.
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=America/Santiago:20260906T000000",
        "DTEND;TZID=America/Santiago:20260906T010000",
      ),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-09-06T04:00:00.000Z");
    // The day is the point of this test, not just the instant.
    expect(ev.startsAt.toISOString().slice(0, 10)).toBe("2026-09-06");
  });

  it("drops an event the gap would invert, rather than persisting end-before-start", () => {
    // New York jumps 02:00 EST → 03:00 EDT on 2026-03-08, so [02:00, 03:00) is
    // a gap. A DTSTART inside it resolves forward to 03:30 EDT (07:30Z) while a
    // DTEND of 03:00 already exists at 07:00Z — the start overtakes the end.
    //
    // 🔴 The obvious trigger does NOT reproduce this: DTSTART 01:45 / DTEND
    // 02:15 (end in the gap, start before it) resolves to a clean +30 min,
    // because shifting the END forward only widens the event. The start must be
    // the one inside the gap. A test built on the wrong half of that pair passes
    // with the guard deleted and pins nothing.
    const events = parseIcs(
      eventWith(
        "DTSTART;TZID=America/New_York:20260308T023000",
        "DTEND;TZID=America/New_York:20260308T030000",
      ),
    );
    expect(events).toHaveLength(0);
  });

  it("keeps a zero-length event — only strictly inverted rows are dropped", () => {
    // `>=` not `>`: some exporters emit zero-length markers and they are
    // harmless to an overlap query. Guards the guard against over-reach.
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=America/Los_Angeles:20260423T090000",
        "DTEND;TZID=America/Los_Angeles:20260423T090000",
      ),
    );
    expect(ev.endsAt.getTime()).toBe(ev.startsAt.getTime());
  });

  // ── TZID parameter spellings (RFC 5545 §3.2 and §3.2.19) ──

  it("resolves a DQUOTEd TZID — the quotes are delimiters, not part of the name", () => {
    const [ev] = parseIcs(
      eventWith(
        'DTSTART;TZID="America/Los_Angeles":20260423T090000',
        'DTEND;TZID="America/Los_Angeles":20260423T100000',
      ),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-04-23T16:00:00.000Z");
  });

  it("resolves a solidus-prefixed globally-unique TZID (§3.2.19)", () => {
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=/America/Los_Angeles:20260423T090000",
        "DTEND;TZID=/America/Los_Angeles:20260423T100000",
      ),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-04-23T16:00:00.000Z");
  });

  it("resolves Thunderbird's vendor-prefixed TZID by longest resolvable suffix", () => {
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=/mozilla.org/20050126_1/America/New_York:20260423T090000",
        "DTEND;TZID=/mozilla.org/20050126_1/America/New_York:20260423T100000",
      ),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-04-23T13:00:00.000Z");
  });

  it("keeps three-component zones intact when stripping a vendor prefix", () => {
    // 🔴 A fixed "last two segments" rule mangles the 19 three-component zones
    // (America/Indiana/*, America/Argentina/*, …) into non-zones that then drop.
    // Longest-resolvable-suffix is what makes this pass.
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;TZID=/mozilla.org/20070129_1/America/Indiana/Knox:20260423T090000",
        "DTEND;TZID=/mozilla.org/20070129_1/America/Indiana/Knox:20260423T100000",
      ),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-04-23T14:00:00.000Z");
  });

  it("still drops a quoted Windows zone name — unquoting did not weaken the guard", () => {
    const events = parseIcs(
      eventWith(
        'DTSTART;TZID="W. Europe Standard Time":20260423T090000',
        'DTEND;TZID="W. Europe Standard Time":20260423T100000',
      ),
    );
    expect(events).toHaveLength(0);
  });

  // ── TZID present but empty: legal, and NOT the floating case ──
  //
  // RFC 5545 §3.2 defines `param-value = paramtext / quoted-string` and
  // `paramtext = *SAFE-CHAR` — zero characters is a legal paramtext, so
  // `TZID=` parses to a TZID parameter whose value is the empty string. That
  // is "a zone the emitter failed to name", not "no zone": the value is still
  // a local wall clock. Guarding the zone branch on the parameter's TRUTHINESS
  // rather than its PRESENCE routes it to the floating path, which stamps a Z
  // on 09:00 local — the exact WARP-2764 defect, reintroduced for one input
  // shape. An unnameable zone is an unresolvable zone, so it belongs in the
  // module header's one documented drop class.

  it("drops an event whose TZID is present but empty — never stores the wall clock as UTC", () => {
    const events = parseIcs(
      eventWith("DTSTART;TZID=:20260423T090000", "DTEND;TZID=:20260423T100000"),
    );
    expect(events).toHaveLength(0);
  });

  it("drops a DQUOTEd empty TZID too — unquoting `\"\"` must not read as absent", () => {
    const events = parseIcs(
      eventWith('DTSTART;TZID="":20260423T090000', 'DTEND;TZID="":20260423T100000'),
    );
    expect(events).toHaveLength(0);
  });

  it("drops a whitespace-only TZID — trimming to empty resolves no zone", () => {
    const events = parseIcs(
      eventWith("DTSTART;TZID=   :20260423T090000", "DTEND;TZID=   :20260423T100000"),
    );
    expect(events).toHaveLength(0);
  });

  it("drops the event when only DTEND carries the empty TZID", () => {
    // Half a mis-stored event is still a mis-stored event: DTEND runs the same
    // path as DTSTART, so an empty TZID on either end drops the whole row
    // rather than silently stretching one boundary.
    //
    // The zone is deliberately EAST of UTC. West of UTC the mis-stored DTEND
    // lands BEFORE the DTSTART and the §3.6.1 inversion check at END:VEVENT
    // drops the event anyway — the test would pass without the presence check
    // and prove nothing. Berlin 09:00 CEST is 07:00Z, so a DTEND wrongly read
    // as 10:00Z still sorts after it and survives that check, silently
    // tripling a one-hour event.
    const events = parseIcs(
      eventWith("DTSTART;TZID=Europe/Berlin:20260423T090000", "DTEND;TZID=:20260423T100000"),
    );
    expect(events).toHaveLength(0);
  });

  it("an explicit Z still wins over an empty TZID — §3.3.5 order is unchanged", () => {
    // The presence check must not promote a UTC value into the zone branch:
    // §3.3.5 forbids TZID on a Z-suffixed value, so Z keeps winning.
    const [ev] = parseIcs(
      eventWith("DTSTART;TZID=:20260423T140000Z", "DTEND;TZID=:20260423T150000Z"),
    );
    expect(ev.startsAt.toISOString()).toBe("2026-04-23T14:00:00.000Z");
    expect(ev.endsAt.toISOString()).toBe("2026-04-23T15:00:00.000Z");
  });

  it("an all-day DATE with an empty TZID is still an all-day DATE", () => {
    // The DATE form returns before the zone branch — TZID does not apply to a
    // value with no time of day, empty or not.
    const [ev] = parseIcs(
      eventWith("DTSTART;VALUE=DATE;TZID=:20260501", "DTEND;VALUE=DATE;TZID=:20260508"),
    );
    expect(ev.allDay).toBe(true);
    expect(ev.startsAt.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(ev.endsAt.toISOString()).toBe("2026-05-08T00:00:00.000Z");
  });

  it("an all-day DATE is unaffected by a TZID parameter", () => {
    const [ev] = parseIcs(
      eventWith(
        "DTSTART;VALUE=DATE;TZID=America/Los_Angeles:20260501",
        "DTEND;VALUE=DATE;TZID=America/Los_Angeles:20260508",
      ),
    );
    expect(ev.allDay).toBe(true);
    expect(ev.startsAt.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});
