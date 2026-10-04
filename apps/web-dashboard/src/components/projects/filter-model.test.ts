// WARP-3522 — the filter bar's model: a filter as a search box plus chips, the
// words each chip is written in, and the fields the menu offers.

import { describe, it, expect } from "vitest";
import { PM_FILTER_FIELD_NAMES, validatePmFilter, type PmFilter } from "@droplet/shared-types";
import {
  DATE_PRESETS,
  EMPTY_FILTER,
  availableFields,
  describeChip,
  describeDateToken,
  joinFilter,
  multiChip,
  presenceChip,
  readMulti,
  splitFilter,
  withChip,
  withText,
  withoutChip,
} from "./filter-model";

const leaf = (field: string, op: string, value?: unknown) =>
  (value === undefined ? { field, op } : { field, op, value }) as PmFilter;

const MINE = leaf("assignee", "is", "me");
const HIGH = leaf("priority", "is", "high");
const TEXT = leaf("text", "contains", "login");

describe("splitFilter / joinFilter", () => {
  it("no filter is an empty bar", () => {
    expect(splitFilter(EMPTY_FILTER)).toEqual({ text: "", chips: [] });
  });

  it("a lone condition is one chip", () => {
    expect(splitFilter(MINE)).toEqual({ text: "", chips: [MINE] });
  });

  it("the text condition is the search box, every other child is a chip", () => {
    expect(splitFilter({ and: [TEXT, MINE, HIGH] })).toEqual({ text: "login", chips: [MINE, HIGH] });
    expect(splitFilter({ and: [MINE, TEXT] })).toEqual({ text: "login", chips: [MINE] });
  });

  it("an `or` group is ONE chip the bar never takes apart", () => {
    const either: PmFilter = { or: [MINE, HIGH] };
    expect(splitFilter({ and: [either, TEXT] })).toEqual({ text: "login", chips: [either] });
    expect(splitFilter(either)).toEqual({ text: "", chips: [either] });
  });

  it("joins back to a canonical filter: text first, then the chips", () => {
    expect(joinFilter({ text: "login", chips: [MINE, HIGH] })).toEqual({ and: [TEXT, MINE, HIGH] });
    expect(joinFilter({ text: "", chips: [MINE] })).toEqual(MINE);
    expect(joinFilter({ text: "  ", chips: [] })).toEqual(EMPTY_FILTER);
  });

  it("trims and bounds the search text", () => {
    expect(joinFilter({ text: "  login  ", chips: [] })).toEqual(TEXT);
    const long = joinFilter({ text: "x".repeat(500), chips: [] }) as { field: string; value: string };
    expect(long.value).toHaveLength(200);
    expect(validatePmFilter(long).ok).toBe(true);
  });

  it("round-trips: split then join is the same filter", () => {
    for (const f of [EMPTY_FILTER, MINE, { and: [TEXT, MINE, HIGH] }, { or: [MINE, HIGH] }, { and: [HIGH, { or: [MINE, TEXT] }] }] as PmFilter[]) {
      expect(joinFilter(splitFilter(f))).toEqual(f);
    }
  });
});

describe("editing the chips", () => {
  const base: PmFilter = { and: [TEXT, MINE, HIGH] };

  it("appends a chip, keeping the search text", () => {
    const next = withChip(base, -1, leaf("assignee", "isEmpty"));
    expect(splitFilter(next).chips).toEqual([MINE, HIGH, leaf("assignee", "isEmpty")]);
    expect(splitFilter(next).text).toBe("login");
  });

  it("replaces a chip in place", () => {
    const next = withChip(base, 0, leaf("assignee", "isNot", "me"));
    expect(splitFilter(next).chips).toEqual([leaf("assignee", "isNot", "me"), HIGH]);
  });

  it("removes a chip, and removing the last leaves 'no filter'", () => {
    expect(splitFilter(withoutChip(base, 0)).chips).toEqual([HIGH]);
    expect(withoutChip(MINE, 0)).toEqual(EMPTY_FILTER);
  });

  it("sets and clears the search text", () => {
    expect(splitFilter(withText(MINE, "bug")).text).toBe("bug");
    expect(withText({ and: [TEXT, MINE] }, "")).toEqual(MINE);
  });

  it("always produces a filter the shared validator accepts", () => {
    for (const f of [withChip(base, -1, presenceChip("cycle", true)), withText(base, "x"), withoutChip(base, 1)]) {
      expect(validatePmFilter(f).ok).toBe(true);
    }
  });
});

