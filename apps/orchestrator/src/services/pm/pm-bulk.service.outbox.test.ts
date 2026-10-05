import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTransactionSeam } from "../../__tests__/helpers/prisma-tx-harness.js";

vi.mock("./pm-outbox.js", () => ({ nudgeOutbox: vi.fn() }));

import { nudgeOutbox } from "./pm-outbox.js";
import { bulkUpdateWorkItems } from "./pm-bulk.service.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");

function fixture(priority: "none" | "high", rejectCommit = false) {
  const rows = ["a", "b"].map((id, index) => ({
    id, projectId: "p1", sequenceId: index + 1, name: id, descriptionHtml: "",
    stateId: "todo", state: null, priority, cycleId: null, parentId: null,
    department: null, isArchived: false, assignees: [], labels: [],
    startDate: null, dueDate: null, sortOrder: index, completedAt: null,
    createdById: "owner", createdAt: NOW, updatedAt: NOW,
    _count: { comments: 0, children: 0 }, project: { identifier: "TEST", department: null },
  }));
  const activity: unknown[] = [];
  const tx = {
    pmWorkItem: {
      findMany: vi.fn(async () => rows),
      updateMany: vi.fn(async ({ data }: { data: { priority: "high" } }) => {
        for (const row of rows) row.priority = data.priority;
        return { count: rows.length };
      }),
    },
    pmActivity: {
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
        activity.push(...data);
        return { count: data.length };
      }),
    },
  };
  const seam = createTransactionSeam({ client: () => tx, stores: { rows, activity } });
  const $transaction = vi.fn(async (...[callback, options]: Parameters<typeof seam.$transaction>) =>
    seam.$transaction(async (client) => {
      const result = await callback(client);
      // The last row has been written, but commit can still reject the transaction.
      expect(nudgeOutbox).not.toHaveBeenCalled();
      if (rejectCommit) throw new Error("commit failed");
      return result;
    }, options),
  );
  return { prisma: { $transaction }, tx, rows, activity };
}

beforeEach(() => vi.clearAllMocks());

describe("bulk activity wakes the shared outbox after commit", () => {
  it("wakes once after a batch commits, with all its activity rows", async () => {
    const f = fixture("none");
    const result = await bulkUpdateWorkItems(f.prisma as never, { userId: "owner", role: "owner" }, {
      ids: ["a", "b"], patch: { priority: "high" },
    }, NOW);
    expect(result.changed).toBe(2);
    expect(f.activity).toHaveLength(2);
    expect(nudgeOutbox).toHaveBeenCalledTimes(1);
  });

  it("does not wake for a batch whose values already match", async () => {
    const f = fixture("high");
    const result = await bulkUpdateWorkItems(f.prisma as never, { userId: "owner", role: "owner" }, {
      ids: ["a", "b"], patch: { priority: "high" },
    }, NOW);
    expect(result.changed).toBe(0);
    expect(f.activity).toHaveLength(0);
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });

  it("does not wake when commit rolls back the items and activity", async () => {
    const f = fixture("none", true);
    await expect(bulkUpdateWorkItems(f.prisma as never, { userId: "owner", role: "owner" }, {
      ids: ["a", "b"], patch: { priority: "high" },
    }, NOW)).rejects.toThrow("commit failed");
    expect(f.rows.map((row) => row.priority)).toEqual(["none", "none"]);
    expect(f.activity).toHaveLength(0);
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });

  it("does not wake when writing the activity fails", async () => {
    const f = fixture("none");
    f.tx.pmActivity.createMany.mockRejectedValueOnce(new Error("activity failed"));
    await expect(bulkUpdateWorkItems(f.prisma as never, { userId: "owner", role: "owner" }, {
      ids: ["a", "b"], patch: { priority: "high" },
    }, NOW)).rejects.toThrow("activity failed");
    expect(f.rows.map((row) => row.priority)).toEqual(["none", "none"]);
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });
});
