/**
 * WARP-3532 — `writeActivity` is the choke point every PM mutation goes through
 * (ADR-069 §7), and the one place the outbox consumers are woken.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./pm-outbox.js", () => ({ nudgeOutbox: vi.fn() }));

import { nudgeOutbox } from "./pm-outbox.js";
import { addComment, writeActivity } from "./pm.service.js";
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
