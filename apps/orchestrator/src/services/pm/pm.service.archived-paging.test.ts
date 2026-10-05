import { describe, expect, it, vi } from "vitest";
import { listWorkItems } from "./pm.service.js";
import { encodeCursor, ORDER_ARCHIVED, ORDER_BOARD } from "./pm-paging.js";

function fixture() {
  const project = vi.fn(async () => ({ id: "p1", identifier: "P", kind: "PROJECT" }));
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  return { project, findMany, count, db: { pmProject: { findUnique: project }, pmWorkItem: { findMany, count } } as never };
}

describe("archived keyset contract", () => {
  it("refuses live-board cursors and malformed archive instants before any database read", async () => {
    const f = fixture();
    for (const cursor of [
      encodeCursor(ORDER_BOARD, 0, "w1"),
      encodeCursor(ORDER_ARCHIVED, 0.5, "w1"),
      encodeCursor(ORDER_ARCHIVED, Number.MAX_SAFE_INTEGER, "w1"),
    ]) {
      await expect(listWorkItems(f.db, "p1", { archived: "only", cursor })).rejects.toThrow("invalid_cursor");
    }
    expect(f.project).not.toHaveBeenCalled();
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it("preserves the legacy missing-instant tail and counts the full archive set", async () => {
    const f = fixture();
    const cursor = encodeCursor(ORDER_ARCHIVED, Number.MIN_SAFE_INTEGER, "w-old");
    await listWorkItems(f.db, "p1", { archived: "only", cursor, limit: 1 });
    expect(f.count).toHaveBeenCalledWith({ where: { projectId: "p1", isArchived: true } });
    expect(f.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: "p1", isArchived: true, AND: [{ archivedAt: null, id: { gt: "w-old" } }] },
      orderBy: [{ archivedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      take: 2,
    }));
  });
});
