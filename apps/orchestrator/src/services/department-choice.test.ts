/**
 * WARP-2981 (ADR-059 §6.1) — `isChoosableDepartment`, the one predicate the
 * server checks on every read and write of a person's department.
 *
 * It must be exactly the set the web switcher offers: `departmentChoices` in
 * lib/departments/active-department.tsx over GET /api/departments' scoping.
 * Both sides run against ONE fixture file (department-choice.fixtures.json),
 * which the dashboard's active-department.test.tsx reads too.
 */
import { describe, it, expect } from "vitest";
import { readPackageFile } from "../__tests__/helpers/test-paths.js";
import { isChoosableDepartment } from "./department-choice.js";

interface FixtureDepartment {
  id: string;
  slug: string;
  name: string;
  kind: string;
  state: string;
}
interface FixtureViewer {
  label: string;
  id: string;
  role: string;
  memberOf: string[];
  choosable: string[];
}
const FIXTURES = JSON.parse(readPackageFile("src/services/department-choice.fixtures.json")) as {
  departments: FixtureDepartment[];
  viewers: FixtureViewer[];
};

describe("isChoosableDepartment — the shared fixtures", () => {
  it.each(FIXTURES.viewers.map((v) => [v.label, v] as const))("%s", (_label, viewer) => {
    const chosen = FIXTURES.departments
      .filter((d) => isChoosableDepartment(d, viewer, viewer.memberOf.includes(d.slug)))
      .map((d) => d.slug)
      .sort();
    expect(chosen).toEqual([...viewer.choosable].sort());
  });

  it("the fixtures cover every kind and every state the schema has", () => {
    expect(new Set(FIXTURES.departments.map((d) => d.kind))).toEqual(
      new Set(["DEPARTMENT", "TEAM", "HOUSEHOLD"]),
    );
    expect(new Set(FIXTURES.departments.map((d) => d.state))).toEqual(
      new Set(["pending", "provisioning", "active", "failed", "archiving", "archived", "archive_failed"]),
    );
  });
});

describe("isChoosableDepartment — each clause on its own", () => {
  const live = { kind: "DEPARTMENT", state: "active" };

  it("a member may choose a live department; a non-member may not", () => {
    expect(isChoosableDepartment(live, { role: "family" }, true)).toBe(true);
    expect(isChoosableDepartment(live, { role: "family" }, false)).toBe(false);
    expect(isChoosableDepartment(live, { role: "guest" }, false)).toBe(false);
  });

  it("owner and admin may choose any live department without a membership", () => {
    expect(isChoosableDepartment(live, { role: "owner" }, false)).toBe(true);
    expect(isChoosableDepartment(live, { role: "admin" }, false)).toBe(true);
  });

  it("only a DEPARTMENT is a choice — never a TEAM or the HOUSEHOLD, whoever asks", () => {
    for (const kind of ["TEAM", "HOUSEHOLD"]) {
      expect(isChoosableDepartment({ kind, state: "active" }, { role: "owner" }, true)).toBe(false);
      expect(isChoosableDepartment({ kind, state: "active" }, { role: "family" }, true)).toBe(false);
    }
  });

  it("an archived or archiving department is never a choice, whoever asks", () => {
    for (const state of ["archived", "archiving"]) {
      expect(isChoosableDepartment({ kind: "DEPARTMENT", state }, { role: "owner" }, true)).toBe(false);
      expect(isChoosableDepartment({ kind: "DEPARTMENT", state }, { role: "family" }, true)).toBe(false);
    }
  });

  it("a service principal is never admitted by role", () => {
    expect(isChoosableDepartment(live, { role: "service" }, false)).toBe(false);
  });
});
