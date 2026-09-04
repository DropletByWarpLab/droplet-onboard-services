/**
 * ADR-045 §5.3 (slice 8) — the department dimension's rules, DB-less lane.
 *
 * The assertions that matter most here are the NEGATIVE ones: that `pending`,
 * `provisioning` and `failed` departments are assignable. Those are the cases a
 * well-meaning `state !== "active"` guard would break, and they would be broken
 * invisibly — every test that only ever uses an `active` department stays green
 * through that mutation. MUTATION: change `ARCHIVE_INTENT_STATES` to
 * `new Set(...)` of everything but `active`, and "stays assignable while
 * Nextcloud has not converged" goes red. That is the guard's whole job.
 *
 * The real-Postgres half (SET NULL, the archived-department tag surviving,
 * the WARP-845 indexes actually existing) is pm-department-dimension.pg.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { ProvisionState } from "@prisma/client";
import {
  ARCHIVE_INTENT_STATES,
  DEPARTMENT_SELECT,
  PM_DEPARTMENT_ERRORS,
  assertAssignableDepartment,
  departmentWorkItemWhere,
  expandDepartmentScope,
  resolveDepartmentRef,
} from "./pm-department.js";

const CLINICAL = {
  id: "dept-clinical",
  name: "Clinical",
  kind: "DEPARTMENT" as const,
  parentId: null,
};
const HYGIENE = {
  id: "team-hygiene",
  name: "Hygiene",
  kind: "TEAM" as const,
  parentId: "dept-clinical",
};

/** Minimal `db.department` stand-in — findUnique for the guard, findMany for
 *  the scope expansion. Records the `where` so the query shape is assertable,
 *  not just its result. */
function makeDb(
  rows: Array<{ id: string; kind: string; state?: ProvisionState; parentId?: string | null }>,
) {
  const calls: { findManyWhere?: unknown } = {};
  return {
    calls,
    db: {
      department: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          rows.find((r) => r.id === where.id) ?? null,
        findMany: async ({ where }: { where: unknown }) => {
          calls.findManyWhere = where;
          const w = where as { OR: Array<Record<string, string>> };
          const target = w.OR[0].id;
          return rows
            .filter((r) => r.id === target || r.parentId === target)
            .map((r) => ({ id: r.id }));
        },
      },
    } as never,
  };
}

describe("DEPARTMENT_SELECT keeps the storage half out of PM", () => {
  it("exposes exactly id/name/kind/parentId — no provisioning field, no BigInt", () => {
    expect(Object.keys(DEPARTMENT_SELECT).sort()).toEqual([
      "id",
      "kind",
      "name",
      "parentId",
    ]);
    // Named individually rather than by a "length is 4" check, so a future
    // author who adds one of these reads WHY it is absent in the failure.
    for (const forbidden of [
      "state",
      "provisionError",
      "nonConvergedSince",
      "quotaBytes",
      "aclVersion",
      "ncGroupRw",
      "ncGroupRo",
      "ncGroupfolderId",
    ]) {
      expect(
        Object.prototype.hasOwnProperty.call(DEPARTMENT_SELECT, forbidden),
        `${forbidden} is a STORAGE field. Handing it to PM is how "the ticket ` +
          `is invisible because the groupfolder has not converged" gets ` +
          `written — the field has to be absent, not merely unused.`,
      ).toBe(false);
    }
  });
});

