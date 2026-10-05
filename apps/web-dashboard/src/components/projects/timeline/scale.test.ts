import { describe, it, expect, afterAll } from "vitest";
import { diffDays, weekdayOf } from "../calendar/dateOnly";
import type { Span } from "../calendar/schedule";
import {
  DIAMOND,
  ZOOMS,
  ZOOMS_IN_ORDER,
  barGeom,
  connector,
  endX,
  headerTicks,
  makeScale,
  pointCenter,
  rangeFor,
  startX,
  weekendBands,
} from "./scale";

const originalTz = process.env.TZ;
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const TODAY = "2026-10-03";
const span = (start: string, end: string, kind: "point" | "span" = "span"): Span => ({
  start,
  end,
  kind,
  inverted: false,
  days: diffDays(start, end) + 1,
});

describe("rangeFor", () => {
  it.each(ZOOMS_IN_ORDER)("%s: contains the anchor and stays inside the API's 1100-day cap", (zoom) => {
    const r = rangeFor(TODAY, zoom);
    const days = diffDays(r.from, r.to) + 1;
    expect(days).toBe(ZOOMS[zoom].before + ZOOMS[zoom].after + 1);
    expect(days).toBeLessThanOrEqual(1100);
    expect(r.from <= TODAY && TODAY <= r.to).toBe(true);
  });

  it("the day zoom is 30 days back and 60 ahead", () => {
    expect(rangeFor("2026-10-03", "day")).toEqual({ from: "2026-09-03", to: "2026-12-02" });
  });
});

describe("makeScale", () => {
  const scale = makeScale(rangeFor(TODAY, "week"), "week");

  it("maps days to px and back, including outside the window", () => {
    expect(scale.pxPerDay).toBe(14);
    expect(scale.x(scale.range.from)).toBe(0);
    expect(scale.x("2026-10-04")).toBe(diffDays(scale.range.from, "2026-10-04") * 14);
    expect(scale.x("2000-01-01")).toBeLessThan(0);
    expect(scale.dayAt(scale.x("2026-12-25") + 5)).toBe("2026-12-25");
    expect(scale.width).toBe((diffDays(scale.range.from, scale.range.to) + 1) * 14);
  });
});

describe("headerTicks", () => {
  it.each(ZOOMS_IN_ORDER)("%s: both rows tile the window exactly, with no gap or overlap", (zoom) => {
    const scale = makeScale(rangeFor(TODAY, zoom), zoom);
    const { top, bottom } = headerTicks(scale, TODAY, "en-US");
    for (const row of [top, bottom]) {
      expect(row[0].x).toBe(0);
      let edge = 0;
      for (const t of row) {
        expect(t.x).toBeCloseTo(edge, 6);
        edge += t.w;
      }
      expect(edge).toBeCloseTo(scale.width, 6);
    }
  });

  it("day zoom: one tick per day, weekends flagged, today flagged once, months on top", () => {
    const scale = makeScale(rangeFor(TODAY, "day"), "day");
    const { top, bottom } = headerTicks(scale, TODAY, "en-US");
    expect(bottom).toHaveLength(91);
    expect(bottom.filter((t) => t.today).map((t) => t.start)).toEqual([TODAY]);
    expect(bottom.every((t) => t.weekend === (weekdayOf(t.start) === 0 || weekdayOf(t.start) === 6))).toBe(true);
    expect(bottom.find((t) => t.start === TODAY)).toMatchObject({ label: "3", sub: "Sat" });
    expect(top.map((t) => t.label)).toEqual(["September 2026", "October 2026", "November 2026", "December 2026"]);
  });

  it("week zoom: weeks begin on Sunday (the first may be partial) and today's week is flagged", () => {
    const scale = makeScale(rangeFor(TODAY, "week"), "week");
    const { bottom } = headerTicks(scale, TODAY, "en-US");
    for (const t of bottom.slice(1)) expect(weekdayOf(t.start)).toBe(0);
    expect(bottom.filter((t) => t.today)).toHaveLength(1);
    expect(bottom.find((t) => t.today)?.start).toBe("2026-09-27");
    expect(bottom.find((t) => t.today)?.label).toBe("Sep 27");
  });

  it("month and quarter zoom: month labels under years, Q1..Q4 under years", () => {
    const m = headerTicks(makeScale(rangeFor(TODAY, "month"), "month"), TODAY, "en-US");
    expect(m.bottom.find((t) => t.today)?.label).toBe("Oct");
    // Apr 2026 .. Oct 2027: two calendar years.
    expect(m.top.map((t) => t.label)).toEqual(["2026", "2027"]);
    expect(m.bottom[0].label).toBe("Apr");
    const q = headerTicks(makeScale(rangeFor(TODAY, "quarter"), "quarter"), TODAY, "en-US");
    expect(q.bottom.map((t) => t.label).every((l) => /^Q[1-4]$/.test(l))).toBe(true);
    expect(q.bottom.find((t) => t.today)?.label).toBe("Q4");
    expect(q.top.map((t) => t.label)).toEqual(["2025", "2026", "2027", "2028"]);
  });

  it.each(ZOOMS_IN_ORDER)("%s: identical in Los Angeles and Auckland (no local-time read anywhere)", (zoom) => {
    const scale = makeScale(rangeFor("2026-09-27", zoom), zoom);
    process.env.TZ = "America/Los_Angeles";
    const la = JSON.stringify(headerTicks(scale, "2026-09-27", "en-US"));
    process.env.TZ = "Pacific/Auckland";
    const nz = JSON.stringify(headerTicks(scale, "2026-09-27", "en-US"));
    expect(la).toBe(nz);
  });
});

