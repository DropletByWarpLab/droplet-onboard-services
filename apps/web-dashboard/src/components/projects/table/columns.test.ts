/**
 * WARP-3537 — the table's column registry. The vocabulary (which ids exist) is
 * shared-types'; this is the dashboard's half: what each id is called, how wide it
 * is, whether a header can sort by it, and whether a cell can be edited in place.
 */
import { describe, it, expect } from "vitest";
import { PM_SORT_FIELDS, PM_TABLE_COLUMN_IDS } from "@droplet/shared-types";
import { COLUMN_DEFS, EDITABLE_COLUMNS, SELECT_COLUMN_WIDTH, gridMinWidth, gridTemplate, sortFieldOf } from "./columns";

describe("the registry", () => {
  it("covers exactly the shared vocabulary — a column id with no definition would draw nothing, a definition with no id could never be saved", () => {
    expect(Object.keys(COLUMN_DEFS).sort()).toEqual([...PM_TABLE_COLUMN_IDS].sort());
  });

  it("titles every column in sentence case, and gives it a width", () => {
    for (const def of Object.values(COLUMN_DEFS)) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.label[0]).toBe(def.label[0].toUpperCase());
      expect(def.label.slice(1)).toBe(def.label.slice(1).toLowerCase());
      expect(def.width).toMatch(/px|fr/);
    }
  });

  it("sorts only by fields the server can order by", () => {
    for (const def of Object.values(COLUMN_DEFS)) {
      if (def.sortField !== null) expect(PM_SORT_FIELDS).toContain(def.sortField);
    }
    expect(sortFieldOf("dueDate")).toBe("dueDate");
    expect(sortFieldOf("assignees")).toBeNull();
    expect(sortFieldOf("labels")).toBeNull();
    expect(sortFieldOf("department")).toBeNull();
  });

  it("edits in place exactly what the spec names — state, priority, assignee, due date — plus the title", () => {
    expect([...EDITABLE_COLUMNS].sort()).toEqual(["assignees", "dueDate", "name", "priority", "state"]);
  });
});

describe("gridTemplate", () => {
  it("puts the checkbox first when the person can select, and the columns in the order given", () => {
    const withBox = gridTemplate(["key", "name", "state"], true).split(" ");
    expect(withBox[0]).toBe(SELECT_COLUMN_WIDTH);
    expect(withBox).toHaveLength(4);
    expect(gridTemplate(["key", "name", "state"], false).split(" ")).toHaveLength(3);
  });

  it("lets the title take the room that is left", () => {
    const tracks = gridTemplate(["key", "name"], false);
    expect(tracks).toContain("minmax(");
    expect(tracks).toContain("fr");
  });
});

describe("gridMinWidth", () => {
  it("adds the fixed tracks and the title's minimum, plus the checkbox when there is one", () => {
    // key 92 + name min 240 + state 140 = 472; the checkbox is 40 more.
    expect(gridMinWidth(["key", "name", "state"], false)).toBe(472);
    expect(gridMinWidth(["key", "name", "state"], true)).toBe(512);
  });
});
