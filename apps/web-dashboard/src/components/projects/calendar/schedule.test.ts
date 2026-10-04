import { describe, it, expect, afterAll } from "vitest";
import {
  describeSchedule,
  dueOn,
  isOverdueOn,
  isTerminal,
  sameSchedule,
  scheduleBody,
  scheduleOf,
  shiftSchedule,
  spanOf,
  withDue,
  withStart,
} from "./schedule";

const originalTz = process.env.TZ;
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const open = { group: "started" as const };

describe("scheduleOf / sameSchedule", () => {
  it("reads both the ISO-datetime and the date-only wire forms as the same calendar dates", () => {
    expect(scheduleOf({ startDate: "2026-10-03T00:00:00.000Z", dueDate: "2026-10-08T00:00:00.000Z" })).toEqual({
      startDate: "2026-10-03",
      dueDate: "2026-10-08",
    });
    expect(scheduleOf({ startDate: null, dueDate: "2026-10-08" })).toEqual({ startDate: null, dueDate: "2026-10-08" });
    expect(scheduleOf({ startDate: null, dueDate: null })).toEqual({ startDate: null, dueDate: null });
  });

  it("sameSchedule compares both fields", () => {
    expect(sameSchedule({ startDate: "2026-10-03", dueDate: null }, { startDate: "2026-10-03", dueDate: null })).toBe(true);
    expect(sameSchedule({ startDate: "2026-10-03", dueDate: null }, { startDate: null, dueDate: "2026-10-03" })).toBe(false);
  });
});

describe("spanOf", () => {
  it("is null when nothing is scheduled", () => {
    expect(spanOf({ startDate: null, dueDate: null })).toBeNull();
  });

  it("one date is a point, whichever field carries it", () => {
    expect(spanOf({ startDate: null, dueDate: "2026-10-08" })).toEqual({
      start: "2026-10-08", end: "2026-10-08", kind: "point", inverted: false, days: 1,
    });
    expect(spanOf({ startDate: "2026-10-08", dueDate: null })).toMatchObject({ kind: "point", start: "2026-10-08" });
  });

  it("two dates are an inclusive span — even on the same day", () => {
    expect(spanOf({ startDate: "2026-10-03", dueDate: "2026-10-08" })).toEqual({
      start: "2026-10-03", end: "2026-10-08", kind: "span", inverted: false, days: 6,
    });
    expect(spanOf({ startDate: "2026-10-03", dueDate: "2026-10-03" })).toMatchObject({ kind: "span", days: 1 });
  });

  it("tolerates start > due by drawing the span between them and flagging it", () => {
    expect(spanOf({ startDate: "2026-10-20", dueDate: "2026-10-10" })).toEqual({
      start: "2026-10-10", end: "2026-10-20", kind: "span", inverted: true, days: 11,
    });
  });
});

describe("shifting and resizing", () => {
  it("shifts only the dates that are set, across month and DST boundaries", () => {
    expect(shiftSchedule({ startDate: "2026-10-30", dueDate: "2026-11-03" }, 2)).toEqual({
      startDate: "2026-11-01", dueDate: "2026-11-05",
    });
    expect(shiftSchedule({ startDate: null, dueDate: "2026-09-26" }, 2)).toEqual({ startDate: null, dueDate: "2026-09-28" });
    expect(shiftSchedule({ startDate: null, dueDate: null }, 5)).toEqual({ startDate: null, dueDate: null });
    expect(shiftSchedule({ startDate: "2026-10-03", dueDate: "2026-10-08" }, -7)).toEqual({
      startDate: "2026-09-26", dueDate: "2026-10-01",
    });
  });

  it("withStart / withDue never invert a span", () => {
    const s = { startDate: "2026-10-03", dueDate: "2026-10-08" };
    expect(withStart(s, "2026-10-01")).toEqual({ startDate: "2026-10-01", dueDate: "2026-10-08" });
    expect(withStart(s, "2026-10-20")).toEqual({ startDate: "2026-10-08", dueDate: "2026-10-08" });
    expect(withDue(s, "2026-10-12")).toEqual({ startDate: "2026-10-03", dueDate: "2026-10-12" });
    expect(withDue(s, "2026-09-01")).toEqual({ startDate: "2026-10-03", dueDate: "2026-10-03" });
  });

  it("a point has no edges to resize", () => {
    const p = { startDate: null, dueDate: "2026-10-08" };
    expect(withStart(p, "2026-10-01")).toBe(p);
    expect(withDue(p, "2026-10-20")).toBe(p);
  });

  it("dueOn places an unscheduled item on one day", () => {
    expect(dueOn("2026-10-08")).toEqual({ startDate: null, dueDate: "2026-10-08" });
  });
});

