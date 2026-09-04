import { describe, it, expect } from "vitest";
import { createWorkItem, deleteState, deleteWorkItem, updateProject, updateState } from "./pm.service.js";
import { SERIALIZABLE_TX } from "../../lib/prisma-tx.js";
// WARP-1570: pm.service.ts now declares an isolation level (deleteWorkItem's
// relation audit), so its suites must inherit the shared seam rather than
// hand-roll a stub that drops the options argument.
import {
  createTransactionSeam,
  expectAllTransactionsAt,
} from "../../__tests__/helpers/prisma-tx-harness.js";

/**
 * WARP-884 / WARP-885 — PM schema hardening regression tests.
 *
 * WARP-884: isCompleted/isArchived are the canonical signals (no more
 * `completedAt`/`archivedAt` IS-NULL derivation); updateState cascades the
 * completion signal to every work item in a state when that state's group
 * flips terminal <-> non-terminal, so nothing can show group="started" via
 * its live state yet isCompleted=true (the split-brain the ticket closes).
 *
 * WARP-885: deleteWorkItem audits the parentId ON DELETE SET NULL cascade
 * with a `parent_removed` activity row per orphaned child, emitted BEFORE
 * the delete in the same transaction.
 *
 * These mirror the hand-rolled fake-Prisma pattern in
 * pm.service.sanitize.test.ts / pm.service.counts.test.ts — no live DB.
 */

type Row = Record<string, unknown>;