describe("describeChip", () => {
  const lk = {
    stateName: (id: string) => ({ s1: "In Progress" })[id],
    labelName: (id: string) => ({ l1: "Bug", l2: "Docs" })[id],
    personName: (id: string) => ({ u1: "Ana" })[id],
    departmentName: (ref: string) => ({ d1: "Clinical" })[ref],
    projectName: (id: string) => ({ p1: "Onboarding" })[id],
  };

  it.each([
    [leaf("state", "is", "s1"), "State is In Progress"],
    [leaf("label", "in", ["l1", "l2"]), "Label is Bug or Docs"],
    [leaf("label", "notIn", ["l1", "l2"]), "Label is none of Bug, Docs"],
    [leaf("assignee", "is", "me"), "Assignee is me"],
    [leaf("assignee", "is", "u1"), "Assignee is Ana"],
    [leaf("assignee", "isNot", "u1"), "Assignee is not Ana"],
    [leaf("assignee", "in", ["me", "none"]), "Assignee is me or nobody"],
    [leaf("assignee", "isEmpty"), "Assignee is empty"],
    [leaf("assignee", "isNotEmpty"), "Assignee is set"],
    [leaf("priority", "in", ["urgent", "high"]), "Priority is Urgent or High"],
    [leaf("stateGroup", "notIn", ["completed", "cancelled"]), "Stage is none of Done, Cancelled"],
    [leaf("dueDate", "before", "today"), "Due date before today"],
    [leaf("dueDate", "after", "2026-10-03"), "Due date after 2026-10-03"],
    [leaf("dueDate", "between", ["-7d", "today"]), "Due date between 7 days ago and today"],
    [leaf("dueDate", "between", ["today", "+14d"]), "Due date between today and in 2 weeks"],
    [leaf("createdAt", "is", "yesterday"), "Created is yesterday"],
    [leaf("department", "is", "d1"), "Department is Clinical"],
    [leaf("department", "is", "none"), "Department is no department"],
    [leaf("department", "is", "Front desk"), "Department is Front desk"],
    [leaf("project", "in", ["p1"]), "Project is Onboarding"],
    [leaf("isArchived", "is", true), "Archived items only"],
    [leaf("parent", "isEmpty"), "Parent is empty"],
    [{ or: [MINE, HIGH] }, "Custom filter"],
  ])("%j → %s", (chip, words) => {
    expect(describeChip(chip as PmFilter, lk)).toBe(words);
  });

  it("falls back to plain words for something it cannot name", () => {
    expect(describeChip(leaf("state", "is", "gone"))).toBe("State is a state");
    expect(describeChip(leaf("assignee", "is", "gone"))).toBe("Assignee is a former member");
    expect(describeChip(leaf("label", "is", "gone"))).toBe("Label is a label");
    expect(describeChip(leaf("cycle", "is", "gone"))).toBe("Cycle is a cycle");
  });
});

describe("describeDateToken", () => {
  it.each([
    ["today", "today"],
    ["-1d", "1 day ago"],
    ["+1d", "in 1 day"],
    ["-7d", "7 days ago"],
    ["+14d", "in 2 weeks"],
    ["-2w", "2 weeks ago"],
    ["+10d", "in 10 days"],
    ["2026-10-03", "2026-10-03"],
  ])("%s → %s", (token, words) => {
    expect(describeDateToken(token)).toBe(words);
  });
});

describe("availableFields", () => {
  const names = (scope: "project" | "workspace", departments = true) =>
    availableFields(scope, { departments }).map((f) => f.field);

  it("offers every DSL field but the search box, in a project", () => {
    const offered = new Set(names("project"));
    for (const f of PM_FILTER_FIELD_NAMES) {
      if (f === "text" || f === "project") continue;
      expect(offered.has(f), f).toBe(true);
    }
    expect(offered.has("project")).toBe(false);
  });

  it("a workspace-wide view has no per-project state or label, and adds project", () => {
    const offered = new Set(names("workspace"));
    expect(offered.has("state")).toBe(false);
    expect(offered.has("label")).toBe(false);
    expect(offered.has("project")).toBe(true);
    expect(offered.has("stateGroup")).toBe(true);
  });

  it("hides the department filter when nothing on this box owns work", () => {
    expect(names("project", false)).not.toContain("department");
    expect(names("project", true)).toContain("department");
  });

  it("every editor kind it names exists", () => {
    for (const f of availableFields("project", { departments: true })) {
      expect(["multi", "date", "presence", "toggle"]).toContain(f.editor);
    }
  });
});

describe("date presets", () => {
  it("are all relative tokens the shared validator accepts, for any date field", () => {
    for (const preset of DATE_PRESETS) {
      for (const field of ["dueDate", "startDate", "createdAt", "updatedAt"] as const) {
        expect(validatePmFilter(preset.chip(field)).ok, `${preset.id}/${field}`).toBe(true);
      }
    }
  });

  it("include an overdue-style 'before today'", () => {
    const p = DATE_PRESETS.find((x) => x.id === "before-today")!;
    expect(p.chip("dueDate")).toEqual(leaf("dueDate", "before", "today"));
  });
});

describe("multiChip / readMulti", () => {
  it("one value is is / isNot, several are in / notIn", () => {
    expect(multiChip("assignee", "any", ["me"])).toEqual(leaf("assignee", "is", "me"));
    expect(multiChip("assignee", "any", ["me", "u1"])).toEqual(leaf("assignee", "in", ["me", "u1"]));
    expect(multiChip("label", "none", ["l1"])).toEqual(leaf("label", "isNot", "l1"));
    expect(multiChip("label", "none", ["l1", "l2"])).toEqual(leaf("label", "notIn", ["l1", "l2"]));
  });

  it("reads one back", () => {
    expect(readMulti(leaf("assignee", "is", "me"))).toEqual({ mode: "any", values: ["me"] });
    expect(readMulti(leaf("label", "notIn", ["a", "b"]))).toEqual({ mode: "none", values: ["a", "b"] });
    expect(readMulti(leaf("assignee", "isEmpty"))).toBeNull();
    expect(readMulti({ or: [MINE, HIGH] })).toBeNull();
  });
});

describe("presenceChip", () => {
  it("has / has none", () => {
    expect(presenceChip("cycle", true)).toEqual(leaf("cycle", "isNotEmpty"));
    expect(presenceChip("parent", false)).toEqual(leaf("parent", "isEmpty"));
  });
});