describe("weekendBands", () => {
  it("covers every Saturday-Sunday run in day and week zoom, nothing in month and quarter", () => {
    const scale = makeScale({ from: "2026-10-01", to: "2026-10-14" }, "day");
    const bands = weekendBands(scale);
    // Sat Oct 3 + Sun Oct 4, Sat Oct 10 + Sun Oct 11.
    expect(bands.map((b) => [b.x, b.w])).toEqual([
      [2 * 40, 2 * 40],
      [9 * 40, 2 * 40],
    ]);
    expect(weekendBands(makeScale({ from: "2026-10-01", to: "2026-12-31" }, "month"))).toEqual([]);
  });

  it("a window that starts on a Sunday begins with a one-day band", () => {
    const bands = weekendBands(makeScale({ from: "2026-10-04", to: "2026-10-08" }, "day"));
    expect(bands).toEqual([{ key: "2026-10-04", x: 0, w: 40 }]);
  });
});

describe("bars", () => {
  const scale = makeScale({ from: "2026-10-01", to: "2026-10-31" }, "day"); // 40px/day

  it("a span is positioned from its first day with an inclusive width", () => {
    expect(barGeom(scale, span("2026-10-05", "2026-10-10"))).toEqual({
      left: 4 * 40,
      width: 6 * 40,
      clippedStart: false,
      clippedEnd: false,
    });
  });

  it("clamps a span that runs past the window and says which end", () => {
    expect(barGeom(scale, span("2026-09-25", "2026-10-02"))).toEqual({ left: 0, width: 2 * 40, clippedStart: true, clippedEnd: false });
    expect(barGeom(scale, span("2026-10-30", "2026-11-05"))).toEqual({ left: 29 * 40, width: 2 * 40, clippedStart: false, clippedEnd: true });
    expect(barGeom(scale, span("2026-09-01", "2026-12-01"))).toMatchObject({ left: 0, width: 31 * 40, clippedStart: true, clippedEnd: true });
  });

  it("is null when nothing is inside the window", () => {
    expect(barGeom(scale, span("2026-09-01", "2026-09-30"))).toBeNull();
    expect(barGeom(scale, span("2026-11-01", "2026-11-03"))).toBeNull();
  });

  it("a one-date item is centred on its day; null outside", () => {
    expect(pointCenter(scale, "2026-10-05")).toBe(4 * 40 + 20);
    expect(pointCenter(scale, "2026-09-30")).toBeNull();
    expect(pointCenter(scale, "2026-11-01")).toBeNull();
  });

  it("connector endpoints: a span ends after its last day, a diamond at its right tip", () => {
    expect(endX(scale, span("2026-10-05", "2026-10-10"))).toBe(9 * 40 + 40);
    expect(startX(scale, span("2026-10-05", "2026-10-10"))).toBe(4 * 40);
    const p = span("2026-10-05", "2026-10-05", "point");
    expect(endX(scale, p)).toBe(4 * 40 + 20 + DIAMOND / 2);
    expect(startX(scale, p)).toBe(4 * 40 + 20 - DIAMOND / 2);
  });
});

describe("connector", () => {
  it("is a plain right-down-right step when the blocked item starts after the blocker ends", () => {
    expect(connector(100, 18, 200, 90, 36)).toEqual({ d: "M 100 18 H 108 V 90 H 200", conflict: false });
  });

  it("works upward too", () => {
    expect(connector(100, 90, 200, 18, 36)).toEqual({ d: "M 100 90 H 108 V 18 H 200", conflict: false });
  });

  it("routes along the row boundary, and flags a conflict, when the blocked item starts first", () => {
    const down = connector(200, 18, 120, 90, 36);
    expect(down.conflict).toBe(true);
    expect(down.d).toBe("M 200 18 H 208 V 36 H 112 V 90 H 120");
    const up = connector(200, 90, 120, 18, 36);
    expect(up.d).toBe("M 200 90 H 208 V 72 H 112 V 18 H 120");
  });

  it("not enough room for the elbow is a detour but not yet a conflict", () => {
    const c = connector(100, 18, 110, 90, 36);
    expect(c.conflict).toBe(false);
    expect(c.d.startsWith("M 100 18 H 108 V 36")).toBe(true);
  });
});
