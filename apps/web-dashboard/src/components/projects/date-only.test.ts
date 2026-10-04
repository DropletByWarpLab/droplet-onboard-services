import { describe, it, expect } from "vitest";
import {
  dayDiff,
  daysLeftLabel,
  fmtDay,
  fmtDayYear,
  fmtRange,
  localToday,
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
