import { describe, it, expect } from "vitest";
import type { PmState, PmWorkItem } from "../types";
import { ROW_H, buildRows, computeWindow } from "./rows";

const st = (id: string, name: string, sortOrder: number, group: PmState["group"] = "unstarted"): PmState => ({
  id,
  projectId: "p",
  name,
  group,
  color: "#6366f1",
  sortOrder,
  isDefault: false,
});
const BACKLOG = st("s0", "Backlog", 0, "backlog");
const TODO = st("s1", "Todo", 1);
const DONE = st("s3", "Done", 3, "completed");

function item(n: number, state: PmState | null, over: Partial<PmWorkItem> = {}): PmWorkItem {
  return {
    id: `w${n}`,
    projectId: "p",
    sequenceId: n,
    key: `P-${n}`,
    name: `Item ${n}`,
    descriptionHtml: null,
    stateId: state?.id ?? null,
    state,
    priority: "none",
    parentId: null,
    cycleId: null,
    department: null,
    assignees: [],
    labels: [],
    startDate: null,
    dueDate: "2026-10-05T00:00:00.000Z",
    sortOrder: n,
    completedAt: null,
    createdById: null,
    commentCount: 0,
    subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

describe("buildRows", () => {
  const items = [item(1, DONE), item(2, TODO), item(3, null), item(4, TODO), item(5, BACKLOG)];

  it("groups by state in board order, states without a name-state last, with a header per group", () => {
    const rows = buildRows(items, new Set());
    expect(rows.map((r) => (r.type === "group" ? `# ${r.label} (${r.count})` : r.item.key))).toEqual([
      "# Backlog (1)", "P-5",
      "# Todo (2)", "P-2", "P-4",
      "# Done (1)", "P-1",
      "# No state (1)", "P-3",
    ]);
  });

  it("indexes rows consecutively — geometry, windowing and connectors all hang off it", () => {
    const rows = buildRows(items, new Set());
    expect(rows.map((r) => r.index)).toEqual(rows.map((_, i) => i));
  });

  it("orders items inside a group by the board's sortOrder then sequence, never by date", () => {
    const rows = buildRows(
      [
        item(1, TODO, { sortOrder: 5, dueDate: "2026-10-01T00:00:00.000Z" }),
        item(2, TODO, { sortOrder: 1, dueDate: "2026-12-01T00:00:00.000Z" }),
        item(3, TODO, { sortOrder: 1, dueDate: "2026-11-01T00:00:00.000Z" }),
      ],
      new Set(),
    );
    expect(rows.filter((r) => r.type === "item").map((r) => (r.type === "item" ? r.item.key : ""))).toEqual(["P-2", "P-3", "P-1"]);
  });

  it("a collapsed group keeps its header and count but drops its rows", () => {
    const rows = buildRows(items, new Set(["s1"]));
    expect(rows.map((r) => (r.type === "group" ? `# ${r.label} (${r.count}${r.collapsed ? ", collapsed" : ""})` : r.item.key))).toEqual([
      "# Backlog (1)", "P-5",
      "# Todo (2, collapsed)",
      "# Done (1)", "P-1",
      "# No state (1)", "P-3",
    ]);
    expect(rows.find((r) => r.type === "group" && r.collapsed)).toMatchObject({ group: "s1" });
  });

  it("is empty for no items", () => {
    expect(buildRows([], new Set())).toEqual([]);
  });
});

describe("computeWindow", () => {
  it("at the top renders the viewport plus overscan below", () => {
    expect(computeWindow({ scrollTop: 0, viewportHeight: 360, rowCount: 1000 })).toEqual({ start: 0, end: 10 + 6 });
  });

  it("scrolled, renders rows around the position with overscan on both sides", () => {
    const w = computeWindow({ scrollTop: ROW_H * 500, viewportHeight: 360, rowCount: 1000 });
    expect(w).toEqual({ start: 500 - 6, end: 510 + 6 });
  });

  it("partial rows at either edge are included", () => {
    const w = computeWindow({ scrollTop: ROW_H * 100 + 10, viewportHeight: 100, rowCount: 1000, overscan: 0 });
    expect(w).toEqual({ start: 100, end: Math.ceil((ROW_H * 100 + 110) / ROW_H) });
  });

  it("clamps to the row count and never goes negative", () => {
    expect(computeWindow({ scrollTop: 0, viewportHeight: 2000, rowCount: 5 })).toEqual({ start: 0, end: 5 });
    expect(computeWindow({ scrollTop: -50, viewportHeight: 100, rowCount: 100 }).start).toBe(0);
    expect(computeWindow({ scrollTop: 999_999, viewportHeight: 100, rowCount: 100 })).toEqual({ start: 100, end: 100 });
  });

  it("renders a bounded number of rows however many there are", () => {
    for (const rowCount of [100, 1_000, 100_000]) {
      const w = computeWindow({ scrollTop: ROW_H * 40, viewportHeight: 640, rowCount });
      expect(w.end - w.start).toBeLessThanOrEqual(Math.ceil(640 / ROW_H) + 1 + 12);
    }
  });
});
