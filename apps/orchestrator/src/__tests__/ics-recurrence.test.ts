import { describe, it, expect } from "vitest";
import { parseIcs } from "../services/ics.js";
import { expandIcsEvents, parseRrule } from "../services/ics-recurrence.js";

const NOW = new Date("2026-09-27T12:00:00Z");

function feed(...vevents: string[]): string {
  return ["BEGIN:VCALENDAR", ...vevents.map((v) => `BEGIN:VEVENT\n${v.trim()}\nEND:VEVENT`), "END:VCALENDAR"].join("\n");
}
const expand = (...vevents: string[]) => expandIcsEvents(parseIcs(feed(...vevents)), NOW);
const starts = (evs: { startsAt: Date }[]) => evs.map((e) => e.startsAt.toISOString());

describe("WARP-3266 recurrence expansion", () => {
  it("WEEKLY + BYDAY + COUNT: every listed weekday, COUNT including DTSTART", async () => {
    const out = await expand(`
UID:w@x
SUMMARY:Standup
DTSTART:20260907T160000Z
DTEND:20260907T163000Z
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5`);
    expect(starts(out)).toEqual([
      "2026-09-07T16:00:00.000Z",
      "2026-09-09T16:00:00.000Z",
      "2026-09-14T16:00:00.000Z",
      "2026-09-16T16:00:00.000Z",
      "2026-09-21T16:00:00.000Z",
    ]);
    expect(out.every((e) => e.recurrence === "occurrence")).toBe(true);
    expect(out[1]!.endsAt.toISOString()).toBe("2026-09-09T16:30:00.000Z");
    expect(new Set(out.map((e) => e.key)).size).toBe(5);
    expect(out[0]!.key).toBe("w@x::2026-09-07T16:00:00.000Z");
  });

  it("keeps the wall clock in the DTSTART zone across a DST change", async () => {
    const out = await expand(`
UID:tz@x
SUMMARY:Weekly
DTSTART;TZID=America/Los_Angeles:20261026T090000
DTEND;TZID=America/Los_Angeles:20261026T100000
RRULE:FREQ=WEEKLY;COUNT=2`);
    // PDT (UTC-7) then PST (UTC-8) after Nov 1.
    expect(starts(out)).toEqual(["2026-10-26T16:00:00.000Z", "2026-11-02T17:00:00.000Z"]);
  });

  it("UNTIL is inclusive and stops the series", async () => {
    const out = await expand(`
UID:d@x
SUMMARY:Daily
DTSTART:20260901T080000Z
DTEND:20260901T081500Z
RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20260907T080000Z`);
    expect(starts(out)).toEqual([
      "2026-09-01T08:00:00.000Z",
      "2026-09-03T08:00:00.000Z",
      "2026-09-05T08:00:00.000Z",
      "2026-09-07T08:00:00.000Z",
    ]);
  });

  it("EXDATE removes an instance but still counts toward COUNT; RECURRENCE-ID moves one, CANCELLED drops one", async () => {
    const out = await expand(
      `
UID:s@x
SUMMARY:Sync
DTSTART:20261005T150000Z
DTEND:20261005T160000Z
RRULE:FREQ=WEEKLY;COUNT=5
EXDATE:20261012T150000Z`,
      `
UID:s@x
SUMMARY:Sync (moved)
RECURRENCE-ID:20261019T150000Z
DTSTART:20261020T170000Z
DTEND:20261020T180000Z`,
      `
UID:s@x
SUMMARY:Sync
STATUS:CANCELLED
RECURRENCE-ID:20261026T150000Z
DTSTART:20261026T150000Z
DTEND:20261026T160000Z`,
    );
    expect(starts(out)).toEqual([
      "2026-10-05T15:00:00.000Z",
      "2026-10-20T17:00:00.000Z",
      "2026-11-02T15:00:00.000Z",
    ]);
    const moved = out[1]!;
    expect(moved.summary).toBe("Sync (moved)");
    // Keyed on the ORIGINAL start, so the row the master made is updated in place.
    expect(moved.key).toBe("s@x::2026-10-19T15:00:00.000Z");
  });

  it("DATE-form EXDATE on an all-day series", async () => {
    const out = await expand(`
UID:a@x
SUMMARY:Off-site
DTSTART;VALUE=DATE:20261001
DTEND;VALUE=DATE:20261002
RRULE:FREQ=DAILY;COUNT=3
EXDATE;VALUE=DATE:20261002`);
    expect(starts(out)).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-03T00:00:00.000Z"]);
    expect(out.every((e) => e.allDay)).toBe(true);
  });

  it("MONTHLY BYDAY ordinal and BYMONTHDAY; YEARLY with BYMONTH", async () => {
    const board = await expand(`
UID:m@x
SUMMARY:Board
DTSTART:20260908T170000Z
DTEND:20260908T180000Z
RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3`);
    expect(starts(board)).toEqual([
      "2026-09-08T17:00:00.000Z",
      "2026-10-13T17:00:00.000Z",
      "2026-11-10T17:00:00.000Z",
    ]);
    const last = await expand(`
UID:l@x
SUMMARY:Payroll
DTSTART;VALUE=DATE:20260930
RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3`);
    expect(starts(last)).toEqual([
      "2026-09-30T00:00:00.000Z",
      "2026-10-31T00:00:00.000Z",
      "2026-11-30T00:00:00.000Z",
    ]);
    const yearly = await expand(`
UID:y@x
SUMMARY:Thanksgiving
DTSTART;VALUE=DATE:20261126
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=2`);
    expect(starts(yearly)).toEqual(["2026-11-26T00:00:00.000Z", "2027-11-25T00:00:00.000Z"]);
  });

  it("an open-ended series is bounded by the window (12 months back, 18 ahead)", async () => {
    const out = await expand(`
UID:o@x
SUMMARY:Weekly forever
DTSTART:20200106T090000Z
DTEND:20200106T100000Z
RRULE:FREQ=WEEKLY`);
    const first = out[0]!.startsAt.getTime();
    const last = out[out.length - 1]!.startsAt.getTime();
    expect(first).toBeGreaterThanOrEqual(new Date("2025-09-27T00:00:00Z").getTime() - 7 * 86_400_000);
    expect(last).toBeLessThanOrEqual(new Date("2028-03-27T12:00:00Z").getTime());
    expect(out.length).toBeGreaterThan(120);
    expect(out.length).toBeLessThan(135);
  });

  it("an unsupported rule is stored as its first instance, marked — never dropped", async () => {
    const out = await expand(`
UID:u@x
SUMMARY:Last workday
DTSTART:20260930T090000Z
DTEND:20260930T100000Z
RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "u@x", recurrence: "unexpanded" });
    expect(parseRrule("FREQ=HOURLY", undefined)).toBeNull();
    expect(parseRrule("FREQ=WEEKLY;BYDAY=1MO", undefined)).toBeNull();
  });

  it("a one-off event passes through keyed on its UID", async () => {
    const out = await expand(`
UID:one@x
SUMMARY:Coffee
DTSTART:20200101T090000Z
DTEND:20200101T100000Z`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "one@x", recurrence: "none" });
  });

  it("MONTHLY on the 31st skips short months (RFC 5545)", async () => {
    const out = await expand(`
UID:31@x
SUMMARY:Month end
DTSTART:20260131T090000Z
DTEND:20260131T100000Z
RRULE:FREQ=MONTHLY;COUNT=4`);
    expect(starts(out)).toEqual([
      "2026-01-31T09:00:00.000Z",
      "2026-03-31T09:00:00.000Z",
      "2026-05-31T09:00:00.000Z",
      "2026-07-31T09:00:00.000Z",
    ]);
  });

  it("YEARLY on Feb 29 only lands in leap years", async () => {
    const out = await expand(`
UID:leap@x
SUMMARY:Leap day
DTSTART;VALUE=DATE:20240229
RRULE:FREQ=YEARLY`);
    // 2024-02-29 is before the window; 2028-02-29 is the only one inside it.
    expect(starts(out)).toEqual(["2028-02-29T00:00:00.000Z"]);
  });

  it("MONTHLY BYDAY=-1FR is the last Friday", async () => {
    const out = await expand(`
UID:lf@x
SUMMARY:Payday
DTSTART:20260925T170000Z
DTEND:20260925T173000Z
RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3`);
    expect(starts(out)).toEqual([
      "2026-09-25T17:00:00.000Z",
      "2026-10-30T17:00:00.000Z",
      "2026-11-27T17:00:00.000Z",
    ]);
  });

  it("UNTIL in DATE form includes that day, in the series' zone", async () => {
    const out = await expand(`
UID:ud@x
SUMMARY:Weekly
DTSTART;TZID=America/Los_Angeles:20261001T090000
DTEND;TZID=America/Los_Angeles:20261001T100000
RRULE:FREQ=WEEKLY;UNTIL=20261015`);
    expect(starts(out)).toEqual([
      "2026-10-01T16:00:00.000Z",
      "2026-10-08T16:00:00.000Z",
      "2026-10-15T16:00:00.000Z",
    ]);
  });

  it("an old DTSTART (1950) still fills the window — fast-forward, no silent drop", async () => {
    const out = await expand(`
UID:old@x
SUMMARY:Daily since 1950
DTSTART:19500101T090000Z
DTEND:19500101T100000Z
RRULE:FREQ=DAILY`);
    expect(out[0]!.startsAt.toISOString()).toBe("2025-09-28T09:00:00.000Z");
    expect(out[out.length - 1]!.startsAt.toISOString()).toBe("2028-03-27T09:00:00.000Z");
    expect(out.length).toBe(912);
    expect(out.every((e) => e.recurrence === "occurrence")).toBe(true);
  });

  it("an old DTSTART with COUNT counts the instances before the window", async () => {
    const out = await expand(`
UID:oc@x
SUMMARY:400 days
DTSTART:20240927T090000Z
DTEND:20240927T100000Z
RRULE:FREQ=DAILY;COUNT=400`);
    expect(out[0]!.startsAt.toISOString()).toBe("2025-09-28T09:00:00.000Z");
    expect(out[out.length - 1]!.startsAt.toISOString()).toBe("2025-10-31T09:00:00.000Z");
  });

  const hostile = (count: string) =>
    Array.from(
      { length: 5 },
      (_, i) => `
UID:h${i}@x
SUMMARY:Hostile
DTSTART;TZID=America/New_York:10000101T090000
DTEND;TZID=America/New_York:10000101T100000
RRULE:FREQ=YEARLY;BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12;BYMONTHDAY=${Array.from({ length: 28 }, (_, d) => d + 1).join(",")}${count}`,
    );

  it("work bound: a hostile feed from the year 1000 without COUNT finishes fast", async () => {
    const t0 = performance.now();
    const out = await expand(...hostile(""));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out.length).toBeLessThanOrEqual(5 * 1000);
  });

  it("work bound: with a COUNT that forces a walk past the budget, the series are stored unexpanded", async () => {
    const t0 = performance.now();
    const out = await expand(...hostile(";COUNT=10000000"));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out).toHaveLength(5);
    expect(out.every((e) => e.recurrence === "unexpanded")).toBe(true);
    expect(out.map((e) => e.key).sort()).toEqual(["h0@x", "h1@x", "h2@x", "h3@x", "h4@x"]);
  });
});
