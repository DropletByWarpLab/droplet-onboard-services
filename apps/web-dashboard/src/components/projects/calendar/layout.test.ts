import { describe, it, expect } from "vitest";
import type { PmWorkItem } from "../types";
import { agendaGroups, layoutWeek, monthWeeks, toEntries, unscheduledItems, weekOf } from "./layout";

function item(key: string, startDate: string | null, dueDate: string | null, over: Partial<PmWorkItem> = {}): PmWorkItem {
  return {
    id: key,
    projectId: "p",
    sequenceId: Number(key.split("-")[1]),
    key,
    name: `Item ${key}`,
    descriptionHtml: null,
    stateId: "s1",
    state: { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: null, sortOrder: 1, isDefault: true },
    priority: "none",
    parentId: null,
    cycleId: null,
    department: null,
    assignees: [],
    labels: [],
    startDate,
    dueDate,
    sortOrder: Number(key.split("-")[1]),
    completedAt: null,
    createdById: null,
    commentCount: 0,
    subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

// The week of Sun 2026-09-27 … Sat 2026-10-03.
const WEEK = weekOf("2026-09-30");

describe("monthWeeks / weekOf", () => {
  it("always returns six full Sunday-first weeks that contain the whole month", () => {
    const weeks = monthWeeks("2026-10-17");
    expect(weeks).toHaveLength(6);
    for (const w of weeks) expect(w).toHaveLength(7);
    expect(weeks[0][0]).toBe("2026-09-27");
    expect(weeks[5][6]).toBe("2026-11-07");
    expect(weeks.flat()).toContain("2026-10-01");
    expect(weeks.flat()).toContain("2026-10-31");
  });

  it("a month that starts on a Sunday begins its grid on the 1st", () => {
    expect(monthWeeks("2026-02-10")[0][0]).toBe("2026-02-01");
  });

  it("is gap-free and unique across LA fall-back and Auckland spring-forward", () => {
    for (const anchor of ["2026-11-10", "2026-09-10", "2026-03-10"]) {
      const flat = monthWeeks(anchor).flat();
      expect(new Set(flat).size).toBe(42);
      for (let i = 1; i < flat.length; i += 1) expect(flat[i] > flat[i - 1]).toBe(true);
    }
  });

  it("weekOf returns the seven days containing the anchor", () => {
    expect(WEEK[0]).toBe("2026-09-27");
    expect(WEEK[6]).toBe("2026-10-03");
  });
});

describe("toEntries / unscheduledItems", () => {
  const items = [
    item("P-1", null, "2026-10-01"),
    item("P-2", "2026-10-02", null),
    item("P-3", "2026-09-30", "2026-10-02"),
    item("P-4", null, null),
    item("P-5", null, null, { state: { id: "s9", projectId: "p", name: "Done", group: "completed", color: null, sortOrder: 9, isDefault: false } }),
    item("P-6", null, null, { sortOrder: 0 }),
  ];

  it("keeps only items with a date and orders them by start, then longest first", () => {
    expect(toEntries(items).map((e) => e.item.key)).toEqual(["P-3", "P-1", "P-2"]);
  });

  it("unscheduled lists open items with no dates, in board order, and leaves finished ones out", () => {
    expect(unscheduledItems(items).map((i) => i.key)).toEqual(["P-6", "P-4"]);
  });
});

describe("layoutWeek", () => {
  it("keeps a multi-day bar in ONE lane across all its days and marks its ends", () => {
    const entries = toEntries([item("P-1", "2026-09-29", "2026-10-01")]);
    const { lanes } = layoutWeek(WEEK, entries);
    expect(lanes).toHaveLength(1);
    const row = lanes[0];
    expect(row.map((c) => c?.segment ?? null)).toEqual([null, null, "start", "mid", "end", null, null]);
    expect(row[2]?.first).toBe(true);
    expect(row[3]?.first).toBe(false);
    expect(row[4]?.first).toBe(false);
  });

  it("a single-day item is an 'only' cell", () => {
    const { lanes } = layoutWeek(WEEK, toEntries([item("P-1", null, "2026-10-02")]));
    expect(lanes[0][5]).toMatchObject({ segment: "only", first: true });
  });

  it("stacks overlapping items into separate lanes and reuses a lane once it is free", () => {
    const entries = toEntries([
      item("P-1", "2026-09-28", "2026-09-30"),
      item("P-2", "2026-09-29", "2026-10-01"),
      item("P-3", "2026-10-02", "2026-10-03"),
    ]);
    const { lanes } = layoutWeek(WEEK, entries);
    expect(lanes).toHaveLength(2);
    const keyAt = (lane: number, col: number) => lanes[lane][col]?.entry.item.key ?? null;
    expect([0, 1, 2, 3, 4, 5, 6].map((c) => keyAt(0, c))).toEqual([null, "P-1", "P-1", "P-1", null, "P-3", "P-3"]);
    expect([0, 1, 2, 3, 4, 5, 6].map((c) => keyAt(1, c))).toEqual([null, null, "P-2", "P-2", "P-2", null, null]);
  });

  it("an item continuing from the previous week starts as a 'mid' labelled cell; one continuing on ends open", () => {
    const entries = toEntries([item("P-1", "2026-09-22", "2026-09-29"), item("P-2", "2026-10-02", "2026-10-09")]);
    const { lanes } = layoutWeek(WEEK, entries);
    const a = lanes[0].filter(Boolean)[0]!;
    expect(a.entry.item.key).toBe("P-1");
    expect(a).toMatchObject({ first: true, continuesBefore: true, continuesAfter: false, segment: "mid" });
    const lastOfA = lanes[0][2]!;
    expect(lastOfA.segment).toBe("end");
    const b = lanes[0][5]!;
    expect(b).toMatchObject({ first: true, continuesBefore: false, continuesAfter: true, segment: "start" });
    expect(lanes[0][6]).toMatchObject({ segment: "mid", first: false });
  });

  it("ignores items entirely outside the week", () => {
    const { lanes } = layoutWeek(WEEK, toEntries([item("P-1", "2026-10-10", "2026-10-12"), item("P-2", null, "2026-09-01")]));
    expect(lanes).toEqual([]);
  });

  it("reports what does not fit instead of drawing it", () => {
    const entries = toEntries([
      item("P-1", null, "2026-09-30"),
      item("P-2", null, "2026-09-30"),
      item("P-3", null, "2026-09-30"),
      item("P-4", "2026-09-29", "2026-10-01"),
    ]);
    const { lanes, overflow, hidden } = layoutWeek(WEEK, entries, 2);
    expect(lanes).toHaveLength(2);
    // The long bar sorts first and takes lane 0 on Sep 29–Oct 1; P-1 takes lane 1 on Sep 30;
    // P-2 and P-3 would need a third lane, so they are reported on their day, not drawn.
    expect(lanes[0][3]?.entry.item.key).toBe("P-4");
    expect(lanes[1][3]?.entry.item.key).toBe("P-1");
    expect(overflow).toEqual([0, 0, 0, 2, 0, 0, 0]);
    expect(hidden[3].map((e) => e.item.key)).toEqual(["P-2", "P-3"]);
  });

  it("a hidden multi-day entry is counted on every day it covers", () => {
    const entries = toEntries([
      item("P-1", "2026-09-28", "2026-09-30"),
      item("P-2", "2026-09-28", "2026-09-29"),
    ]);
    const { overflow } = layoutWeek(WEEK, entries, 1);
    expect(overflow).toEqual([0, 1, 1, 0, 0, 0, 0]);
  });

  it("inverted data (start after due) is laid out as the span between the two dates", () => {
    const { lanes } = layoutWeek(WEEK, toEntries([item("P-1", "2026-10-01", "2026-09-29")]));
    expect(lanes[0].map((c) => c?.segment ?? null)).toEqual([null, null, "start", "mid", "end", null, null]);
  });
});

describe("agendaGroups", () => {
  it("groups each item once under the first visible day it appears on", () => {
    const entries = toEntries([
      item("P-1", "2026-09-28", "2026-10-02"),
      item("P-2", null, "2026-10-05"),
      item("P-3", null, "2026-11-20"),
    ]);
    const groups = agendaGroups(entries, "2026-10-01", "2026-10-31");
    expect(groups.map((g) => [g.day, g.entries.map((e) => e.item.key)])).toEqual([
      ["2026-10-01", ["P-1"]],
      ["2026-10-05", ["P-2"]],
    ]);
  });
});
