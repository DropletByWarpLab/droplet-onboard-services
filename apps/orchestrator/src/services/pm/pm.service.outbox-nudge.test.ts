/**
 * Shared PmActivity writers wake the outbox without moving audit rows outside
 * their transaction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./pm-outbox.js", () => ({ nudgeOutbox: vi.fn() }));

import { nudgeOutbox } from "./pm-outbox.js";
import { addComment, deleteWorkItem, writeActivity } from "./pm.service.js";
import { createTransactionSeam, expectAllTransactionsAt } from "../../__tests__/helpers/prisma-tx-harness.js";

const T0 = new Date("2026-10-04T12:00:00.000Z");

function prismaStub() {
  const tx = {
    pmComment: {
      create: vi.fn(async () => ({
        id: "c-1", workItemId: "wi-1", authorId: "u-1", commentHtml: "<p>hi</p>", createdAt: T0, updatedAt: T0,
      })),
    },
    pmActivity: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    tx,
    pmWorkItem: { findUnique: vi.fn(async () => ({ id: "wi-1" })) },
  };
  const seam = createTransactionSeam({ client: () => tx });
  return { ...prisma, $transaction: seam.$transaction };
}

function relationDeleteStub(deleteWorkItemRow: () => Promise<unknown> = async () => ({})) {
  let inTransaction = false;
  const tx = {
    pmWorkItem: {
      findMany: vi.fn(async () => []),
      delete: vi.fn(deleteWorkItemRow),
    },
    pmWorkItemAssignee: { findMany: vi.fn(async () => []) },
    pmAttachment: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    pmWorkItemRelation: {
      findMany: vi.fn(async () => [{ fromId: "wi-1", toId: "wi-2", kind: "RELATES" }]),
    },
    pmActivity: {
      create: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const seam = createTransactionSeam({ client: () => tx });
  const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>, options?: unknown) => {
    inTransaction = true;
    try {
      return await seam.$transaction(callback, options);
    } finally {
      inTransaction = false;
    }
  });
  const prisma = {
    tx,
    $transaction: transaction,
    pmWorkItem: { findUnique: vi.fn(async () => ({ id: "wi-1", projectId: "p-1", project: { kind: "PROJECT" } })) },
  };
  return { prisma, tx, transaction, inTransaction: () => inTransaction };
}

beforeEach(() => vi.clearAllMocks());

describe("writeActivity nudges the outbox", () => {
  it("after writing the activity row, once per row", async () => {
    const prisma = prismaStub();
    await addComment(prisma as never, "u-1", "wi-1", "<p>hi</p>");

    expect(prisma.tx.pmActivity.create).toHaveBeenCalledTimes(1);
    expect(nudgeOutbox).toHaveBeenCalledTimes(1);
    // Order: the row first, then the wake-up (the wake-up is useless before it).
    const rowAt = prisma.tx.pmActivity.create.mock.invocationCallOrder[0]!;
    const nudgeAt = vi.mocked(nudgeOutbox).mock.invocationCallOrder[0]!;
    expect(nudgeAt).toBeGreaterThan(rowAt);
  });

  it("does not nudge when the activity write fails", async () => {
    const prisma = prismaStub();
    prisma.tx.pmActivity.create.mockRejectedValueOnce(new Error("boom"));
    await expect(addComment(prisma as never, "u-1", "wi-1", "<p>hi</p>")).rejects.toThrow("boom");
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });

  it("wakes for relation-removal audit rows only after delete commit", async () => {
    const h = relationDeleteStub();
    vi.mocked(nudgeOutbox).mockImplementation(() => {
      expect(h.inTransaction()).toBe(false);
    });

    await deleteWorkItem(h.prisma as never, "u-1", "wi-1");

    expect(h.tx.pmActivity.createMany).toHaveBeenCalledTimes(1);
    expect(h.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable", timeout: 5_000 });
    expect(nudgeOutbox).toHaveBeenCalledTimes(1);
  });

  it("does not wake when relation-removal audit rows roll back with the delete", async () => {
    const h = relationDeleteStub(async () => {
      throw new Error("delete failed");
    });

    await expect(deleteWorkItem(h.prisma as never, "u-1", "wi-1")).rejects.toThrow("delete failed");

    expect(h.tx.pmActivity.createMany).toHaveBeenCalledTimes(1);
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });
});

describe("delete tombstones nudge only after commit", () => {
  it("does not wake consumers until the delete transaction has committed", async () => {
    const tx = {
      pmWorkItem: { findMany: vi.fn(async () => []), delete: vi.fn(async () => ({})) },
      pmWorkItemAssignee: { findMany: vi.fn(async () => []) },
      pmAttachment: { findMany: vi.fn(async () => []) },
      pmWorkItemRelation: { findMany: vi.fn(async () => []) },
      user: { findMany: vi.fn(async () => []) },
      pmActivity: { create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({ count: 0 })) },
    };
    const prisma = {
      pmWorkItem: { findUnique: vi.fn(async () => ({ id: "wi-1", projectId: "p-1" })) },
    };
    const seam = createTransactionSeam({ client: () => tx });
    const withTransaction = {
      ...prisma,
      $transaction: (fn: (t: typeof tx) => Promise<unknown>, options?: unknown) =>
        seam.$transaction(async (transaction) => {
          const result = await fn(transaction as typeof tx);
          // The seam commits only after this callback returns; deletion must
          // not wake the consumer while its tombstone is still uncommitted.
          expect(nudgeOutbox).not.toHaveBeenCalled();
          return result;
        }, options),
    };

    await deleteWorkItem(withTransaction as never, "actor-1", "wi-1");

    expectAllTransactionsAt(seam, { isolationLevel: "Serializable", timeout: 5_000 });
    expect(tx.pmActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ verb: "deleted", deletedProjectId: "p-1", deletedWorkItemId: "wi-1" }),
    });
    expect(tx.pmWorkItem.delete).toHaveBeenCalledWith({ where: { id: "wi-1" } });
    expect(nudgeOutbox).toHaveBeenCalledTimes(1);
  });
});


describe("imported activity in the shared bulk mapper", () => {
  it("keeps historical rows out of notification delivery for both insert shapes", async () => {
    const create = vi.fn(async () => ({}));
    const createMany = vi.fn(async () => ({ count: 2 }));
    const db = { pmActivity: { create, createMany } };
    const history = {
      workItemId: "imported-item", actorId: "importer", verb: "created" as const,
      field: "import", newValue: "CSV:job-1", notifyStatus: "not_needed" as const,
      nudge: false,
    };
    await writeActivity(db as never, history);
    await writeActivity(db as never, [history, {
      workItemId: "regular-item", actorId: "owner", verb: "updated", nudge: false,
    }]);
    expect(create.mock.calls[0]).toEqual([{ data: expect.objectContaining({
      notifyStatus: "not_needed", field: "import", newValue: "CSV:job-1",
    }) }]);
    expect(createMany.mock.calls[0]).toEqual([{ data: [
      expect.objectContaining({ notifyStatus: "not_needed", field: "import" }),
      expect.not.objectContaining({ notifyStatus: expect.anything() }),
    ] }]);
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });
});
