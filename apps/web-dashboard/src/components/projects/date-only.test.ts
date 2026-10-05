// date-only — a due / start date is a calendar date, pinned to two zones (WARP-3372).
//
// The Projects surface used to pass a date through `new Date(...)` and read the
// LOCAL getters, so the day a person typed came back one early west of UTC. The
// helper reads the string and never builds a Date from a date, so the answer is
// the same in every zone; each case below runs under America/Los_Angeles (west
// of UTC, where the bug lives) and Pacific/Auckland (east of it).
//
// Zone is pinned by assigning `process.env.TZ` before any Date is read, and the
// offset is asserted so a runtime that ignores the change fails loudly instead
// of passing in the wrong zone.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dateOnly, formatDayMonth, isBeforeToday, localToday } from "./date-only";
import { fmtDate, fmtISODate, isOverdue } from "./config";
import type { PmState } from "./types";

const LA = "America/Los_Angeles";
const AKL = "Pacific/Auckland";
const ORIGINAL_TZ = process.env.TZ;

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const OPEN: PmState = { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: null, sortOrder: 1, isDefault: true };
const DONE: PmState = { ...OPEN, id: "s2", name: "Done", group: "completed" };
const CANCELLED: PmState = { ...OPEN, id: "s3", name: "Cancelled", group: "cancelled" };

