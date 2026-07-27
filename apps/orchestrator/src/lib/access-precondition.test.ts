/**
 * WARP-1583 — the converged in-transaction precondition mechanism.
 *
 * T3 shipped TWO answers to one problem. `routes/access.ts` raised a local
 * `AccessPreconditionError` and let it unwind; `routes/people.ts` returned a
 * discriminated `{ kind }` union and mapped it after the transaction closed.
 * Each was reasonable where it stood, and having both means the next author
 * picks by coin flip.
 *
 * The convergence is on THROWING, and this suite pins why: the two shapes
 * are equivalent only while every precondition is discovered before the
 * first write. The union commits whatever the transaction has already done;
 * an unwind rolls it back. So the union is fail-OPEN by construction — its
 * safety depends on a future author noticing that a new check has to go
 * above the writes, in a callback where nothing says so.
 *
 * Throwing also collapses the route's catch to one shape, since the guard
 * rails (`RoleMutationRefusedError`) already unwind with the same
 * `status` + `toJSON()` contract.
 */
import { describe, it, expect } from "vitest";
import {
  AccessPreconditionError,
  isAccessPreconditionError,
} from "./access-precondition.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";

describe("AccessPreconditionError — one definition of the shared refusals", () => {
  it("role-not-found is a 404 with the shipped body", () => {
    const err = AccessPreconditionError.roleNotFound();
    expect(err.status).toBe(404);
    expect(err.toJSON()).toEqual({ error: "Role not found" });
  });

  it("role-archived is a 409 carrying the machine code the dashboard branches on", () => {
    const err = AccessPreconditionError.roleArchived();
    expect(err.status).toBe(409);
    expect(err.toJSON()).toEqual({
      error: "This role is archived — restore it before assigning people.",
      code: "ACCESS_ROLE_ARCHIVED",
    });
  });

  it("user-not-found is a 404, and names the missing ids only when asked", () => {
    expect(AccessPreconditionError.userNotFound().toJSON()).toEqual({
      error: "User not found",
    });
    // The bulk assign path reports WHICH ids missed; the single-target path
    // has nothing to add, and an empty `missing: []` there would read as
    // "nobody was missing" on a 404.
    expect(AccessPreconditionError.userNotFound(["u-9"]).toJSON()).toEqual({
      error: "User not found",
      missing: ["u-9"],
    });
  });

  it("is recognisable across module boundaries", () => {
    expect(isAccessPreconditionError(AccessPreconditionError.roleNotFound())).toBe(true);
    expect(isAccessPreconditionError(new Error("nope"))).toBe(false);
    expect(isAccessPreconditionError(null)).toBe(false);
  });
});

describe("AccessPreconditionError — why throwing, not a discriminated outcome", () => {
  /**
   * The property the union cannot have. Both shapes agree today because
   * every precondition in both routes happens to precede the first write;
   * this is what happens the day one does not.
   */
  it("unwinding a precondition undoes writes the transaction already made", async () => {
    const rows: Array<{ id: string; role: string }> = [{ id: "u-1", role: "family" }];
    const prisma: Record<string, unknown> = {
      user: {
        async update({ where, data }: { where: { id: string }; data: { role: string } }) {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return { ...row };
        },
      },
    };
    const seam = createTransactionSeam({ client: () => prisma, stores: { rows } });

    await expect(
      seam.$transaction(async (tx: typeof prisma) => {
        await (tx.user as { update: (a: unknown) => Promise<unknown> }).update({
          where: { id: "u-1" },
          data: { role: "admin" },
        });
        throw AccessPreconditionError.roleArchived();
      }),
    ).rejects.toBeInstanceOf(AccessPreconditionError);

    expect(rows).toEqual([{ id: "u-1", role: "family" }]);
  });

  it("a returned outcome commits those writes — the shape being retired", async () => {
    const rows: Array<{ id: string; role: string }> = [{ id: "u-1", role: "family" }];
    const prisma: Record<string, unknown> = {
      user: {
        async update({ where, data }: { where: { id: string }; data: { role: string } }) {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return { ...row };
        },
      },
    };
    const seam = createTransactionSeam({ client: () => prisma, stores: { rows } });

    const outcome = await seam.$transaction(async (tx: typeof prisma) => {
      await (tx.user as { update: (a: unknown) => Promise<unknown> }).update({
        where: { id: "u-1" },
        data: { role: "admin" },
      });
      return { kind: "role_archived" } as const;
    });

    expect(outcome).toEqual({ kind: "role_archived" });
    // The route would answer 409 "nothing was applied" while the row moved.
    expect(rows).toEqual([{ id: "u-1", role: "admin" }]);
  });
});
