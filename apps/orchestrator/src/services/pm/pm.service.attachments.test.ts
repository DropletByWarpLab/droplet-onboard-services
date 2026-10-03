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
 *   - for an item, the read is INSIDE the SERIALIZABLE transaction;
 *   - a blob that will not unlink never turns a committed delete into an error.
 *
 * The same behaviour against a real Postgres and real files is in
 * __tests__/pm-attachment.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const removeAttachmentBlobs = vi.fn();
vi.mock("./pm-attachment-storage.js", () => ({
  removeAttachmentBlobs: (...args: unknown[]) => removeAttachmentBlobs(...args),
}));

import { deleteProject, deleteWorkItem } from "./pm.service.js";
import { SERIALIZABLE_TX } from "../../lib/prisma-tx.js";
import {
  createTransactionSeam,
  expectAllTransactionsAt,
} from "../../__tests__/helpers/prisma-tx-harness.js";

type Row = Record<string, unknown>;

beforeEach(() => {
  removeAttachmentBlobs.mockReset();
  removeAttachmentBlobs.mockResolvedValue({ removed: 0, failed: 0 });
});

describe("deleteWorkItem unlinks the item's attachment files (WARP-1505)", () => {
  function setup(opts: { keys?: string[]; deleteError?: unknown; order?: string[] } = {}) {
    const order = opts.order ?? [];
    const tx = {
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
    const seam = createTransactionSeam({ client: () => tx });
    removeAttachmentBlobs.mockImplementation(async () => {
      order.push("unlink");
      return { removed: 0, failed: 0 };
    });
    const prisma = { pmWorkItem: { findUnique: async () => ({ id: "wi-1" }) }, $transaction: seam.$transaction } as never;
    return { prisma, seam, order };
  }

  it("reads the keys inside the SERIALIZABLE transaction and unlinks them after the delete", async () => {
    const { prisma, seam, order } = setup({ keys: ["k1", "k2"] });
    await deleteWorkItem(prisma, "actor-1", "wi-1");

    expect(order).toEqual(["read-keys", "delete", "unlink"]);
    expect(removeAttachmentBlobs).toHaveBeenCalledTimes(1);
    expect(removeAttachmentBlobs).toHaveBeenCalledWith(["k1", "k2"]);
    // An upload committing between the key read and the delete must abort the
    // delete, not slip through the cascade with its blob forgotten.
    expectAllTransactionsAt(seam, SERIALIZABLE_TX);
  });

  it("does not unlink anything when the delete fails", async () => {
    const lost = Object.assign(new Error("gone"), { code: "P2025" });
    const { prisma } = setup({ keys: ["k1"], deleteError: lost });
    await expect(deleteWorkItem(prisma, null, "wi-1")).rejects.toThrow("work_item_not_found");
    expect(removeAttachmentBlobs).not.toHaveBeenCalled();
  });

  it("does not unlink anything when the SERIALIZABLE loser aborts", async () => {
    const { prisma } = setup({ keys: ["k1"], deleteError: Object.assign(new Error("ssi"), { code: "P2034" }) });
    await expect(deleteWorkItem(prisma, null, "wi-1")).rejects.toThrow("concurrent_mutation");
    expect(removeAttachmentBlobs).not.toHaveBeenCalled();
  });

  it("an item with no attachments unlinks an empty set (and so does nothing)", async () => {
    const { prisma } = setup({ keys: [] });
    await deleteWorkItem(prisma, null, "wi-1");
    expect(removeAttachmentBlobs).toHaveBeenCalledWith([]);
  });
});

describe("deleteProject unlinks every attachment file under the project (WARP-1505)", () => {
  function setup(opts: { keys?: string[]; deleteError?: unknown; order?: string[] } = {}) {
    const order = opts.order ?? [];
    const prisma = {
      pmProject: {
        findUnique: async () => ({ id: "p-1" }),
        delete: async () => {
          order.push("delete");
          if (opts.deleteError) throw opts.deleteError;
          return {};
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
    } as never;
    removeAttachmentBlobs.mockImplementation(async () => {
      order.push("unlink");
      return { removed: 0, failed: 0 };
    });
    return { prisma, order };
  }

  it("reads the keys before the delete and unlinks them after it", async () => {
    const { prisma, order } = setup({ keys: ["k1", "k2", "k3"] });
    await deleteProject(prisma, "p-1");
    expect(order).toEqual(["read-keys", "delete", "unlink"]);
    expect(removeAttachmentBlobs).toHaveBeenCalledWith(["k1", "k2", "k3"]);
  });

  it("does not unlink anything when the delete fails", async () => {
    const { prisma } = setup({ keys: ["k1"], deleteError: new Error("boom") });
    await expect(deleteProject(prisma, "p-1")).rejects.toThrow("boom");
    expect(removeAttachmentBlobs).not.toHaveBeenCalled();
  });

  it("does not unlink anything when the project was already deleted by someone else", async () => {
    const { prisma } = setup({ keys: ["k1"], deleteError: Object.assign(new Error("gone"), { code: "P2025" }) });
    await expect(deleteProject(prisma, "p-1")).rejects.toThrow("project_not_found");
    expect(removeAttachmentBlobs).not.toHaveBeenCalled();
  });
});
