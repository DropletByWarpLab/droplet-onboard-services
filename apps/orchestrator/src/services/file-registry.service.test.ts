/**
 * WARP-3425 — the File registry is reconciled against Nextcloud.
 *
 * On the test box the registry held 33 Workspace rows whose files Nextcloud no
 * longer had (0 of their ids in oc_filecache): rows are written on upload and
 * nothing ever updated them. `reconcileFileRegistry` marks such rows `missing`.
 * The rule these tests pin: it acts only on ids ABSENT from a SUCCESSFUL
 * Nextcloud read, and a failed read changes nothing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  reconcileFileRegistry,
  REGISTRY_SWEEP_BATCH,
  __resetRegistryCursorForTests,
} from "./file-registry.service.js";

type Row = { id: string; ncFileId: number; status: "live" | "missing" };

function stub(pages: Row[][]) {
  const findMany = vi.fn();
  for (const p of pages) findMany.mockResolvedValueOnce(p);
  findMany.mockResolvedValue([]);
  const updateMany = vi.fn(async (args: { where: { ncFileId: { in: number[] } } }) => ({
    count: args.where.ncFileId.in.length,
  }));
  const chunkDelete = vi.fn(async () => ({ count: 4 }));
  const statusDelete = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    file: { findMany, updateMany },
    fileContentChunk: { deleteMany: chunkDelete },
    fileIndexStatus: { deleteMany: statusDelete },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { prisma: prisma as unknown as PrismaClient, findMany, updateMany, chunkDelete, statusDelete, tx: prisma.$transaction };
}

const present = (...ids: number[]) => vi.fn(async () => new Set(ids));

beforeEach(() => __resetRegistryCursorForTests());

describe("reconcileFileRegistry (WARP-3425)", () => {
  it("a failed Nextcloud read changes nothing", async () => {
    const s = stub([[{ id: "a", ncFileId: 2371, status: "live" }]]);
    const down = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(reconcileFileRegistry(s.prisma, down)).rejects.toThrow("ECONNREFUSED");
    expect(s.tx).not.toHaveBeenCalled();
    expect(s.updateMany).not.toHaveBeenCalled();
    expect(s.chunkDelete).not.toHaveBeenCalled();
    expect(s.statusDelete).not.toHaveBeenCalled();
  });

  it("marks only the ids absent from a successful read, and drops their search index", async () => {
    const s = stub([
      [
        { id: "a", ncFileId: 10, status: "live" },
        { id: "b", ncFileId: 2371, status: "live" },
      ],
    ]);
    const check = present(10);
    const r = await reconcileFileRegistry(s.prisma, check);

    expect(check).toHaveBeenCalledWith([10, 2371]);
    expect(s.updateMany).toHaveBeenCalledWith({
      where: { ncFileId: { in: [2371] }, status: "live" },
      data: { status: "missing" },
    });
    // Brain-memory chunks carry synthetic ids; only watcher chunks go.
    expect(s.chunkDelete).toHaveBeenCalledWith({ where: { ncFileId: { in: [2371] }, source: "nextcloud" } });
    expect(s.statusDelete).toHaveBeenCalledWith({ where: { ncFileId: { in: [2371] } } });
    expect(r).toMatchObject({ checked: 2, markedMissing: 1, restored: 0, chunksDeleted: 4, statusRowsDeleted: 1 });
  });

  it("a missing row whose id is back in Nextcloud (a restore) is live again", async () => {
    const s = stub([[{ id: "a", ncFileId: 77, status: "missing" }]]);
    const r = await reconcileFileRegistry(s.prisma, present(77));
    expect(s.updateMany).toHaveBeenCalledWith({
      where: { ncFileId: { in: [77] }, status: "missing" },
      data: { status: "live" },
    });
    expect(r).toMatchObject({ markedMissing: 0, restored: 1 });
  });

  it("writes nothing when every row already matches Nextcloud", async () => {
    const s = stub([
      [
        { id: "a", ncFileId: 1, status: "live" },
        { id: "b", ncFileId: 2, status: "missing" },
      ],
    ]);
    const r = await reconcileFileRegistry(s.prisma, present(1));
    expect(s.tx).not.toHaveBeenCalled();
    expect(r.checked).toBe(2);
  });

  it("an empty registry never queries Nextcloud", async () => {
    const s = stub([]);
    const check = present();
    await reconcileFileRegistry(s.prisma, check);
    expect(check).not.toHaveBeenCalled();
  });

  it("walks the table in bounded pages, resumes after a full page, starts over after a short one", async () => {
    const full: Row[] = Array.from({ length: REGISTRY_SWEEP_BATCH }, (_, i) => ({
      id: `id-${String(i).padStart(4, "0")}`,
      ncFileId: i + 1,
      status: "live",
    }));
    const s = stub([full, [{ id: "zz", ncFileId: 9999, status: "live" }]]);
    const all = vi.fn(async (ids: number[]) => new Set(ids));

    await reconcileFileRegistry(s.prisma, all);
    await reconcileFileRegistry(s.prisma, all);
    await reconcileFileRegistry(s.prisma, all);

    const wheres = s.findMany.mock.calls.map((c) => (c[0] as { where: unknown; take: number }).where);
    expect(s.findMany.mock.calls[0]![0]).toMatchObject({ take: REGISTRY_SWEEP_BATCH, orderBy: { id: "asc" } });
    expect(wheres).toEqual([{}, { id: { gt: full[full.length - 1]!.id } }, {}]);
  });

  it("a failed read does not move the cursor past the rows it could not check", async () => {
    const full: Row[] = Array.from({ length: REGISTRY_SWEEP_BATCH }, (_, i) => ({
      id: `id-${String(i).padStart(4, "0")}`,
      ncFileId: i + 1,
      status: "live",
    }));
    const page2: Row[] = [{ id: "zz", ncFileId: 9999, status: "live" }];
    const s = stub([full, page2, page2]);
    const all = vi.fn(async (ids: number[]) => new Set(ids));

    await reconcileFileRegistry(s.prisma, all);
    await expect(
      reconcileFileRegistry(s.prisma, async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow();
    await reconcileFileRegistry(s.prisma, all);

    const wheres = s.findMany.mock.calls.map((c) => (c[0] as { where: unknown }).where);
    const resume = { id: { gt: full[full.length - 1]!.id } };
    expect(wheres).toEqual([{}, resume, resume]);
  });
});
