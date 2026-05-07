/**
 * file-search.service unit tests.
 *
 * The service is the single source of truth for the LLM-tool path
 * (`search_content` MCP tool — once it migrates to this module) AND
 * the dashboard `/knowledge` API (WARP-204). Tests use a `$queryRawUnsafe`
 * mock and assert SQL-binding correctness — actual pgvector behavior
 * is exercised by `tests/rag-search.integration.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { searchByVector, listRecent } from "../services/file-search.service.js";

function buildFakePrisma(rowsByCall: unknown[][]): PrismaClient {
  const queryFn = vi.fn();
  for (const rows of rowsByCall) queryFn.mockResolvedValueOnce(rows);
  return { $queryRawUnsafe: queryFn } as unknown as PrismaClient;
}

describe("searchByVector", () => {
  it("filters by userId and applies the score threshold", async () => {
    const prisma = buildFakePrisma([
      [
        { source: "nextcloud", path: "/a.pdf", chunkIdx: 0, pageNumber: null, brainItemId: null, score: 0.81, snippet: "hello" },
        { source: "nextcloud", path: "/b.pdf", chunkIdx: 0, pageNumber: null, brainItemId: null, score: 0.10, snippet: "noise" },
      ],
    ]);
    const hits = await searchByVector(prisma, {
      userId: "u1",
      vector: [0.1, 0.2],
      limit: 10,
      minSimilarity: 0.25,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("nextcloud");
    expect(hits[0].path).toBe("/a.pdf");

    const calls = (prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    // userId must be a parameter (not interpolated) so SQL injection
    // through a username (Nextcloud-controlled string) cannot escape.
    expect(calls[0]).toContain("u1");
  });

  it("forwards the optional source filter as a parameter", async () => {
    const prisma = buildFakePrisma([[]]);
    await searchByVector(prisma, {
      userId: "u1",
      vector: [0.1],
      limit: 5,
      minSimilarity: 0.25,
      source: "brain",
    });
    const [, ...params] = (prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(params).toContain("brain");
  });

  it("forwards the optional `since` filter", async () => {
    const since = new Date("2026-04-01T00:00:00Z");
    const prisma = buildFakePrisma([[]]);
    await searchByVector(prisma, {
      userId: "u1",
      vector: [0.1],
      limit: 5,
      minSimilarity: 0.25,
      since,
    });
    const [, ...params] = (prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(params).toContain(since);
  });

  it("isolates per-user — userId binding is the actual filter", async () => {
    const prisma = buildFakePrisma([[]]);
    await searchByVector(prisma, {
      userId: "userB",
      vector: [0.1],
      limit: 5,
      minSimilarity: 0.25,
    });
    const [sql, ...params] = (prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    // Must reference the userId column AND pass userB as a bound parameter.
    expect(sql).toMatch(/"userId"\s*=\s*\$/);
    expect(params).toContain("userB");
    // Must NOT contain other userIds — single-tenant isolation guarantee.
    expect(params).not.toContain("u1");
  });

  it("returns [] for an empty result set without throwing", async () => {
    const prisma = buildFakePrisma([[]]);
    const hits = await searchByVector(prisma, {
      userId: "u1",
      vector: [0.1, 0.2, 0.3],
      limit: 10,
      minSimilarity: 0.25,
    });
    expect(hits).toEqual([]);
  });
});

describe("listRecent", () => {
  it("groups by file and sorts by indexedAt desc", async () => {
    const prisma = buildFakePrisma([
      [
        { source: "brain", path: "/b.png", indexedAt: new Date("2026-04-25"), brainItemId: "i1", snippet: "img" },
        { source: "nextcloud", path: "/a.pdf", indexedAt: new Date("2026-04-26"), brainItemId: null, snippet: "doc" },
      ],
    ]);
    const recent = await listRecent(prisma, { userId: "u1", limit: 50 });
    expect(recent).toHaveLength(2);
    expect(recent[0].path).toBe("/a.pdf"); // newest first
    expect(recent[1].path).toBe("/b.png");
  });

  it("forwards the optional `before` cursor and `source` filter", async () => {
    const before = new Date("2026-04-25T00:00:00Z");
    const prisma = buildFakePrisma([[]]);
    await listRecent(prisma, { userId: "u1", limit: 25, before, source: "brain" });
    const [, ...params] = (prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(params).toContain(before);
    expect(params).toContain("brain");
  });

  it("isolates per-user (userId is a parameter, not string-interpolated)", async () => {
    const prisma = buildFakePrisma([[]]);
    await listRecent(prisma, { userId: "userB", limit: 50 });
    const [sql, ...params] = (prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toMatch(/"userId"\s*=\s*\$/);
    expect(params).toContain("userB");
    expect(params).not.toContain("u1");
  });
});
