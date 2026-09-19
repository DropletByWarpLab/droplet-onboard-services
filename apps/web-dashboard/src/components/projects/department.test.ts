// ADR-045 §5.3 (slice 8) — the board's department filter, dashboard side.
//
// The assertion that earns its keep is the option UNION: a department the
// caller is not a member of, or one that has been archived, is absent from
// `GET /api/departments` but present on a work item the caller can see, because
// PM is household-shared. Without the union that item's owner is unfilterable
// and the picker quietly lies about what is on the board.

import { describe, it, expect } from "vitest";
import type { Department } from "@/lib/types";
import type { PmWorkItem } from "./types";
import {
  DEPARTMENT_ANY,
  DEPARTMENT_NONE,
  departmentOptions,
  matchesDepartment,
  type DepartmentOption,
} from "./department";

const CLINICAL: DepartmentOption = {
  id: "d-clinical",
  name: "Clinical",
  kind: "DEPARTMENT",
  parentId: null,
};
const HYGIENE: DepartmentOption = {
  id: "d-hygiene",
  name: "Hygiene",
  kind: "TEAM",
  parentId: "d-clinical",
};
const FRONT: DepartmentOption = {
  id: "d-front",
  name: "Front desk",
  kind: "DEPARTMENT",
  parentId: null,
};

function item(
  id: string,
  dept: DepartmentOption | null,
  source: "item" | "project" = "item",
): PmWorkItem {
  return {
    id,
    projectId: "p",
    sequenceId: 1,
    key: `INBOX-${id}`,
    name: id,
    descriptionHtml: null,
    stateId: null,
    state: null,
    priority: "none",
    parentId: null,
    cycleId: null,
    department: dept ? { ...dept, source } : null,
    assignees: [],
    labels: [],
    startDate: null,
    dueDate: null,
    sortOrder: 1,
    completedAt: null,
    createdById: null,
    commentCount: 0,
    subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

/** A `GET /api/departments` row — only the fields the picker reads matter. */
function scopedRow(o: DepartmentOption, over: Partial<Department> = {}): Department {
  return {
    id: o.id,
    name: o.name,
    slug: o.name.toLowerCase().replace(/\s+/g, "-"),
    kind: o.kind,
    parentId: o.parentId,
    description: null,
    state: "active",
    provisionError: null,
    quotaBytes: null,
    aclVersion: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    memberCount: 0,
    teamCount: 0,
    myRight: null,
    usedBytes: null,
    ...over,
  } as Department;
}

describe("departmentOptions", () => {
  it("unions the scoped list with departments seen on the board", () => {
    // Clinical is in the caller's scoped list. Front desk is NOT — the caller
    // holds no membership on it — but a visible work item is owned by it.
    const opts = departmentOptions(
      [item("a", CLINICAL), item("b", FRONT)],
      [scopedRow(CLINICAL)],
    );
    expect(opts.map((o) => o.id).sort()).toEqual(["d-clinical", "d-front"]);
  });

  it("keeps an ARCHIVED department that still owns visible work", () => {
    // Archived units are hidden from a non-admin's /api/departments entirely,
    // so this is the only way their tickets stay filterable.
    const opts = departmentOptions([item("a", FRONT)], []);
    expect(opts.map((o) => o.id)).toEqual(["d-front"]);
  });

  it("never offers HOUSEHOLD, from either source", () => {
    const household: DepartmentOption = {
      id: "d-house",
      name: "Household",
      kind: "HOUSEHOLD",
      parentId: null,
    };
    const opts = departmentOptions(
      [item("a", household)],
      [scopedRow(household)],
    );
    expect(opts).toEqual([]);
  });

  it("survives a failed department read (undefined scoped list)", () => {
    expect(departmentOptions([item("a", CLINICAL)], undefined)).toHaveLength(1);
  });

  it("sorts a team directly under its parent", () => {
    const opts = departmentOptions(
      [],
      [scopedRow(FRONT), scopedRow(HYGIENE), scopedRow(CLINICAL)],
    );
    expect(opts.map((o) => o.name)).toEqual(["Clinical", "Hygiene", "Front desk"]);
  });
});

describe("matchesDepartment", () => {
  const OPTS = [CLINICAL, HYGIENE, FRONT];

  it("matches everything under the default", () => {
    expect(matchesDepartment(item("a", null), DEPARTMENT_ANY, OPTS)).toBe(true);
  });

  it("'no department' means neither the item nor its project owns it", () => {
    expect(matchesDepartment(item("a", null), DEPARTMENT_NONE, OPTS)).toBe(true);
    // Inherited from the project still counts as owned.
    expect(
      matchesDepartment(item("b", CLINICAL, "project"), DEPARTMENT_NONE, OPTS),
    ).toBe(false);
  });

  it("a DEPARTMENT carries its TEAMs", () => {
    expect(matchesDepartment(item("a", HYGIENE), CLINICAL.id, OPTS)).toBe(true);
  });

  it("a TEAM does not reach up to its parent", () => {
    expect(matchesDepartment(item("a", CLINICAL), HYGIENE.id, OPTS)).toBe(false);
  });

  it("matches an inherited department the same as an overridden one", () => {
    expect(
      matchesDepartment(item("a", FRONT, "project"), FRONT.id, OPTS),
    ).toBe(true);
  });

  it("does not match a sibling department", () => {
    expect(matchesDepartment(item("a", FRONT), CLINICAL.id, OPTS)).toBe(false);
  });
});
