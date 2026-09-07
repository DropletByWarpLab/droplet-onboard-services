/**
 * WARP-2724 — the department guard on the two CREATE paths.
 *
 * ── The defect, and why it survived review ─────────────────────────────────
 *
 * `if (input.departmentId)` is a truthy check, and `department_id: ""` is
 * falsy. So an explicit empty string skipped the assignability guard entirely
 * — and `??` does not coerce `""` either, so it survived
 * `departmentId: input.departmentId ?? null` and reached Postgres as an empty
 * foreign key. A raw P2003 500 on a request the API had every chance to refuse
 * in words.
 *
 * The striking part is that the fix was already written down. Three lines below
 * the department guard in `createProject`, the `companyId` check carries a
 * comment explaining this exact failure — `!== undefined`, not truthiness,
 * because "" is falsy and `??` does not coerce it — and cites WARP-2577 as the
 * ticket that fixed it on five CRM columns. The department column was added
 * later, beside that comment, with the bug the comment describes.
 *
 * So these tests assert the SHAPE, not just the outcome: a guard that fires on
 * an empty string, on both create paths, for the same reason.
 *
 * ── The second half ────────────────────────────────────────────────────────
 *
 * `createWorkItem` ran its check BEFORE `prisma.$transaction` opened, so the
 * department it validated and the department it wrote against were read in
 * different worlds. The check now runs against `tx`. Proven here by handing
 * the fake a transaction client that is a DIFFERENT object from the base one,
 * and asserting the guard read the transaction's.
 */
import { describe, it, expect, vi } from "vitest";
import { createProject, createWorkItem } from "./pm.service.js";
import { PM_DEPARTMENT_ERRORS } from "./pm-department.js";
// 🔴 The shared seam, not a hand-rolled `$transaction: async (fn) => fn(self)`.
// `prisma-tx-seam-adoption.test.ts` (WARP-1570) refuses the hand-rolled shape
// in suites that drive isolation-declaring code, and it is right to: this file
// exercises `createWorkItem`, which asks for SERIALIZABLE_TX, and that stub
// discards the options argument, never rolls back and runs transactions
// strictly serially — so "the guard refused, therefore nothing was written"
// would be unprovable, which is the entire claim these tests make.
import { createTransactionSeam } from "../../__tests__/helpers/prisma-tx-harness.js";

const ACTOR = "user-owner";

/** Records which client each `department.findUnique` was made through. */
function makeFake(opts: { department?: Record<string, unknown> | null } = {}) {
  const seen = { departmentLookups: [] as string[], via: [] as string[] };
  const projectCreate = vi.fn(async () => {
    throw new Error("REACHED_PROJECT_CREATE");
  });
  const workItemCreate = vi.fn(async () => {
    throw new Error("REACHED_WORK_ITEM_CREATE");
  });

  const departmentModel = (via: string) => ({
    findUnique: async ({ where }: { where: { id: string } }) => {
      seen.departmentLookups.push(where.id);
      seen.via.push(via);
      return opts.department === undefined
        ? { id: where.id, kind: "DEPARTMENT", state: "active" }
        : opts.department;
    },
  });

  // The transaction client is deliberately a DISTINCT object, so "the guard
  // ran against tx" is observable rather than assumed.
  const tx = {
    department: departmentModel("tx"),
    pmProject: { update: async () => ({ seqCounter: 1 }) },
    pmWorkItem: { create: workItemCreate },
  };

  const prisma = {
    department: departmentModel("base"),
    pmWorkspace: { upsert: async () => ({ id: "ws-1", slug: "main" }) },
    pmProject: {
      // Two different questions reach this one method, and answering both the
      // same way hangs the suite: `createProject`'s identifier-collision loop
      // is `for (;;)` and treats any row as a clash, so a fake that always
      // returns one never terminates. Keyed on the `where` shape instead.
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        where.workspaceId_identifier
          ? null
          : {
              id: "p1",
              identifier: "PRJ",
              states: [{ id: "s1", isDefault: true, sortOrder: 0, group: "backlog" }],
            },
      create: projectCreate,
    },
    $transaction: createTransactionSeam({ client: () => tx }).$transaction,
  } as never;

  return { prisma, seen, projectCreate, workItemCreate };
}

// ── the empty string, on both create paths ──────────────────────────────────

