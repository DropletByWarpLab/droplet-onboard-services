/**
 * WARP-3537 — the table layout's column vocabulary. A saved view carries an
 * ordered list of these ids (`PmSavedView.columns`); WS-6 checks the SHAPE of the
 * list and leaves its MEANING to this file.
 */
import { describe, it, expect } from "vitest";
import { PM_COLUMNS_MAX, validatePmColumns } from "./pm-views";
import {
  PM_TABLE_COLUMN_IDS,
  PM_TABLE_DEFAULT_COLUMNS,
  PM_TABLE_REQUIRED_COLUMN,
  isPmTableColumnId,
  resolveTableColumns,
  tableColumnsFor,
} from "./pm-table";

describe("the vocabulary", () => {
  it("is a valid saved-view column list: every id passes the shape check, and it fits the cap", () => {
    expect(PM_TABLE_COLUMN_IDS.length).toBeLessThanOrEqual(PM_COLUMNS_MAX);
    expect(validatePmColumns([...PM_TABLE_COLUMN_IDS]).ok).toBe(true);
  });

  it("has no duplicates", () => {
    expect(new Set(PM_TABLE_COLUMN_IDS).size).toBe(PM_TABLE_COLUMN_IDS.length);
  });

  it("recognises its own ids and nothing else", () => {
    expect(isPmTableColumnId("state")).toBe(true);
    expect(isPmTableColumnId("cf.8d3f0a6e-1b2c-4d5e-8f90-123456789abc")).toBe(false);
    expect(isPmTableColumnId("nope")).toBe(false);
    expect(isPmTableColumnId(3)).toBe(false);
  });
});

describe("tableColumnsFor", () => {
  it("offers `project` to a workspace table only — in one project every row says the same thing", () => {
    expect(tableColumnsFor("workspace")).toContain("project");
    expect(tableColumnsFor("project")).not.toContain("project");
  });

  it("offers every other column to both", () => {
    const rest = PM_TABLE_COLUMN_IDS.filter((c) => c !== "project");
    expect(tableColumnsFor("project")).toEqual(rest);
    expect(tableColumnsFor("workspace")).toEqual([...PM_TABLE_COLUMN_IDS]);
  });
});

describe("the defaults", () => {
  it("are offered columns, and show the title", () => {
    for (const scope of ["project", "workspace"] as const) {
      const offered = tableColumnsFor(scope);
      for (const c of PM_TABLE_DEFAULT_COLUMNS[scope]) expect(offered).toContain(c);
      expect(PM_TABLE_DEFAULT_COLUMNS[scope]).toContain(PM_TABLE_REQUIRED_COLUMN);
    }
  });

  it("put the project in a workspace table by default, and not in a project's", () => {
    expect(PM_TABLE_DEFAULT_COLUMNS.workspace).toContain("project");
    expect(PM_TABLE_DEFAULT_COLUMNS.project).not.toContain("project");
  });
});

describe("resolveTableColumns", () => {
  it("is the scope's defaults when the view carries none", () => {
    expect(resolveTableColumns(null, "project")).toEqual([...PM_TABLE_DEFAULT_COLUMNS.project]);
    expect(resolveTableColumns(undefined, "workspace")).toEqual([...PM_TABLE_DEFAULT_COLUMNS.workspace]);
    expect(resolveTableColumns([], "project")).toEqual([...PM_TABLE_DEFAULT_COLUMNS.project]);
  });

  it("keeps the saved order", () => {
    expect(resolveTableColumns(["name", "dueDate", "state"], "project")).toEqual(["name", "dueDate", "state"]);
  });

  it("drops what this build does not know — a view saved by a later build still opens", () => {
    expect(resolveTableColumns(["name", "estimate", "cf.abc", "state"], "project")).toEqual(["name", "state"]);
  });

  it("drops duplicates, keeping the first", () => {
    expect(resolveTableColumns(["name", "state", "name", "state"], "project")).toEqual(["name", "state"]);
  });

  it("drops `project` from a project table", () => {
    expect(resolveTableColumns(["key", "project", "name"], "project")).toEqual(["key", "name"]);
    expect(resolveTableColumns(["key", "project", "name"], "workspace")).toEqual(["key", "project", "name"]);
  });

  it("always shows the title: put back after the key when a saved list lacks it", () => {
    expect(resolveTableColumns(["key", "state"], "project")).toEqual(["key", "name", "state"]);
    expect(resolveTableColumns(["state", "priority"], "project")).toEqual(["name", "state", "priority"]);
  });

  it("falls back to the defaults when nothing it knew survives", () => {
    expect(resolveTableColumns(["estimate"], "project")).toEqual([...PM_TABLE_DEFAULT_COLUMNS.project]);
  });
});