describe.each([LA, AKL])("date-only under TZ=%s", (zone) => {
  beforeAll(() => {
    process.env.TZ = zone;
    expect(new Date(2026, 5, 25).getTimezoneOffset()).toBe(zone === LA ? 420 : -720);
  });

  it("pins the bug: the old display (local getters on the stored midnight) was a day early here", () => {
    const old = (iso: string) => {
      const d = new Date(iso);
      return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun"][d.getMonth()]} ${d.getDate()}`;
    };
    expect(old("2026-06-25T00:00:00.000Z")).toBe(zone === LA ? "Jun 24" : "Jun 25");
  });

  it("the date entered is the date shown, in every zone", () => {
    expect(fmtDate("2026-06-25")).toBe("Jun 25");
    expect(fmtISODate("2026-06-25")).toBe("2026-06-25");
    expect(formatDayMonth("2026-01-01")).toBe("Jan 1");
    expect(formatDayMonth("2026-12-31")).toBe("Dec 31");
  });

  it("a response from before date-only (an instant at stored midnight) shows the same day", () => {
    expect(fmtDate("2026-06-25T00:00:00.000Z")).toBe("Jun 25");
    expect(fmtISODate("2026-06-25T00:00:00.000Z")).toBe("2026-06-25");
    expect(dateOnly("2026-06-25T00:00:00.000Z")).toBe("2026-06-25");
  });

  it("empty and malformed values show nothing rather than NaN", () => {
    for (const bad of [null, undefined, "", "tomorrow", "2026-13-01", "2026-00-10", "2026-06-00", "06/25/2026", "20260625"]) {
      expect(dateOnly(bad), String(bad)).toBeNull();
      expect(fmtDate(bad), String(bad)).toBeNull();
      expect(fmtISODate(bad), String(bad)).toBe("—");
    }
  });

  it("localToday is the viewer's own calendar day", () => {
    expect(localToday(new Date(2026, 5, 25, 23, 59, 59))).toBe("2026-06-25");
    expect(localToday(new Date(2026, 5, 26, 0, 0, 1))).toBe("2026-06-26");
    expect(localToday(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
  });

  it("due today is not overdue; the day after is — on the viewer's wall clock", () => {
    expect(isBeforeToday("2026-06-25", new Date(2026, 5, 25, 0, 0, 1))).toBe(false);
    expect(isBeforeToday("2026-06-25", new Date(2026, 5, 25, 23, 59, 59))).toBe(false);
    expect(isBeforeToday("2026-06-25", new Date(2026, 5, 26, 0, 0, 1))).toBe(true);
    expect(isBeforeToday(null, new Date(2026, 5, 26))).toBe(false);
  });

  it("overdue uses the viewer's local day: one instant is a different day in the two zones", () => {
    // 03:00Z on the 26th is 20:00 on the 25th in Los Angeles and 15:00 on the
    // 26th in Auckland.
    const now = new Date("2026-06-26T03:00:00.000Z");
    expect(localToday(now)).toBe(zone === LA ? "2026-06-25" : "2026-06-26");
    // An item due on the 25th: still due today in LA, a day late in Auckland.
    expect(isBeforeToday("2026-06-25", now)).toBe(zone !== LA);
    // The old math compared the stored midnight to the instant and called it
    // overdue in BOTH — wrong for the person in Los Angeles.
    expect(new Date("2026-06-25").getTime() < now.getTime()).toBe(true);
  });

  it("isOverdue: open work only, and terminal work never", () => {
    const now = new Date(2026, 5, 26, 9, 0, 0);
    expect(isOverdue({ dueDate: "2026-06-25", state: OPEN }, now)).toBe(true);
    expect(isOverdue({ dueDate: "2026-06-25", state: null }, now)).toBe(true);
    expect(isOverdue({ dueDate: "2026-06-26", state: OPEN }, now)).toBe(false);
    expect(isOverdue({ dueDate: "2026-06-25", state: DONE }, now)).toBe(false);
    expect(isOverdue({ dueDate: "2026-06-25", state: CANCELLED }, now)).toBe(false);
    expect(isOverdue({ dueDate: null, state: OPEN }, now)).toBe(false);
  });
});

import {
  dayDiff,
  daysLeftLabel,
  fmtDay,
  fmtDayYear,
  fmtRange,
  parseDateOnly,
} from "./date-only";

describe("parseDateOnly", () => {
  it("parses a real calendar date", () => {
    expect(parseDateOnly("2026-10-05")).toEqual({ y: 2026, m: 10, d: 5 });
  });

  it.each(["2026-10-5", "2026/10/05", "2026-10-05T00:00:00Z", "", " 2026-10-05", "tomorrow"])(
    "rejects the malformed value %j",
    (v) => {
      expect(parseDateOnly(v)).toBeNull();
    },
  );

  it.each(["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-02-29"])(
    "rejects the impossible date %s",
    (v) => {
      expect(parseDateOnly(v)).toBeNull();
    },
  );

  it("is null-safe", () => {
    expect(parseDateOnly(null)).toBeNull();
    expect(parseDateOnly(undefined)).toBeNull();
  });
});

describe("formatting never goes through a local-time Date", () => {
  // The whole point: these must not shift a day for anyone, whatever the zone.
  const prev = process.env.TZ;
  const restore = () => {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  };

  it.each(["America/Los_Angeles", "Pacific/Auckland", "UTC", "Pacific/Kiritimati"])(
    "the date entered is the date shown in %s",
    (tz) => {
      try {
        process.env.TZ = tz;
        expect(fmtDay("2026-10-05")).toBe("Oct 5");
        expect(fmtDayYear("2026-01-01")).toBe("Jan 1, 2026");
        expect(fmtDay("2026-12-31")).toBe("Dec 31");
      } finally {
        restore();
      }
    },
  );

  it("renders a dash for a missing or unparseable value", () => {
    expect(fmtDay(null)).toBe("—");
    expect(fmtDay("garbage")).toBe("—");
    expect(fmtDayYear(undefined)).toBe("—");
  });
});

describe("fmtRange", () => {
  it("shows both ends", () => {
    expect(fmtRange("2026-10-05", "2026-10-16")).toBe("Oct 5 – Oct 16");
  });
  it("says what is known when only one end is set", () => {
    expect(fmtRange("2026-10-05", null)).toBe("Starts Oct 5");
    expect(fmtRange(null, "2026-10-16")).toBe("Ends Oct 16");
  });
  it("says so when there are no dates", () => {
    expect(fmtRange(null, null)).toBe("No dates set");
  });
});

describe("localToday", () => {
  it("is the viewer's calendar day, zero-padded", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localToday(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});

describe("dayDiff", () => {
  it("counts whole calendar days, signed", () => {
    expect(dayDiff("2026-10-05", "2026-10-05")).toBe(0);
    expect(dayDiff("2026-10-05", "2026-10-09")).toBe(4);
    expect(dayDiff("2026-10-09", "2026-10-05")).toBe(-4);
  });
  it("is not fooled by a DST change", () => {
    expect(dayDiff("2026-03-07", "2026-03-09")).toBe(2);
    expect(dayDiff("2026-10-31", "2026-11-02")).toBe(2);
  });
  it("crosses a year", () => {
    expect(dayDiff("2026-12-30", "2027-01-02")).toBe(3);
  });
  it("is NaN for garbage", () => {
    expect(dayDiff("x", "2026-10-05")).toBeNaN();
  });
});

describe("daysLeftLabel", () => {
  it.each([
    ["2026-10-10", "2026-10-05", "5 days left"],
    ["2026-10-06", "2026-10-05", "1 day left"],
    ["2026-10-05", "2026-10-05", "Ends today"],
    ["2026-10-04", "2026-10-05", "Ended yesterday"],
    ["2026-10-01", "2026-10-05", "Ended 4 days ago"],
  ])("end %s on %s → %s", (end, today, expected) => {
    expect(daysLeftLabel(end, today)).toBe(expected);
  });

  it("is null without an end date", () => {
    expect(daysLeftLabel(null, "2026-10-05")).toBeNull();
    expect(daysLeftLabel("nonsense", "2026-10-05")).toBeNull();
  });
});