describe("🔴 an explicit empty department_id is refused, not written", () => {
  it("createProject refuses it by name instead of reaching Postgres", async () => {
    // Before: falsy → guard skipped → `?? null` did not coerce it → an empty
    // FK → P2003 → a redacted 500. Now it is a named 404.
    const h = makeFake({ department: null });
    await expect(
      createProject(h.prisma, ACTOR, { name: "Roof", departmentId: "" }),
    ).rejects.toThrow(PM_DEPARTMENT_ERRORS.DEPARTMENT_NOT_FOUND);
    expect(h.projectCreate).not.toHaveBeenCalled();
  });

  it("createWorkItem refuses it too — the same bug was on both", async () => {
    const h = makeFake({ department: null });
    await expect(
      createWorkItem(h.prisma, ACTOR, "p1", { name: "Order tiles", departmentId: "" }),
    ).rejects.toThrow(PM_DEPARTMENT_ERRORS.DEPARTMENT_NOT_FOUND);
    expect(h.workItemCreate).not.toHaveBeenCalled();
  });

  it("🔴 MUTATION: restore the truthy check and the empty string sails through", async () => {
    // Named so the mutation is written down: `if (input.departmentId)` leaves
    // both tests above green ONLY if the guard is also reached some other way.
    // It is not — so reverting either line turns exactly one of them red, and
    // the create sentinel is what proves the write was reached.
    const h = makeFake({ department: null });
    await expect(
      createProject(h.prisma, ACTOR, { name: "Roof", departmentId: "" }),
    ).rejects.not.toThrow("REACHED_PROJECT_CREATE");
  });

  it("still asks the database about the empty id rather than short-circuiting", async () => {
    // Deliberately NOT a length check in the service. `assertAssignableDepartment`
    // is the one place that decides what a department id means, and a second
    // opinion here would be a rule that can drift from it.
    const h = makeFake({ department: null });
    await createProject(h.prisma, ACTOR, { name: "R", departmentId: "" }).catch(() => {});
    expect(h.seen.departmentLookups).toEqual([""]);
  });
});

// ── absence is still absence ────────────────────────────────────────────────

describe("an absent department is untouched by the fix", () => {
  it("createProject with no department asks nothing and proceeds to the write", async () => {
    // The complement, so the tests above cannot pass by refusing everything.
    const h = makeFake();
    await expect(createProject(h.prisma, ACTOR, { name: "Roof" })).rejects.toThrow(
      "REACHED_PROJECT_CREATE",
    );
    expect(h.seen.departmentLookups).toEqual([]);
  });

  it("createWorkItem with no department asks nothing and proceeds to the write", async () => {
    const h = makeFake();
    await expect(
      createWorkItem(h.prisma, ACTOR, "p1", { name: "Order tiles" }),
    ).rejects.toThrow("REACHED_WORK_ITEM_CREATE");
    expect(h.seen.departmentLookups).toEqual([]);
  });
});

// ── the guard's existing refusals still fire on create ──────────────────────

describe("the assignability rules are unchanged", () => {
  it("HOUSEHOLD is still refused", async () => {
    const h = makeFake({ department: { id: "d1", kind: "HOUSEHOLD", state: "active" } });
    await expect(
      createProject(h.prisma, ACTOR, { name: "R", departmentId: "d1" }),
    ).rejects.toThrow(PM_DEPARTMENT_ERRORS.DEPARTMENT_NOT_ASSIGNABLE);
  });

  it("an archiving department is still refused", async () => {
    const h = makeFake({ department: { id: "d1", kind: "DEPARTMENT", state: "archiving" } });
    await expect(
      createProject(h.prisma, ACTOR, { name: "R", departmentId: "d1" }),
    ).rejects.toThrow(PM_DEPARTMENT_ERRORS.DEPARTMENT_ARCHIVED);
  });

  it("a department mid-provisioning is still ALLOWED", async () => {
    // The negative that matters most: storage convergence is not a
    // precondition for owning work, and a well-meaning `state !== "active"`
    // guard would break this invisibly.
    const h = makeFake({ department: { id: "d1", kind: "DEPARTMENT", state: "provisioning" } });
    await expect(
      createProject(h.prisma, ACTOR, { name: "R", departmentId: "d1" }),
    ).rejects.toThrow("REACHED_PROJECT_CREATE");
  });
});

// ── the check moved inside the transaction ──────────────────────────────────

describe("🔴 createWorkItem checks the department inside its transaction", () => {
  it("reads it through the transaction client, not the base one", async () => {
    // It used to run before `prisma.$transaction` opened, so the department
    // that was checked and the department the row was written against were
    // read in different worlds. Same connection now, same snapshot, no window.
    const h = makeFake();
    await createWorkItem(h.prisma, ACTOR, "p1", { name: "T", departmentId: "d1" }).catch(
      () => {},
    );
    expect(h.seen.via).toEqual(["tx"]);
  });

  it("MUTATION: move it back outside and the lookup comes through the base client", async () => {
    const h = makeFake();
    await createWorkItem(h.prisma, ACTOR, "p1", { name: "T", departmentId: "d1" }).catch(
      () => {},
    );
    expect(h.seen.via).not.toContain("base");
  });
});