describe("scheduleBody", () => {
  it("sends only what changed, as the datetime PATCH accepts", () => {
    expect(
      scheduleBody({ startDate: "2026-10-03", dueDate: "2026-10-08" }, { startDate: "2026-10-04", dueDate: "2026-10-09" }),
    ).toEqual({ start_date: "2026-10-04T00:00:00.000Z", due_date: "2026-10-09T00:00:00.000Z" });
    expect(scheduleBody({ startDate: null, dueDate: "2026-10-08" }, { startDate: null, dueDate: "2026-10-09" })).toEqual({
      due_date: "2026-10-09T00:00:00.000Z",
    });
  });

  it("clears a date with null and sets an unscheduled item's due date", () => {
    expect(scheduleBody({ startDate: "2026-10-03", dueDate: "2026-10-08" }, { startDate: null, dueDate: "2026-10-08" })).toEqual({
      start_date: null,
    });
    expect(scheduleBody({ startDate: null, dueDate: null }, dueOn("2026-10-08"))).toEqual({
      due_date: "2026-10-08T00:00:00.000Z",
    });
  });

  it("an unchanged schedule is an empty body", () => {
    expect(scheduleBody({ startDate: "2026-10-03", dueDate: null }, { startDate: "2026-10-03", dueDate: null })).toEqual({});
  });
});

describe("isOverdueOn — by calendar day, not by instant", () => {
  const item = (dueDate: string | null, state: { group: "started" | "completed" | "cancelled" } | null = open) => ({ dueDate, state });

  it("an item due today is not overdue; yesterday is", () => {
    expect(isOverdueOn(item("2026-10-03T00:00:00.000Z"), "2026-10-03")).toBe(false);
    expect(isOverdueOn(item("2026-10-02T00:00:00.000Z"), "2026-10-03")).toBe(true);
    expect(isOverdueOn(item("2026-10-04"), "2026-10-03")).toBe(false);
  });

  it("completed, cancelled and undated items are never overdue; a stateless item counts as open", () => {
    expect(isOverdueOn(item("2026-01-01", { group: "completed" }), "2026-10-03")).toBe(false);
    expect(isOverdueOn(item("2026-01-01", { group: "cancelled" }), "2026-10-03")).toBe(false);
    expect(isOverdueOn(item(null), "2026-10-03")).toBe(false);
    expect(isOverdueOn(item("2026-01-01", null), "2026-10-03")).toBe(true);
  });

  it.each(["America/Los_Angeles", "Pacific/Auckland"])("is TZ-independent — TZ=%s", (tz) => {
    process.env.TZ = tz;
    // The API stores 00:00:00Z; the instant is already "in the past" the evening
    // before in LA, but the calendar day is what counts.
    expect(isOverdueOn(item("2026-10-03T00:00:00.000Z"), "2026-10-03")).toBe(false);
    expect(isOverdueOn(item("2026-10-03T00:00:00.000Z"), "2026-10-04")).toBe(true);
  });

  it("isTerminal", () => {
    expect(isTerminal({ state: { group: "completed" } })).toBe(true);
    expect(isTerminal({ state: { group: "started" } })).toBe(false);
    expect(isTerminal({ state: null })).toBe(false);
  });
});

describe("describeSchedule", () => {
  it("names a day, a span, or nothing", () => {
    expect(describeSchedule({ startDate: null, dueDate: "2026-10-08" }, "en-US")).toBe("Oct 8");
    expect(describeSchedule({ startDate: "2026-10-03", dueDate: "2026-10-08" }, "en-US")).toBe("Oct 3 – Oct 8");
    expect(describeSchedule({ startDate: "2026-10-03", dueDate: "2026-10-03" }, "en-US")).toBe("Oct 3");
    expect(describeSchedule({ startDate: null, dueDate: null }, "en-US")).toBe("No dates");
  });
});