// A minimal mapWorkItem-compatible row for the loadWorkItem read-back after
// createWorkItem (state populated so mapWorkItem's state branch is exercised).
function readBackRow(overrides: Row = {}): Row {
  return {
    id: "wi-1",
    projectId: "p1",
    sequenceId: 1,
    name: "x",
    descriptionHtml: null,
    priority: "none",
    stateId: null,
    cycleId: null,
    state: null,
    assignees: [],
    labels: [],
    parentId: null,
    createdById: null,
    startDate: null,
    dueDate: null,
    sortOrder: 1,
    completedAt: null,
    _count: { comments: 0, children: 0 },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("createWorkItem stamps isCompleted alongside completedAt (WARP-884)", () => {
  it("lands in a terminal state (e.g. an explicit 'Done' default) -> isCompleted true + completedAt set", async () => {
    let persisted: Row | undefined;
    const tx = {
      pmProject: { update: async () => ({ seqCounter: 1 }) },
      pmWorkItem: {
        create: async ({ data }: { data: Row }) => {
          persisted = data;
          return { id: "wi-1" };
        },
      },
      pmActivity: { create: async () => ({}) },
    };
    const prisma = {
      pmProject: {
        findUnique: async () => ({
          id: "p1",
          identifier: "PRJ",
          states: [{ id: "s1", isDefault: true, sortOrder: 1, group: "completed", projectId: "p1" }],
        }),
      },
      pmWorkItem: { findUnique: async () => readBackRow() },
      pmState: { findUnique: async () => null },
      pmLabel: { findMany: async () => [] },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await createWorkItem(prisma, null, "p1", { name: "x" });

    expect(persisted!.isCompleted).toBe(true);
    expect(persisted!.completedAt).toBeInstanceOf(Date);
  });

  it("lands in a non-terminal state -> isCompleted false + completedAt null", async () => {
    let persisted: Row | undefined;
    const tx = {
      pmProject: { update: async () => ({ seqCounter: 1 }) },
      pmWorkItem: {
        create: async ({ data }: { data: Row }) => {
          persisted = data;
          return { id: "wi-1" };
        },
      },
      pmActivity: { create: async () => ({}) },
    };
    const prisma = {
      pmProject: {
        findUnique: async () => ({
          id: "p1",
          identifier: "PRJ",
          states: [{ id: "s1", isDefault: true, sortOrder: 1, group: "unstarted", projectId: "p1" }],
        }),
      },
      pmWorkItem: { findUnique: async () => readBackRow() },
      pmState: { findUnique: async () => null },
      pmLabel: { findMany: async () => [] },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await createWorkItem(prisma, null, "p1", { name: "x" });

    expect(persisted!.isCompleted).toBe(false);
    expect(persisted!.completedAt).toBeNull();
  });
});

describe("updateState completion-signal cascade (WARP-884 split-brain)", () => {
  it("flips isCompleted=true + stamps completedAt for every item sitting in a state that becomes terminal", async () => {
    let updateManyArgs: { where: Row; data: Row } | undefined;
    const tx = {
      pmState: {
        update: async ({ data }: { data: Row }) => ({ id: "s1", projectId: "p1", group: "completed", ...data }),
      },
      pmWorkItem: {
        updateMany: async (args: { where: Row; data: Row }) => {
          updateManyArgs = args;
          return { count: 2 };
        },
      },
    };
    const prisma = {
      pmState: { findUnique: async () => ({ id: "s1", projectId: "p1", group: "started", name: "In Progress" }) },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await updateState(prisma, "s1", { group: "completed" });

    expect(updateManyArgs).toBeDefined();
    expect(updateManyArgs!.where).toMatchObject({ stateId: "s1", isCompleted: false });
    expect(updateManyArgs!.data.isCompleted).toBe(true);
    expect(updateManyArgs!.data.completedAt).toBeInstanceOf(Date);
  });

  it("flips isCompleted=false + clears completedAt for every item when a state LEAVES the terminal group", async () => {
    let updateManyArgs: { where: Row; data: Row } | undefined;
    const tx = {
      pmState: {
        update: async ({ data }: { data: Row }) => ({ id: "s1", projectId: "p1", group: "started", ...data }),
      },
      pmWorkItem: {
        updateMany: async (args: { where: Row; data: Row }) => {
          updateManyArgs = args;
          return { count: 1 };
        },
      },
    };
    const prisma = {
      pmState: { findUnique: async () => ({ id: "s1", projectId: "p1", group: "completed", name: "Done" }) },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await updateState(prisma, "s1", { group: "started" });

    expect(updateManyArgs).toBeDefined();
    expect(updateManyArgs!.where).toMatchObject({ stateId: "s1", isCompleted: true });
    expect(updateManyArgs!.data).toMatchObject({ isCompleted: false, completedAt: null });
  });

  it("does not cascade when the group is unchanged (e.g. a plain rename)", async () => {
    let called = false;
    const tx = {
      pmState: {
        update: async ({ data }: { data: Row }) => ({ id: "s1", projectId: "p1", group: "started", ...data }),
      },
      pmWorkItem: {
        updateMany: async () => {
          called = true;
          return { count: 0 };
        },
      },
    };
    const prisma = {
      pmState: { findUnique: async () => ({ id: "s1", projectId: "p1", group: "started", name: "In Progress" }) },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await updateState(prisma, "s1", { name: "Doing" });

    expect(called).toBe(false);
  });

  it("does not cascade when flipping between two terminal groups (completed -> cancelled)", async () => {
    let called = false;
    const tx = {
      pmState: {
        update: async ({ data }: { data: Row }) => ({ id: "s1", projectId: "p1", group: "cancelled", ...data }),
      },
      pmWorkItem: {
        updateMany: async () => {
          called = true;
          return { count: 0 };
        },
      },
    };
    const prisma = {
      pmState: { findUnique: async () => ({ id: "s1", projectId: "p1", group: "completed", name: "Done" }) },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await updateState(prisma, "s1", { group: "cancelled" });

    expect(called).toBe(false);
  });
});

describe("deleteWorkItem parent-removal audit (WARP-885)", () => {
  it("emits one parent_removed activity row per orphaned child BEFORE deleting the parent", async () => {
    const activityRows: Row[] = [];
    let deletedId: string | undefined;
    const tx = {
      pmWorkItem: {
        findMany: async ({ where }: { where: Row }) => {
          expect(where).toMatchObject({ parentId: "parent-1" });
          return [{ id: "child-1" }, { id: "child-2" }];
        },
        delete: async ({ where }: { where: Row }) => {
          // The audit rows must already be recorded by the time the parent
          // itself is deleted — same-transaction ordering guard.
          expect(activityRows).toHaveLength(2);
          deletedId = where.id as string;
          return {};
        },
      },
      pmActivity: {
        create: async ({ data }: { data: Row }) => {
          activityRows.push(data);
          return data;
        },
        createMany: async ({ data }: { data: Row[] }) => {
          activityRows.push(...data);
          return { count: data.length };
        },
      },
      // WARP-2586 — deleteWorkItem now reads the item's relations before the
      // cascade, so it can emit a relation_removed audit row on the SURVIVING
      // end. Empty here: these two cases are about parent_removed.
      pmWorkItemRelation: { findMany: async () => [] },
    };
    const prisma = {
      pmWorkItem: { findUnique: async () => ({ id: "parent-1" }) },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await deleteWorkItem(prisma, "actor-1", "parent-1");

    expect(deletedId).toBe("parent-1");
    expect(activityRows).toEqual([
      expect.objectContaining({
        workItemId: "child-1",
        actorId: "actor-1",
        verb: "parent_removed",
        field: "parentId",
        oldValue: "parent-1",
        newValue: null,
      }),
      expect.objectContaining({
        workItemId: "child-2",
        actorId: "actor-1",
        verb: "parent_removed",
      }),
    ]);
  });

  it("deletes cleanly with zero activity rows when the work item has no children", async () => {
    let activityCreated = false;
    const tx = {
      pmWorkItem: {
        findMany: async () => [],
        delete: async () => ({}),
      },
      pmActivity: {
        create: async () => {
          activityCreated = true;
          return {};
        },
        createMany: async () => {
          activityCreated = true;
          return { count: 0 };
        },
      },
      // WARP-2586 — deleteWorkItem now reads the item's relations before the
      // cascade, so it can emit a relation_removed audit row on the SURVIVING
      // end. Empty here: these two cases are about parent_removed.
      pmWorkItemRelation: { findMany: async () => [] },
    };
    const prisma = {
      pmWorkItem: { findUnique: async () => ({ id: "leaf-1" }) },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await deleteWorkItem(prisma, null, "leaf-1");

    expect(activityCreated).toBe(false);
  });

  // WARP-2586 (review): the relation audit is the part worth a test of its
  // own -- an audit obligation standing in for a silent FK cascade.
  it("emits relation_removed on the SURVIVING end of every edge, before the delete, at SERIALIZABLE", async () => {
    const audit: Row[] = [];
    let deleted = false;
    const tx = {
      pmWorkItem: {
        findMany: async () => [],
        delete: async () => {
          // Audit rows first; the cascade must never be the only record.
          expect(audit).toHaveLength(2);
          deleted = true;
          return {};
        },
      },
      pmActivity: {
        create: async ({ data }: { data: Row }) => {
          audit.push(data);
          return data;
        },
        createMany: async ({ data }: { data: Row[] }) => {
          audit.push(...data);
          return { count: data.length };
        },
      },
      pmWorkItemRelation: {
        findMany: async ({ where }: { where: Row }) => {
          expect(where).toEqual({ OR: [{ fromId: "x" }, { toId: "x" }] });
          return [
            { fromId: "x", toId: "other-1", kind: "BLOCKS" },
            { fromId: "other-2", toId: "x", kind: "RELATES" },
          ];
        },
      },
    };
    const seam = createTransactionSeam({ client: () => tx });
    const prisma = {
      pmWorkItem: { findUnique: async () => ({ id: "x" }) },
      $transaction: seam.$transaction,
    } as never;

    await deleteWorkItem(prisma, "actor-1", "x");

    expect(deleted).toBe(true);
    // A relation committed between the audit read and the delete must abort
    // this transaction, not slip through the cascade unrecorded. The seam
    // records the options argument, so dropping SERIALIZABLE_TX goes red.
    expectAllTransactionsAt(seam, SERIALIZABLE_TX);
    expect(audit).toEqual([
      expect.objectContaining({
        workItemId: "other-1",
        actorId: "actor-1",
        verb: "relation_removed",
        field: "relation",
        oldValue: "BLOCKS:x",
        newValue: null,
      }),
      expect.objectContaining({
        workItemId: "other-2",
        verb: "relation_removed",
        oldValue: "RELATES:x",
      }),
    ]);
  });

  it("reports the SERIALIZABLE loser as concurrent_mutation, never a 500", async () => {
    const seam = createTransactionSeam({ client: () => ({}) });
    seam.$transaction.mockImplementationOnce(async () => {
      throw Object.assign(new Error("could not serialize access"), { code: "P2034" });
    });
    const prisma = {
      pmWorkItem: { findUnique: async () => ({ id: "x" }) },
      $transaction: seam.$transaction,
    } as never;
    await expect(deleteWorkItem(prisma, null, "x")).rejects.toThrow("concurrent_mutation");
  });
});

describe("updateProject archival signal sync (WARP-884)", () => {
  function baseProjectRow(overrides: Row = {}): Row {
    return {
      id: "p1",
      workspaceId: "w1",
      name: "P",
      identifier: "PRJ",
      description: null,
      icon: null,
      color: null,
      leadId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it("archiving sets isArchived=true and stamps archivedAt", async () => {
    let persisted: Row | undefined;
    const prisma = {
      pmProject: {
        findUnique: async () => baseProjectRow(),
        update: async ({ data, include }: { data: Row; include?: Row }) => {
          persisted = data;
          return {
            ...baseProjectRow(),
            ...data,
            ...(include?.workspace ? { workspace: { slug: "home" } } : {}),
          };
        },
      },
    } as never;

    const result = await updateProject(prisma, "p1", { archived: true });

    expect(persisted!.isArchived).toBe(true);
    expect(persisted!.archivedAt).toBeInstanceOf(Date);
    expect(result.archived).toBe(true);
  });

  it("unarchiving clears isArchived and archivedAt together", async () => {
    let persisted: Row | undefined;
    const prisma = {
      pmProject: {
        findUnique: async () => baseProjectRow({ isArchived: true, archivedAt: new Date() }),
        update: async ({ data, include }: { data: Row; include?: Row }) => {
          persisted = data;
          return {
            ...baseProjectRow(),
            ...data,
            ...(include?.workspace ? { workspace: { slug: "home" } } : {}),
          };
        },
      },
    } as never;

    const result = await updateProject(prisma, "p1", { archived: false });

    expect(persisted!.isArchived).toBe(false);
    expect(persisted!.archivedAt).toBeNull();
    expect(result.archived).toBe(false);
  });
});

describe("deleteState reassignment (WARP-885 no NULL-state limbo)", () => {
  it("reassigns work items to the project's default state and resyncs completion when terminal-ness differs", async () => {
    let updateManyArgs: { where: Row; data: Row } | undefined;
    let deletedId: string | undefined;
    const tx = {
      pmState: {
        findFirst: async ({ where }: { where: Row }) => {
          expect(where).toMatchObject({ projectId: "p1", isDefault: true, id: { not: "s-done" } });
          return { id: "s-default", projectId: "p1", group: "unstarted", isDefault: true };
        },
        delete: async ({ where }: { where: Row }) => {
          deletedId = where.id as string;
          return {};
        },
      },
      pmWorkItem: {
        updateMany: async (args: { where: Row; data: Row }) => {
          updateManyArgs = args;
          return { count: 2 };
        },
      },
    };
    const prisma = {
      pmState: {
        findUnique: async () => ({ id: "s-done", projectId: "p1", group: "completed", isDefault: false }),
        count: async () => 3, // > 1 sibling -> passes the STATE_IS_LAST guard
      },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await deleteState(prisma, "s-done");

    expect(updateManyArgs).toBeDefined();
    expect(updateManyArgs!.where).toEqual({ stateId: "s-done" });
    expect(updateManyArgs!.data).toMatchObject({
      stateId: "s-default",
      isCompleted: false,
      completedAt: null,
    });
    expect(deletedId).toBe("s-done");
  });

  it("reassigns stateId only (no completion-signal override) when terminal-ness matches the default", async () => {
    let updateManyArgs: { where: Row; data: Row } | undefined;
    const tx = {
      pmState: {
        findFirst: async () => ({ id: "s-default", projectId: "p1", group: "unstarted", isDefault: true }),
        delete: async () => ({}),
      },
      pmWorkItem: {
        updateMany: async (args: { where: Row; data: Row }) => {
          updateManyArgs = args;
          return { count: 1 };
        },
      },
    };
    const prisma = {
      pmState: {
        findUnique: async () => ({ id: "s-backlog", projectId: "p1", group: "backlog", isDefault: false }),
        count: async () => 3,
      },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await deleteState(prisma, "s-backlog");

    expect(updateManyArgs!.data).toEqual({ stateId: "s-default" });
  });

  it("skips reassignment (leaves items NULL-state) when the project has no default state at all", async () => {
    let updateManyCalled = false;
    let deletedId: string | undefined;
    const tx = {
      pmState: {
        findFirst: async () => null,
        delete: async ({ where }: { where: Row }) => {
          deletedId = where.id as string;
          return {};
        },
      },
      pmWorkItem: {
        updateMany: async () => {
          updateManyCalled = true;
          return { count: 0 };
        },
      },
    };
    const prisma = {
      pmState: {
        findUnique: async () => ({ id: "s-only-nondefault", projectId: "p1", group: "started", isDefault: false }),
        count: async () => 2,
      },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await deleteState(prisma, "s-only-nondefault");

    expect(updateManyCalled).toBe(false);
    expect(deletedId).toBe("s-only-nondefault");
  });
});
