/**
 * WARP-1992 — boundary pins for the Reports date scope.
 *
 * These exist because every bug this module can have is an off-by-one that
 * looks right in the UI. The range is half-open `[from, to)` to match
 * `GET /api/activity` (`at >= from`, `at < to`); an inclusive upper bound
 * would pull in the first millisecond of the next day and nobody would
 * notice until a midnight event showed up under the wrong date.
 */
import { describe, it, expect } from "vitest";
import {
  CUSTOM_RANGE_ERROR_COPY,
  MAX_CUSTOM_SPAN_DAYS,
  formatRangeLabel,
  parseIsoDate,
  rangeFor,
  validateCustomRange,
} from "@/app/reports/date-scope";

/** Mid-afternoon, so "today" can't accidentally pass by sitting on midnight. */
const NOW = new Date(2026, 7, 14, 15, 42, 7); // 2026-08-14, local

/** Local midnight, as an ISO string — what the module is expected to emit. */
function localMidnightIso(y: number, m: number, d: number): string {
  return new Date(y, m - 1, d).toISOString();
}

describe("rangeFor — half-open boundaries", () => {
  it("today runs from this midnight to the NEXT midnight, exclusive", () => {
    const r = rangeFor("today", NOW)!;
    expect(r.from).toBe(localMidnightIso(2026, 8, 14));
    expect(r.to).toBe(localMidnightIso(2026, 8, 15));
  });

  it("yesterday ends exactly where today begins — no gap, no overlap", () => {
    const y = rangeFor("yesterday", NOW)!;
    const t = rangeFor("today", NOW)!;
    expect(y.from).toBe(localMidnightIso(2026, 8, 13));
    expect(y.to).toBe(t.from);
  });

  it("last 7 days counts TODAY as one of the seven — six days back, not seven", () => {
    const r = rangeFor("last7", NOW)!;
    // 8th..14th inclusive is seven days. Starting on the 7th would be eight.
    expect(r.from).toBe(localMidnightIso(2026, 8, 8));
    expect(r.to).toBe(localMidnightIso(2026, 8, 15));
  });

  it("a range taken at one second to midnight still belongs to that day", () => {
    const r = rangeFor("today", new Date(2026, 7, 14, 23, 59, 59, 999))!;
    expect(r.from).toBe(localMidnightIso(2026, 8, 14));
    expect(r.to).toBe(localMidnightIso(2026, 8, 15));
  });

  it("crosses a month boundary without rolling into the wrong month", () => {
    const r = rangeFor("last7", new Date(2026, 8, 2, 9, 0, 0))!; // 2026-09-02
    expect(r.from).toBe(localMidnightIso(2026, 8, 27)); // back into August
    expect(r.to).toBe(localMidnightIso(2026, 9, 3));
  });

  it("custom resolves to null with no input rather than silently falling back to today", () => {
    // The failure this pins: showing today's numbers under a label the user
    // set to something else is worse than showing nothing.
    expect(rangeFor("custom", NOW)).toBeNull();
    const today = rangeFor("today", NOW)!;
    expect(rangeFor("custom", NOW)).not.toEqual(today);
  });

  it("custom treats the picked end DAY as inclusive — the boundary is the midnight after", () => {
    const r = rangeFor("custom", NOW, { start: "2026-08-01", end: "2026-08-03" })!;
    expect(r.from).toBe(localMidnightIso(2026, 8, 1));
    expect(r.to).toBe(localMidnightIso(2026, 8, 4));
  });

  it("a single-day custom range is one day wide, not zero", () => {
    const r = rangeFor("custom", NOW, { start: "2026-08-05", end: "2026-08-05" })!;
    expect(new Date(r.to).getTime() - new Date(r.from).getTime()).toBe(86_400_000);
  });
});

describe("parseIsoDate", () => {
  it("parses as LOCAL midnight, not UTC", () => {
    // `new Date("2026-08-14")` is UTC midnight, which is 2026-08-13 anywhere
    // west of Greenwich. That would shift every custom range by a day.
    const d = parseIsoDate("2026-08-14")!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(14);
    expect(d.getHours()).toBe(0);
  });

  it("rejects a well-formed string that is not a real date", () => {
    // Both of these would otherwise roll over into the next month instead
    // of failing — 2026-02-30 becomes 2 March.
    expect(parseIsoDate("2026-13-45")).toBeNull();
    expect(parseIsoDate("2026-02-30")).toBeNull();
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(parseIsoDate("2028-02-29")).not.toBeNull();
    expect(parseIsoDate("2026-02-29")).toBeNull();
  });

  it("rejects malformed shapes", () => {
    for (const s of ["", "14-08-2026", "2026-8-4", "2026/08/14", "yesterday"]) {
      expect(parseIsoDate(s)).toBeNull();
    }
  });
});

describe("validateCustomRange", () => {
  it("accepts an ordinary range", () => {
    expect(validateCustomRange({ start: "2026-08-01", end: "2026-08-14" })).toBeNull();
  });

  it("names each rejection distinctly so the picker can point at the right field", () => {
    expect(validateCustomRange({ start: "nope", end: "2026-08-14" })).toBe("invalid-start");
    expect(validateCustomRange({ start: "2026-08-01", end: "nope" })).toBe("invalid-end");
    expect(validateCustomRange({ start: "2026-08-14", end: "2026-08-01" })).toBe("reversed");
  });

  it("allows exactly the maximum span and rejects one day more", () => {
    // Both ends inclusive, so 90 days is start + 89.
    const start = new Date(2026, 0, 1);
    const okEnd = new Date(2026, 0, MAX_CUSTOM_SPAN_DAYS);
    const tooFar = new Date(2026, 0, MAX_CUSTOM_SPAN_DAYS + 1);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    expect(validateCustomRange({ start: iso(start), end: iso(okEnd) })).toBeNull();
    expect(validateCustomRange({ start: iso(start), end: iso(tooFar) })).toBe("too-long");
  });

  it("every error has copy — no rejection can render blank", () => {
    for (const key of ["invalid-start", "invalid-end", "reversed", "too-long"] as const) {
      expect(CUSTOM_RANGE_ERROR_COPY[key]).toBeTruthy();
    }
  });
});

describe("formatRangeLabel", () => {
  it("shows the last INCLUDED day, not the exclusive boundary", () => {
    // The range ends at midnight on the 15th; the user picked through the
    // 14th. Printing "15 Aug" would claim a day that isn't in the data.
    const r = rangeFor("today", NOW)!;
    expect(formatRangeLabel(r, "en-GB")).toBe("14 Aug");
  });

  it("collapses a single day to one date instead of a same-day range", () => {
    const r = rangeFor("yesterday", NOW)!;
    expect(formatRangeLabel(r, "en-GB")).toBe("13 Aug");
  });

  it("renders a multi-day range with both ends", () => {
    const r = rangeFor("last7", NOW)!;
    expect(formatRangeLabel(r, "en-GB")).toBe("8 Aug – 14 Aug");
  });
});
