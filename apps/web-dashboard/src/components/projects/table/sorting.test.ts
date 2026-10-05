/**
 * WARP-3537 — clicking a column header. Plain click walks one column through
 * ascending → descending → the default order; shift-click adds a column to the sort
 * (a tie-break), up to the three keys a saved view can carry.
 */
import { describe, it, expect } from "vitest";
import { PM_SORT_MAX_KEYS, type PmSortSpec } from "@droplet/shared-types";
import { ariaSortOf, nextSort, sortEqual, sortIndexOf } from "./sorting";

const S = (field: PmSortSpec["field"], dir: PmSortSpec["dir"]): PmSortSpec => ({ field, dir });

describe("nextSort (plain click)", () => {
  it("starts ascending", () => {
    expect(nextSort(null, "dueDate", false)).toEqual([S("dueDate", "asc")]);
  });

  it("then descending, then back to the default order (null)", () => {
    expect(nextSort([S("dueDate", "asc")], "dueDate", false)).toEqual([S("dueDate", "desc")]);
    expect(nextSort([S("dueDate", "desc")], "dueDate", false)).toBeNull();
  });

  it("a different column replaces the whole sort — a plain click is 'sort by this'", () => {
    expect(nextSort([S("dueDate", "desc"), S("name", "asc")], "priority", false)).toEqual([S("priority", "asc")]);
  });

  it("clicking a column that is only a tie-break makes it the whole sort, ascending", () => {
    expect(nextSort([S("priority", "asc"), S("name", "desc")], "name", false)).toEqual([S("name", "asc")]);
  });
});

describe("nextSort (shift-click)", () => {
  it("adds the column after the ones already there", () => {
    expect(nextSort([S("priority", "asc")], "name", true)).toEqual([S("priority", "asc"), S("name", "asc")]);
    expect(nextSort(null, "name", true)).toEqual([S("name", "asc")]);
  });

  it("cycles a column that is already in the sort, and drops it after descending", () => {
    expect(nextSort([S("priority", "asc"), S("name", "asc")], "name", true)).toEqual([S("priority", "asc"), S("name", "desc")]);
    expect(nextSort([S("priority", "asc"), S("name", "desc")], "name", true)).toEqual([S("priority", "asc")]);
  });

  it("dropping the only column is the default order", () => {
    expect(nextSort([S("name", "desc")], "name", true)).toBeNull();
  });

  it("never exceeds the keys a saved view can carry: the last one gives way", () => {
    const three = [S("priority", "asc"), S("state", "asc"), S("name", "asc")];
    expect(three).toHaveLength(PM_SORT_MAX_KEYS);
    const next = nextSort(three, "dueDate", true)!;
    expect(next).toHaveLength(PM_SORT_MAX_KEYS);
    expect(next.map((s) => s.field)).toEqual(["priority", "state", "dueDate"]);
  });
});

describe("reading a sort back", () => {
  const sort = [S("priority", "desc"), S("name", "asc")];

  it("aria-sort names the direction of the PRIMARY key only", () => {
    expect(ariaSortOf(sort, "priority")).toBe("descending");
    expect(ariaSortOf(sort, "name")).toBe("none");
    expect(ariaSortOf(sort, "dueDate")).toBe("none");
    expect(ariaSortOf(null, "priority")).toBe("none");
    expect(ariaSortOf([S("name", "asc")], "name")).toBe("ascending");
  });

  it("sortIndexOf numbers a tie-break so the header can show 1, 2, 3 when there is more than one key", () => {
    expect(sortIndexOf(sort, "priority")).toBe(1);
    expect(sortIndexOf(sort, "name")).toBe(2);
    expect(sortIndexOf(sort, "dueDate")).toBeNull();
    expect(sortIndexOf([S("name", "asc")], "name")).toBeNull();
  });

  it("sortEqual compares by value, and treats null and [] as the same default", () => {
    expect(sortEqual(null, null)).toBe(true);
    expect(sortEqual(null, [])).toBe(true);
    expect(sortEqual([S("name", "asc")], [S("name", "asc")])).toBe(true);
    expect(sortEqual([S("name", "asc")], [S("name", "desc")])).toBe(false);
    expect(sortEqual([S("name", "asc")], null)).toBe(false);
  });
});
