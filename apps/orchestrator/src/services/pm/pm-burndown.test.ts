/**
 * WARP-3521 — the burndown reconstruction, as a pure function.
 *
 * The service loads rows and hands them to `reconstructBurndown`; everything
 * that can be wrong about the CHART (scope that rises, work that is reopened,
 * a day boundary, a future day) is decided here, so it is tested here, with no
 * database and no clock.
 *
 * Day math in these fixtures: three-letter helper `d(n)` is the UTC instant `n`
 * hours after 2026-10-05T00:00:00Z, and `days(5)` is Mon 05 .. Fri 09 Oct.
 */
import { describe, it, expect } from "vitest";
import {
  reconstructBurndown,
  utcDayBoundaries,
  type BurndownEvent,
  type BurndownItem,
  type BurndownPoint,
} from "./pm-burndown.js";

const T0 = Date.UTC(2026, 9, 5); // Mon 2026-10-05 00:00Z
const HOUR = 3_600_000;
const at = (hours: number): Date => new Date(T0 + hours * HOUR);
const NOW_AFTER_ALL = at(24 * 30);

function days(n: number) {
  return utcDayBoundaries("2026-10-05", n);
}

function item(id: string, over: Partial<BurndownItem> = {}): BurndownItem {
  return { id, memberNow: true, terminalNow: false, weight: 0, ...over };
}

const joined = (itemId: string, hours: number): BurndownEvent => ({
  kind: "membership",
  itemId,
  at: at(hours),
  wasMember: false,
});
const left = (itemId: string, hours: number): BurndownEvent => ({
  kind: "membership",
  itemId,
  at: at(hours),
  wasMember: true,
});
/** the item was OPEN before this event, i.e. it became terminal at it */
const finished = (itemId: string, hours: number): BurndownEvent => ({
  kind: "terminal",
  itemId,
  at: at(hours),
  wasTerminal: false,
});
/** the item was TERMINAL before this event, i.e. it was reopened at it */
const reopened = (itemId: string, hours: number): BurndownEvent => ({
  kind: "terminal",
  itemId,
  at: at(hours),
  wasTerminal: true,
});

const col = (points: BurndownPoint[], key: keyof BurndownPoint) => points.map((p) => p[key]);

