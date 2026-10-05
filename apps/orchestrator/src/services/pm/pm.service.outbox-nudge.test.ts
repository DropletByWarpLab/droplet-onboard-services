/**
 * Shared PmActivity writers wake the outbox without moving audit rows outside
 * their transaction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./pm-outbox.js", () => ({ nudgeOutbox: vi.fn() }));

import { nudgeOutbox } from "./pm-outbox.js";
import { addComment, deleteWorkItem } from "./pm.service.js";
import { createTransactionSeam } from "../../__tests__/helpers/prisma-tx-harness.js";

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
    pmWorkItemRelation: {
      findMany: vi.fn(async () => [{ fromId: "wi-1", toId: "wi-2", kind: "RELATES" }]),
    },
    pmActivity: { createMany: vi.fn(async () => ({ count: 1 })) },
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
    pmWorkItem: { findUnique: vi.fn(async () => ({ id: "wi-1", project: { kind: "PROJECT" } })) },
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
    expect(h.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
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
