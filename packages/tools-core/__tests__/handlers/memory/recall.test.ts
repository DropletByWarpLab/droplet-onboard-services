import { describe, it, expect, vi } from "vitest";
import memoryRecall from "../../../src/handlers/memory/recall.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(findMany: ReturnType<typeof vi.fn>): ToolContext {
  return {
    prisma: {
      memoryFact: { findMany },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: "alice",
    signal: new AbortController().signal,
  };
}

describe("memory_recall", () => {
  it("rejects an empty query", async () => {
    const findMany = vi.fn();
    const res = await memoryRecall.handler({ query: "  " }, ctxWith(findMany));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_ARGS");
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it("filters by query substring, defaults limit 10", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await memoryRecall.handler({ query: "tone" }, ctxWith(findMany));
    expect(findMany).toHaveBeenCalledWith({
      where: {
        active: true,
        // WARP-845 — no role on the ctx → most-restrictive guest view.
        audience: { in: ["guest"] },
        fact: { contains: "tone", mode: "insensitive" },
      },
      orderBy: { addedAt: "desc" },
      take: 10,
    });
  });

  it("widens the audience window with the caller's role (WARP-845)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = { ...ctxWith(findMany), role: "family" as const };
    await memoryRecall.handler({ query: "tone" }, ctx);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          audience: { in: ["family", "guest"] },
        }),
      }),
    );

    const findManyOwner = vi.fn().mockResolvedValue([]);
    const ctxOwner = { ...ctxWith(findManyOwner), role: "owner" as const };
    await memoryRecall.handler({ query: "tone" }, ctxOwner);
    expect(findManyOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          audience: { in: ["owner", "admin", "family", "guest"] },
        }),
      }),
    );
  });

  it("applies category filter when valid", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await memoryRecall.handler(
      { query: "x", category: "Workflow" },
      ctxWith(findMany),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ category: "Workflow" }),
      }),
    );
  });

  it("ignores an unknown category", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await memoryRecall.handler(
      { query: "x", category: "BogusBucket" },
      ctxWith(findMany),
    );
    const call = findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(call.where).not.toHaveProperty("category");
  });

  it("clamps limit to 50", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await memoryRecall.handler(
      { query: "x", limit: 9999 },
      ctxWith(findMany),
    );
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
  });

  it("returns shaped fact rows", async () => {
    const at = new Date("2026-05-28T12:00:00Z");
    const findMany = vi.fn().mockResolvedValue([
      { id: "f1", category: "Tone", fact: "Friendly", addedBy: "alice", addedAt: at },
    ]);
    const res = await memoryRecall.handler({ query: "fr" }, ctxWith(findMany));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        facts: [
          {
            id: "f1",
            category: "Tone",
            fact: "Friendly",
            addedBy: "alice",
            addedAt: at.toISOString(),
          },
        ],
      });
    }
  });

  it("is read-only (no write, no confirm)", () => {
    expect(memoryRecall.requiresWrite).toBe(false);
    expect(memoryRecall.requiresConfirmation).toBe(false);
  });
});
