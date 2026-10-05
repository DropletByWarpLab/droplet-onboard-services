/**
 * WARP-3522 — saved-view vocabulary: the built-in views the dashboard used to
 * hard-code, and the sort / group-by / column shapes a saved view persists.
 */
import { describe, it, expect } from "vitest";
import { validatePmFilter } from "./pm-filter";
import {
  PM_BUILTIN_VIEWS,
  PM_GROUP_BY_FIELDS,
  PM_SORT_FIELDS,
  PM_SORT_MAX_KEYS,
  PM_COLUMNS_MAX,
  isPmBuiltinViewId,
  validatePmColumns,
  validatePmGroupBy,
  validatePmSort,
} from "./pm-views";

describe("PM_BUILTIN_VIEWS", () => {
  it("keeps the five views the board always offered, under the ids the page already used", () => {
    expect(PM_BUILTIN_VIEWS.map((v) => v.id)).toEqual(["all", "mine", "active", "overdue", "noassignee"]);
    expect(PM_BUILTIN_VIEWS.map((v) => v.name)).toEqual(["All", "My items", "Active", "Overdue", "No assignee"]);
  });

  it("expresses every one of them as a valid filter", () => {
    for (const v of PM_BUILTIN_VIEWS) {
      const res = validatePmFilter(v.filter);
      expect(res.ok, v.id).toBe(true);
    }
  });

  it("carries the old semantics: mine, active, overdue (open + past due), no assignee", () => {
    const by = (id: string) => PM_BUILTIN_VIEWS.find((v) => v.id === id)!.filter;
    expect(by("all")).toEqual({ and: [] });
    expect(by("mine")).toEqual({ and: [{ field: "assignee", op: "is", value: "me" }] });
    expect(by("active")).toEqual({
      and: [{ field: "stateGroup", op: "in", value: ["backlog", "unstarted", "started"] }],
    });
    expect(by("overdue")).toEqual({
      and: [
        { field: "dueDate", op: "before", value: "today" },
        { field: "stateGroup", op: "notIn", value: ["completed", "cancelled"] },
      ],
    });
    expect(by("noassignee")).toEqual({ and: [{ field: "assignee", op: "isEmpty" }] });
  });

  it("recognises a built-in id and nothing that could be a row id", () => {
    expect(isPmBuiltinViewId("mine")).toBe(true);
    expect(isPmBuiltinViewId("3f2b8c1e-9a44-4d3b-8f10-2a6c1b7d9e01")).toBe(false);
    expect(isPmBuiltinViewId("")).toBe(false);
    expect(isPmBuiltinViewId("constructor")).toBe(false);
  });
});

describe("validatePmSort", () => {
  it("accepts a single and a compound sort", () => {
    expect(validatePmSort([{ field: "dueDate", dir: "asc" }])).toEqual({
      ok: true,
      sort: [{ field: "dueDate", dir: "asc" }],
    });
    expect(
      validatePmSort([
        { field: "priority", dir: "asc" },
        { field: "updatedAt", dir: "desc" },
      ]).ok,
    ).toBe(true);
  });

  it.each(PM_SORT_FIELDS)("accepts %s", (field) => {
    expect(validatePmSort([{ field, dir: "desc" }]).ok).toBe(true);
  });

  const bad: Array<[string, unknown]> = [
    ["not an array", { field: "dueDate", dir: "asc" }],
    ["empty", []],
    ["an unknown field", [{ field: "estimate", dir: "asc" }]],
    ["a bad direction", [{ field: "dueDate", dir: "up" }]],
    ["a missing direction", [{ field: "dueDate" }]],
    ["a repeated field", [{ field: "dueDate", dir: "asc" }, { field: "dueDate", dir: "desc" }]],
    ["an extra key", [{ field: "dueDate", dir: "asc", nulls: "first" }]],
    ["too many keys", Array.from({ length: PM_SORT_MAX_KEYS + 1 }, (_, i) => ({ field: PM_SORT_FIELDS[i], dir: "asc" }))],
    ["a non-object entry", ["dueDate"]],
  ];
  it.each(bad)("refuses %s", (_n, input) => {
    expect(validatePmSort(input).ok).toBe(false);
  });
});

describe("validatePmGroupBy", () => {
  it.each(PM_GROUP_BY_FIELDS)("accepts %s", (f) => {
    expect(validatePmGroupBy(f)).toEqual({ ok: true, groupBy: f });
  });
  it("refuses anything else", () => {
    expect(validatePmGroupBy("estimate").ok).toBe(false);
    expect(validatePmGroupBy(3).ok).toBe(false);
    expect(validatePmGroupBy("").ok).toBe(false);
  });
});

describe("validatePmColumns", () => {
  it("accepts a short list of column ids", () => {
    expect(validatePmColumns(["key", "state", "dueDate"])).toEqual({ ok: true, columns: ["key", "state", "dueDate"] });
  });
  it("refuses an empty list, a long list, odd ids and repeats", () => {
    expect(validatePmColumns([]).ok).toBe(false);
    expect(validatePmColumns(Array.from({ length: PM_COLUMNS_MAX + 1 }, (_, i) => `c${i}`)).ok).toBe(false);
    expect(validatePmColumns(["a b"]).ok).toBe(false);
    expect(validatePmColumns([""]).ok).toBe(false);
    expect(validatePmColumns(["a", "a"]).ok).toBe(false);
    expect(validatePmColumns("key").ok).toBe(false);
    expect(validatePmColumns([1]).ok).toBe(false);
  });
});
