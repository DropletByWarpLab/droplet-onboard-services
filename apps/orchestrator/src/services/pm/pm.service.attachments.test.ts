/**
 * WARP-1505 — deleting a work item or a project removes its files.
 *
 * The database cascade drops every PmAttachment ROW under the thing being
 * deleted; the bytes are files on a volume the database cannot reach. So
 * `deleteWorkItem` / `deleteProject` read the storage keys first and unlink the
 * blobs after the delete commits. What is pinned here:
 *
 *   - the keys read are the right ones (the item's, the project's);
 *   - the unlink happens only AFTER a successful delete — a delete that fails
 *     (race, serialization loser, anything) must not have destroyed the files;
 *   - for an item AND for a project, the read is INSIDE a SERIALIZABLE
 *     transaction, and its loser is `concurrent_mutation`, never a lost blob;
 *   - a blob that will not unlink never turns a committed delete into an error.
 *
 * The same behaviour against a real Postgres and real files is in
 * __tests__/pm-attachment.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const removeAttachmentBlobs = vi.fn();
vi.mock("./pm-attachment-storage.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./pm-attachment-storage.js")>(),
  removeAttachmentBlobs: (...args: unknown[]) => removeAttachmentBlobs(...args),
}));

import { deleteProject, deleteWorkItem } from "./pm.service.js";
import { SERIALIZABLE_TX } from "../../lib/prisma-tx.js";
import {
  createTransactionSeam,
  expectAllTransactionsAt,
} from "../../__tests__/helpers/prisma-tx-harness.js";

type Row = Record<string, unknown>;
const K1 = "11111111-1111-4111-8111-111111111111";
const K2 = "22222222-2222-4222-8222-222222222222";
const K3 = "33333333-3333-4333-8333-333333333333";

function cleanupFlags(order: string[]) {
  const flags = new Map<string, Row>();
  const systemFlag = {
    createMany: async ({ data }: { data: Array<{ key: string; valueJson: Row }> }) => {
      order.push("queue");
      for (const row of data) flags.set(row.key, row);
      return { count: data.length };
    },
    findUnique: async ({ where }: { where: { key: string } }) => flags.get(where.key) ?? null,
    deleteMany: async ({ where }: { where: { key: string } }) => ({ count: Number(flags.delete(where.key)) }),
  };
  return { flags, systemFlag };
}

beforeEach(() => {
  removeAttachmentBlobs.mockReset();
  removeAttachmentBlobs.mockResolvedValue({ removed: 0, failed: 0 });
});

describe("deleteWorkItem unlinks the item's attachment files (WARP-1505)", () => {
  function setup(opts: { keys?: string[]; deleteError?: unknown; order?: string[] } = {}) {
    const order = opts.order ?? [];
    const { flags, systemFlag } = cleanupFlags(order);
    const tx = {
      systemFlag,
      pmWorkItem: {
        findMany: async () => [],
        delete: async () => {
          order.push("delete");
          if (opts.deleteError) throw opts.deleteError;
          return {};
        },
      },
      pmActivity: { create: async () => ({}), createMany: async () => ({ count: 0 }) },
      pmWorkItemRelation: { findMany: async () => [] },
      pmAttachment: {
        findMany: async ({ where, select }: { where: Row; select: Row }) => {
          order.push("read-keys");
          expect(where).toEqual({ workItemId: "wi-1" });
          expect(select).toEqual({ storageKey: true });
          return (opts.keys ?? []).map((storageKey) => ({ storageKey }));
        },
      },
    };
    const seam = createTransactionSeam({ client: () => tx, stores: { flags } });
    removeAttachmentBlobs.mockImplementation(async () => {
      order.push("unlink");
      return { removed: 0, failed: 0 };
    });
    const prisma = { systemFlag, pmWorkItem: { findUnique: async () => ({ id: "wi-1" }) }, $transaction: seam.$transaction } as never;
    return { prisma, seam, order, flags };
  }

  it("reads the keys inside the SERIALIZABLE transaction and unlinks them after the delete", async () => {
    const { prisma, seam, order, flags } = setup({ keys: [K1, K2] });
    await deleteWorkItem(prisma, "actor-1", "wi-1");

    expect(order).toEqual(["read-keys", "queue", "delete", "unlink", "unlink"]);
    expect(removeAttachmentBlobs).toHaveBeenCalledTimes(2);
    expect(removeAttachmentBlobs).toHaveBeenNthCalledWith(1, [K1], expect.any(String));
    expect(removeAttachmentBlobs).toHaveBeenNthCalledWith(2, [K2], expect.any(String));
    expect(flags.size).toBe(0);
    // An upload committing between the key read and the delete must abort the
    // delete, not slip through the cascade with its blob forgotten.
    expectAllTransactionsAt(seam, SERIALIZABLE_TX);
  });

  it("does not unlink anything when the delete fails", async () => {
    const lost = Object.assign(new Error("gone"), { code: "P2025" });
    const { prisma, flags } = setup({ keys: [K1], deleteError: lost });
    await expect(deleteWorkItem(prisma, null, "wi-1")).rejects.toThrow("work_item_not_found");
    expect(removeAttachmentBlobs).not.toHaveBeenCalled();
    expect(flags.size).toBe(0);
  });

  it("does not unlink anything when the SERIALIZABLE loser aborts", async () => {
    const { prisma, flags } = setup({ keys: [K1], deleteError: Object.assign(new Error("ssi"), { code: "P2034" }) });
    await expect(deleteWorkItem(prisma, null, "wi-1")).rejects.toThrow("concurrent_mutation");
    expect(removeAttachmentBlobs).not.toHaveBeenCalled();
    expect(flags.size).toBe(0);
  });

  it("an item with no attachments creates no cleanup intent and unlinks nothing", async () => {
    const { prisma, flags } = setup({ keys: [] });
    await deleteWorkItem(prisma, null, "wi-1");
    expect(removeAttachmentBlobs).not.toHaveBeenCalled();
    expect(flags.size).toBe(0);
  });

  it("a failed unlink keeps its intent without turning a committed delete into an error", async () => {
    const { prisma, flags } = setup({ keys: [K1] });
    removeAttachmentBlobs.mockResolvedValue({ removed: 0, failed: 1 });
    await expect(deleteWorkItem(prisma, null, "wi-1")).resolves.toBeUndefined();
    expect([...flags.values()]).toEqual([{ key: `pm-attachments:cleanup:${K1}`, valueJson: { storageKey: K1 } }]);
  });
});

describe("deleteProject unlinks every attachment file under the project (WARP-1505)", () => {
  function setup(opts: { keys?: string[]; deleteError?: unknown; auditError?: unknown; restored?: boolean; order?: string[] } = {}) {
    const order = opts.order ?? [];
    const { flags, systemFlag } = cleanupFlags(order);
    const tx = {
      systemFlag,
      pmWorkItem: { count: async () => 2 },
      pmProject: {
        deleteMany: async ({ where }: { where: Row }) => {
          expect(where).toEqual({ id: "p-1", kind: "PROJECT", isArchived: true });
          order.push("delete");
          if (opts.deleteError) throw opts.deleteError;
          return { count: opts.restored ? 0 : 1 };
        },
      },
      pmAttachment: {
        findMany: async ({ where, select }: { where: Row; select: Row }) => {
          order.push("read-keys");
          // every attachment of every work item in the project — comments' included
          expect(where).toEqual({ workItem: { projectId: "p-1" } });
          expect(select).toEqual({ storageKey: true });
          return (opts.keys ?? []).map((storageKey) => ({ storageKey }));
        },
      },
    };
    const seam = createTransactionSeam({ client: () => tx, stores: { flags } });
    const prisma = { systemFlag, pmProject: { findUnique: async () => ({ id: "p-1", identifier: "ONE", name: "One", kind: "PROJECT", isArchived: true }) }, $transaction: seam.$transaction } as never;
    const deletion = {
      confirmIdentifier: "ONE",
      audit: vi.fn(async (_tx: unknown, deleted: unknown) => {
        expect(deleted).toEqual({ id: "p-1", identifier: "ONE", name: "One", workItemCount: 2 });
        order.push("audit");
        if (opts.auditError) throw opts.auditError;
      }),
    };
    removeAttachmentBlobs.mockImplementation(async () => {
      order.push("unlink");
      return { removed: 0, failed: 0 };
    });
    return { prisma, seam, order, flags, deletion };
  }

  it("reads the keys inside a SERIALIZABLE transaction and unlinks them after the delete", async () => {
    const { prisma, seam, order, flags, deletion } = setup({ keys: [K1, K2, K3] });
    await deleteProject(prisma, "p-1", deletion);
    expect(order).toEqual(["read-keys", "queue", "delete", "audit", "unlink", "unlink", "unlink"]);
    expect(removeAttachmentBlobs).toHaveBeenCalledTimes(3);
    for (const key of [K1, K2, K3]) expect(removeAttachmentBlobs).toHaveBeenCalledWith([key], expect.any(String));
    expect(flags.size).toBe(0);
    // An upload committing between the key read and the delete must abort the
    // delete (review probe C: it used to be cascaded with its blob left on disk).
    expectAllTransactionsAt(seam, { ...SERIALIZABLE_TX, timeout: 60_000 });
  });

  it("the SERIALIZABLE loser is concurrent_mutation, and nothing is unlinked", async () => {
    const { prisma, flags, deletion } = setup({ keys: [K1], deleteError: Object.assign(new Error("ssi"), { code: "P2034" }) });
    await expect(deleteProject(prisma, "p-1", deletion)).rejects.toThrow("concurrent_mutation");
    expect(removeAttachmentBlobs).not.toHaveBeenCalled();
    expect(flags.size).toBe(0);
  });

  it("does not unlink anything when the delete fails", async () => {
    const { prisma, flags, deletion } = setup({ keys: [K1], deleteError: new Error("boom") });
    await expect(deleteProject(prisma, "p-1", deletion)).rejects.toThrow("boom");
    expect(removeAttachmentBlobs).not.toHaveBeenCalled();
    expect(flags.size).toBe(0);
  });

  it("does not unlink anything when the project was already deleted by someone else", async () => {
    const { prisma, flags, deletion } = setup({ keys: [K1], deleteError: Object.assign(new Error("gone"), { code: "P2025" }) });
    await expect(deleteProject(prisma, "p-1", deletion)).rejects.toThrow("project_not_found");
    expect(removeAttachmentBlobs).not.toHaveBeenCalled();
    expect(flags.size).toBe(0);
  });

  it("bounds work in the delete request and leaves excess cleanup intents for the sweep", async () => {
    const keys = Array.from({ length: 201 }, () => randomUUID());
    const { prisma, flags, deletion } = setup({ keys });
    await deleteProject(prisma, "p-1", deletion);
    expect(removeAttachmentBlobs).toHaveBeenCalledTimes(200);
    expect([...flags.values()]).toEqual([{ key: `pm-attachments:cleanup:${keys[200]}`, valueJson: { storageKey: keys[200] } }]);
  });

  it("rolls back cleanup intent and leaves bytes alone when the required audit fails", async () => {
    const { prisma, flags, deletion } = setup({ keys: [K1], auditError: new Error("audit failed") });
    await expect(deleteProject(prisma, "p-1", deletion)).rejects.toThrow("audit failed");
    expect(removeAttachmentBlobs).not.toHaveBeenCalled();
    expect(flags.size).toBe(0);
  });

  it("rolls back cleanup intent when a restore wins the archived-delete compare-and-set", async () => {
    const { prisma, flags, deletion } = setup({ keys: [K1], restored: true });
    await expect(deleteProject(prisma, "p-1", deletion)).rejects.toThrow("project_not_archived");
    expect(deletion.audit).not.toHaveBeenCalled();
    expect(removeAttachmentBlobs).not.toHaveBeenCalled();
    expect(flags.size).toBe(0);
  });
});