describe("assignability is decided by INTENT, never by convergence", () => {
  // The non-refusals. These are the point of the whole module.
  for (const state of ["pending", "provisioning", "active", "failed"] as const) {
    it(`stays assignable while Nextcloud has not converged: state=${state}`, async () => {
      const { db } = makeDb([{ ...CLINICAL, state }]);
      await expect(
        assertAssignableDepartment(db, CLINICAL.id),
      ).resolves.toBeUndefined();
    });
  }

  for (const state of ["archiving", "archived", "archive_failed"] as const) {
    it(`refuses a NEW assignment into an archive-intent department: ${state}`, async () => {
      const { db } = makeDb([{ ...CLINICAL, state }]);
      await expect(assertAssignableDepartment(db, CLINICAL.id)).rejects.toThrow(
        PM_DEPARTMENT_ERRORS.DEPARTMENT_ARCHIVED,
      );
    });
  }

  it("ARCHIVE_INTENT_STATES is the archive half and nothing else", () => {
    expect([...ARCHIVE_INTENT_STATES].sort()).toEqual([
      "archive_failed",
      "archived",
      "archiving",
    ]);
  });

  it("refuses HOUSEHOLD explicitly rather than coercing it to null", async () => {
    const { db } = makeDb([
      { id: "dept-household", kind: "HOUSEHOLD", state: "active", parentId: null },
    ]);
    await expect(
      assertAssignableDepartment(db, "dept-household"),
    ).rejects.toThrow(PM_DEPARTMENT_ERRORS.DEPARTMENT_NOT_ASSIGNABLE);
  });

  it("404s an id that does not exist", async () => {
    const { db } = makeDb([]);
    await expect(assertAssignableDepartment(db, "nope")).rejects.toThrow(
      PM_DEPARTMENT_ERRORS.DEPARTMENT_NOT_FOUND,
    );
  });
});

describe("resolveDepartmentRef — the item overrides its project", () => {
  it("prefers the item's own and marks it source=item", () => {
    expect(resolveDepartmentRef(HYGIENE, CLINICAL)).toEqual({
      ...HYGIENE,
      source: "item",
    });
  });

  it("falls back to the project's and marks it source=project", () => {
    expect(resolveDepartmentRef(null, CLINICAL)).toEqual({
      ...CLINICAL,
      source: "project",
    });
  });

  it("is null when neither level owns the work", () => {
    expect(resolveDepartmentRef(null, null)).toBeNull();
  });

  it("treats an un-included relation (undefined) like an absent one", () => {
    // The DB-less route suite's Prisma fake does not resolve includes it was
    // never taught, so `row.department` arrives undefined there.
    expect(resolveDepartmentRef(undefined, undefined)).toBeNull();
    expect(resolveDepartmentRef(undefined, CLINICAL)?.source).toBe("project");
  });
});

describe("expandDepartmentScope — a DEPARTMENT carries its TEAMs", () => {
  it("includes child teams when the target is a department", async () => {
    const { db } = makeDb([
      { ...CLINICAL, state: "active" },
      { ...HYGIENE, state: "active" },
    ]);
    expect((await expandDepartmentScope(db, CLINICAL.id)).sort()).toEqual([
      CLINICAL.id,
      HYGIENE.id,
    ]);
  });

  it("matches only the team when the target is a team", async () => {
    const { db } = makeDb([
      { ...CLINICAL, state: "active" },
      { ...HYGIENE, state: "active" },
    ]);
    expect(await expandDepartmentScope(db, HYGIENE.id)).toEqual([HYGIENE.id]);
  });

  it("an unknown id filters to nothing rather than degrading to no filter", async () => {
    const { db } = makeDb([]);
    expect(await expandDepartmentScope(db, "ghost")).toEqual(["ghost"]);
  });
});

describe("departmentWorkItemWhere", () => {
  it("matches the item's own OR the project's when the item has none", () => {
    expect(departmentWorkItemWhere(["d1", "d2"])).toEqual({
      OR: [
        { departmentId: { in: ["d1", "d2"] } },
        {
          departmentId: null,
          project: { is: { departmentId: { in: ["d1", "d2"] } } },
        },
      ],
    });
  });

  it("'no department' means neither level owns it", () => {
    expect(departmentWorkItemWhere(null)).toEqual({
      departmentId: null,
      project: { is: { departmentId: null } },
    });
  });

  it("never returns a bare top-level OR the caller could assign over where.OR", () => {
    // Guards the review hazard named in the module: `listWorkItems` already
    // owns `where.OR` for `?q=`. This fragment is only ever safe inside
    // `where.AND`, and this assertion is here so a future caller who reads the
    // shape and assigns it to `where.OR` has been warned in the one place they
    // will actually look.
    const frag = departmentWorkItemWhere(["d1"]);
    expect(Object.keys(frag)).toEqual(["OR"]);
  });
});
