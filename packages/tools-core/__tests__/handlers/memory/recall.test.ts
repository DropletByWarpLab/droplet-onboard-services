import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import memoryRecall from "../../../src/handlers/memory/recall.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(findMany: Mock): ToolContext {
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

  it("OR-matches query terms, defaults limit 10 (WARP-1335)", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "f", category: "Tone", fact: "x", addedBy: "a", addedAt: new Date() }]);
    await memoryRecall.handler({ query: "warm tone" }, ctxWith(findMany));
    expect(findMany).toHaveBeenCalledWith({
      where: {
        active: true,
        // WARP-845 — no role on the ctx → most-restrictive guest view.
        audience: { in: ["guest"] },
        OR: [
          { fact: { contains: "warm", mode: "insensitive" } },
          { fact: { contains: "tone", mode: "insensitive" } },
        ],
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
    const findMany = vi.fn().mockResolvedValue([{ id: "f", category: "Workflow", fact: "x", addedBy: "a", addedAt: new Date() }]);
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

  it("accepts the WARP-1120 Business category (D-9)", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "f", category: "Business", fact: "invoices", addedBy: "a", addedAt: new Date() }]);
    await memoryRecall.handler(
      { query: "invoices", category: "Business" },
      ctxWith(findMany),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ category: "Business" }),
      }),
    );
  });

  it("ignores an unknown category", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "f", category: "Tone", fact: "x", addedBy: "a", addedAt: new Date() }]);
    await memoryRecall.handler(
      { query: "x", category: "BogusBucket" },
      ctxWith(findMany),
    );
    const call = findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(call.where).not.toHaveProperty("category");
  });

  it("clamps limit to 50", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "f", category: "Tone", fact: "x", addedBy: "a", addedAt: new Date() }]);
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

  // ── WARP-1335: recall missed facts whose TEXT doesn't contain the query
  // keyword. C02: "accountant" never matched the stored fact "Sophie
  // Bergerac at Cabinet Arnaud will take over URSSAF declarations". Memory
  // is a small curated set, so a keyword miss must fall back to surfacing
  // the recent active facts rather than returning nothing.
  it("falls back to recent facts when the keyword match is empty (WARP-1335)", async () => {
    const at = new Date("2026-07-01T09:00:00Z");
    const stored = { id: "acc", category: "Other", fact: "Sophie Bergerac at Cabinet Arnaud is the accountant, from Q3", addedBy: "alice", addedAt: at };
    // Primary keyword query misses (fact text lacks "accountant" as the model
    // queried it); the broadened fallback returns the curated set.
    const findMany = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([stored]);
    const res = await memoryRecall.handler({ query: "accountant" }, ctxWith(findMany));
    expect(findMany).toHaveBeenCalledTimes(2);
    // The fallback query drops the fact/OR filter — just active + audience.
    const fallbackWhere = (findMany.mock.calls[1]![0] as { where: Record<string, unknown> }).where;
    expect(fallbackWhere).not.toHaveProperty("OR");
    expect(fallbackWhere).not.toHaveProperty("fact");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { facts: { fact: string }[]; broadened?: boolean };
      expect(data.facts[0]!.fact).toContain("Sophie Bergerac");
      expect(data.broadened).toBe(true);
    }
  });

  it("does NOT broaden when the keyword match already found facts (WARP-1335)", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "f1", category: "Tone", fact: "warm", addedBy: "alice", addedAt: new Date() },
    ]);
    const res = await memoryRecall.handler({ query: "warm" }, ctxWith(findMany));
    expect(findMany).toHaveBeenCalledTimes(1);
    if (res.ok) expect((res.data as { broadened?: boolean }).broadened).toBeUndefined();
  });

});