describe("utcDayBoundaries", () => {
  it("returns n consecutive UTC days with [startsAt, endsAt) windows", () => {
    const b = utcDayBoundaries("2026-10-05", 3);
    expect(b.map((x) => x.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(b[0].startsAt.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(b[0].endsAt.toISOString()).toBe("2026-10-06T00:00:00.000Z");
    expect(b[2].endsAt.toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });

  it("crosses a month and a year boundary by calendar, not by 30-day months", () => {
    const b = utcDayBoundaries("2026-12-30", 4);
    expect(b.map((x) => x.date)).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  });

  it("returns [] for a non-positive count", () => {
    expect(utcDayBoundaries("2026-10-05", 0)).toEqual([]);
  });
});

describe("reconstructBurndown — scope and remaining", () => {
  it("a quiet cycle is flat: every day shows the live scope and remaining", () => {
    const points = reconstructBurndown({
      days: days(3),
      items: [item("a"), item("b", { terminalNow: true }), item("c")],
      events: [],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "scope")).toEqual([3, 3, 3]);
    expect(col(points, "remaining")).toEqual([2, 2, 2]);
    expect(col(points, "completed")).toEqual([1, 1, 1]);
  });

  it("burns down on the day an item finishes, not before and not after", () => {
    const points = reconstructBurndown({
      days: days(5),
      items: [
        item("a", { terminalNow: true }),
        item("b", { terminalNow: true }),
        item("c"),
      ],
      // a finishes Tue, b finishes Thu
      events: [finished("a", 24 + 10), finished("b", 24 * 3 + 9)],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "remaining")).toEqual([3, 2, 2, 1, 1]);
    expect(col(points, "completed")).toEqual([0, 1, 1, 2, 2]);
    expect(col(points, "scope")).toEqual([3, 3, 3, 3, 3]);
  });

  it("an item that is reopened puts remaining work back (the line goes UP)", () => {
    const points = reconstructBurndown({
      days: days(4),
      items: [item("a"), item("b")],
      // a: finished Mon, reopened Wed → open now.  b: untouched.
      events: [finished("a", 5), reopened("a", 24 * 2 + 5)],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "remaining")).toEqual([1, 1, 2, 2]);
  });

  it("scope rises on the day an item is added mid-cycle, and the day says so", () => {
    const points = reconstructBurndown({
      days: days(5),
      items: [item("a"), item("b"), item("c"), item("late")],
      events: [joined("late", 24 * 2 + 14)], // Wed afternoon
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "scope")).toEqual([3, 3, 4, 4, 4]);
    expect(col(points, "remaining")).toEqual([3, 3, 4, 4, 4]);
    expect(col(points, "added")).toEqual([0, 0, 1, 0, 0]);
    expect(col(points, "removed")).toEqual([0, 0, 0, 0, 0]);
  });

  it("scope drops when an item leaves the cycle, and the day says so", () => {
    const points = reconstructBurndown({
      days: days(4),
      // `gone` is not a member NOW; it was one until Tue 08:00
      items: [item("a"), item("gone", { memberNow: false })],
      events: [left("gone", 24 + 8)],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "scope")).toEqual([2, 1, 1, 1]);
    expect(col(points, "removed")).toEqual([0, 1, 0, 0]);
  });

  it("an item added ALREADY DONE raises scope but not remaining", () => {
    const points = reconstructBurndown({
      days: days(3),
      items: [item("a"), item("done-on-arrival", { terminalNow: true })],
      // it was terminal the whole time; it joined Tue
      events: [joined("done-on-arrival", 24 + 3)],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "scope")).toEqual([1, 2, 2]);
    expect(col(points, "remaining")).toEqual([1, 1, 1]);
    expect(col(points, "completed")).toEqual([0, 1, 1]);
  });

  it("an item added, finished and removed within the window leaves the right trail", () => {
    const points = reconstructBurndown({
      days: days(5),
      items: [item("a", { memberNow: false, terminalNow: true })],
      events: [
        joined("a", 24 * 1 + 1), // joins Tue
        finished("a", 24 * 2 + 1), // finishes Wed
        left("a", 24 * 3 + 1), // leaves Thu
      ],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "scope")).toEqual([0, 1, 1, 0, 0]);
    expect(col(points, "remaining")).toEqual([0, 1, 0, 0, 0]);
    expect(col(points, "completed")).toEqual([0, 0, 1, 0, 0]);
  });

  it("an item whose only event is after the last day never counted", () => {
    const points = reconstructBurndown({
      days: days(2),
      items: [item("a"), item("later")],
      events: [joined("later", 24 * 6)],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "scope")).toEqual([1, 1]);
  });

  it("an item that was a member before the first event and has no membership event is a member throughout", () => {
    const points = reconstructBurndown({
      days: days(3),
      items: [item("a")],
      events: [],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "scope")).toEqual([1, 1, 1]);
  });

  it("an event exactly on a day boundary belongs to the NEXT day (windows are [start, end))", () => {
    const points = reconstructBurndown({
      days: days(3),
      items: [item("a", { terminalNow: true })],
      events: [finished("a", 24)], // 2026-10-06T00:00:00.000Z sharp
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "remaining")).toEqual([1, 0, 0]);
  });

  it("ignores events for items it was not given", () => {
    const points = reconstructBurndown({
      days: days(2),
      items: [item("a")],
      events: [joined("ghost", 5), finished("ghost", 6)],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "scope")).toEqual([1, 1]);
  });

  it("keeps input order for events at the identical instant", () => {
    // finished then reopened at the same instant: the item ends the day OPEN
    const points = reconstructBurndown({
      days: days(2),
      items: [item("a")],
      events: [finished("a", 30), reopened("a", 30)],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "remaining")).toEqual([1, 1]);
  });
});

describe("reconstructBurndown — anchored to the live rows", () => {
  it("history that disagrees with the live row loses to the live row", () => {
    // The only recorded event says `a` finished on Tue — but the live row says it
    // is open. Nothing wrote the reopening down (updateState's group-change
    // cascade and deleteState's reassignment write no activity), so the history
    // is incomplete and the live row is the one thing that is certainly true.
    // Anchoring to it means the series cannot END somewhere the card beside the
    // chart ("N of M done") is not; the cost is that the lost finish stays lost.
    const points = reconstructBurndown({
      days: days(4),
      items: [item("a", { terminalNow: false })],
      events: [finished("a", 24 + 5)],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "remaining")).toEqual([1, 1, 1, 1]);
  });

  it("the same event with a live row that agrees shows the finish", () => {
    const points = reconstructBurndown({
      days: days(4),
      items: [item("a", { terminalNow: true })],
      events: [finished("a", 24 + 5)],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "remaining")).toEqual([1, 0, 0, 0]);
  });

  it("later history is undone correctly for a window that has already closed", () => {
    // A completed cycle's window ended Wed; `a` was finished inside it and
    // reopened afterwards (Fri). The chart for Wed must still say 'done'.
    const points = reconstructBurndown({
      days: days(3),
      items: [item("a", { terminalNow: false })],
      events: [finished("a", 24 + 5), reopened("a", 24 * 4)],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "remaining")).toEqual([1, 0, 0]);
  });

  it("a non-member now is not counted on the last day, whatever the events say", () => {
    const points = reconstructBurndown({
      days: days(3),
      items: [item("a", { memberNow: false })],
      events: [joined("a", 5)], // joined Mon, never recorded leaving
      now: NOW_AFTER_ALL,
    });
    expect(points[2].scope).toBe(0);
  });
});

describe("reconstructBurndown — estimates", () => {
  it("sums the estimate alongside the count, per day", () => {
    const points = reconstructBurndown({
      days: days(4),
      items: [
        item("a", { weight: 5, terminalNow: true }),
        item("b", { weight: 3 }),
        item("late", { weight: 8 }),
      ],
      events: [finished("a", 24 + 2), joined("late", 24 * 2 + 2)],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "scopeEstimate")).toEqual([8, 8, 16, 16]);
    expect(col(points, "remainingEstimate")).toEqual([8, 3, 11, 11]);
    expect(col(points, "completedEstimate")).toEqual([0, 5, 5, 5]);
  });

  it("an item with no estimate weighs nothing but still counts", () => {
    const points = reconstructBurndown({
      days: days(1),
      items: [item("a", { weight: 0 }), item("b", { weight: 2 })],
      events: [],
      now: NOW_AFTER_ALL,
    });
    expect(points[0].scope).toBe(2);
    expect(points[0].scopeEstimate).toBe(2);
  });

  it("rounds estimate sums to two decimals so 0.1 + 0.2 does not leak into the chart", () => {
    const points = reconstructBurndown({
      days: days(1),
      items: [item("a", { weight: 0.1 }), item("b", { weight: 0.2 })],
      events: [],
      now: NOW_AFTER_ALL,
    });
    expect(points[0].scopeEstimate).toBe(0.3);
  });
});

describe("reconstructBurndown — the ideal line", () => {
  it("runs from the work remaining at the end of day one down to zero on the last day", () => {
    const points = reconstructBurndown({
      days: days(5),
      items: [item("a"), item("b"), item("c"), item("d")],
      events: [],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "ideal")).toEqual([4, 3, 2, 1, 0]);
  });

  it("is anchored at the baseline remaining, not at the scope (done work is not 'to burn')", () => {
    const points = reconstructBurndown({
      days: days(3),
      items: [item("a", { terminalNow: true }), item("b"), item("c")],
      events: [],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "ideal")).toEqual([2, 1, 0]);
  });

  it("scope added later does NOT move the ideal line — scope creep has to show", () => {
    const points = reconstructBurndown({
      days: days(4),
      items: [item("a"), item("b"), item("late")],
      events: [joined("late", 24 * 2 + 1)],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "ideal")).toEqual([2, 4 / 3, 2 / 3, 0].map((n) => Math.round(n * 100) / 100));
    expect(points[3].remaining).toBe(3); // above the ideal, which is the point
  });

  it("a one-day cycle's ideal is zero", () => {
    const points = reconstructBurndown({
      days: days(1),
      items: [item("a")],
      events: [],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "ideal")).toEqual([0]);
  });

  it("has an estimate twin", () => {
    const points = reconstructBurndown({
      days: days(3),
      items: [item("a", { weight: 6 }), item("b", { weight: 2 })],
      events: [],
      now: NOW_AFTER_ALL,
    });
    expect(col(points, "idealEstimate")).toEqual([8, 4, 0]);
  });
});

describe("reconstructBurndown — the future", () => {
  it("days that have not started have no actuals, only the ideal line", () => {
    // now = Tue noon: Mon and Tue have started, Wed.. have not
    const points = reconstructBurndown({
      days: days(5),
      items: [item("a"), item("b")],
      events: [],
      now: at(24 + 12),
    });
    expect(col(points, "scope")).toEqual([2, 2, null, null, null]);
    expect(col(points, "remaining")).toEqual([2, 2, null, null, null]);
    expect(col(points, "completed")).toEqual([0, 0, null, null, null]);
    expect(col(points, "scopeEstimate")).toEqual([0, 0, null, null, null]);
    expect(col(points, "added")).toEqual([0, 0, null, null, null]);
    expect(col(points, "ideal")).toEqual([2, 1.5, 1, 0.5, 0]);
  });

  it("a cycle that has not started yet: every actual is null, the ideal is a preview", () => {
    const points = reconstructBurndown({
      days: days(3),
      items: [item("a"), item("b")],
      events: [],
      now: at(-48),
    });
    expect(col(points, "scope")).toEqual([null, null, null]);
    expect(col(points, "ideal")).toEqual([2, 1, 0]);
  });

  it("the current day is an actual — it has started — even though it has not ended", () => {
    const points = reconstructBurndown({
      days: days(2),
      items: [item("a", { terminalNow: true })],
      events: [finished("a", 3)],
      now: at(5), // 05:00 on day one
    });
    expect(points[0].remaining).toBe(0);
    expect(points[1].remaining).toBeNull();
  });
});

describe("reconstructBurndown — degenerate input", () => {
  it("no days → no points", () => {
    expect(reconstructBurndown({ days: [], items: [item("a")], events: [], now: NOW_AFTER_ALL })).toEqual([]);
  });

  it("no items → zeros, with a zero ideal", () => {
    const points = reconstructBurndown({ days: days(3), items: [], events: [], now: NOW_AFTER_ALL });
    expect(col(points, "scope")).toEqual([0, 0, 0]);
    expect(col(points, "ideal")).toEqual([0, 0, 0]);
  });

  it("does not mutate its input", () => {
    const events = [finished("a", 30), joined("b", 5)];
    const copy = JSON.stringify(events);
    reconstructBurndown({
      days: days(3),
      items: [item("a", { terminalNow: true }), item("b")],
      events,
      now: NOW_AFTER_ALL,
    });
    expect(JSON.stringify(events)).toBe(copy);
  });
});
