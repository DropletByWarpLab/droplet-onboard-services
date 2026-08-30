/**
 * WARP-1014 — multi-owner (`additionalUserIds`) predicate in the
 * mcp-server's file-search mirror.
 *
 * `search_content` scopes its chunk queries to BOTH post-WARP-493 key
 * shapes (username for nextcloud-watcher rows, User.id UUID for brain
 * rows). These tests pin the SQL predicate: a single owner keeps the
 * historical `"userId" = $1` shape byte-for-byte, extra owners expand to
 * a parameterized IN list, and later bind positions shift accordingly.
 * Mirrors the orchestrator's WARP-1140 predicate
 * (apps/orchestrator/src/services/file-search.service.ts).
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  searchByVector,
  searchByLexical,
  searchHybrid,
} from "../src/file-search.service.js";

const UUID = "6f0f5a3e-2f4b-4a4e-9d7e-0a1b2c3d4e5f";

// WARP-2524: searchByVector's SELECT now runs inside $transaction (SET LOCAL
// hnsw.ef_search needs a transaction scope), so the stub hands the callback a
// tx client whose $queryRawUnsafe is the SAME spy — `raw` sees every SELECT
// from both arms, and the predicate/bind assertions below stay verbatim.
function prismaStub(): { client: PrismaClient; raw: ReturnType<typeof vi.fn> } {
  const raw = vi.fn(async () => [] as unknown[]);
  const client = {
    $queryRawUnsafe: raw,
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRawUnsafe: raw, $executeRawUnsafe: vi.fn(async () => 0) }),
    ),
  } as unknown as PrismaClient;
  return { client, raw };
}

describe("searchByVector multi-owner predicate", () => {
  it("keeps the historical `\"userId\" = $1` shape for a single owner", async () => {
    const { client, raw } = prismaStub();
    await searchByVector(client, {
      userId: "alice",
      vector: [0.1],
      limit: 5,
      minSimilarity: 0.3,
    });
    const [sql, ...params] = raw.mock.calls[0] as [string, ...unknown[]];
    expect(sql).toMatch(/"userId"\s*=\s*\$1/);
    expect(params).toEqual(["alice", 5]);
  });

  it("expands additionalUserIds to a parameterized IN list and shifts later params", async () => {
    const { client, raw } = prismaStub();
    await searchByVector(client, {
      userId: "alice",
      additionalUserIds: [UUID],
      vector: [0.1],
      limit: 5,
      minSimilarity: 0.3,
      source: "brain",
    });
    const [sql, ...params] = raw.mock.calls[0] as [string, ...unknown[]];
    expect(sql).toMatch(/"userId"\s+IN\s+\(\$1,\s*\$2\)/);
    expect(sql).toMatch(/source = \$3::"FileContentSource"/);
    expect(params).toEqual(["alice", UUID, "brain", 5]);
  });
});

describe("searchByLexical multi-owner predicate", () => {
  it("expands additionalUserIds and keeps the tsquery bind position consistent in WHERE and SELECT", async () => {
    const { client, raw } = prismaStub();
    await searchByLexical(client, {
      userId: "alice",
      additionalUserIds: [UUID],
      query: "quarterly report",
      limit: 7,
    });
    const [sql, ...params] = raw.mock.calls[0] as [string, ...unknown[]];
    expect(sql).toMatch(/"userId"\s+IN\s+\(\$1,\s*\$2\)/);
    // The query param moved to $3 — BOTH tsquery references (ranking
    // SELECT + WHERE match) must agree or Postgres ranks against the
    // wrong bind.
    const tsqueryRefs = sql.match(/websearch_to_tsquery\('english', \$3\)/g);
    expect(tsqueryRefs).toHaveLength(2);
    expect(params).toEqual(["alice", UUID, "quarterly report", 7]);
  });

  it("keeps the historical single-owner binding order", async () => {
    const { client, raw } = prismaStub();
    await searchByLexical(client, {
      userId: "alice",
      query: "notes",
      limit: 7,
    });
    const [sql, ...params] = raw.mock.calls[0] as [string, ...unknown[]];
    expect(sql).toMatch(/"userId"\s*=\s*\$1/);
    const tsqueryRefs = sql.match(/websearch_to_tsquery\('english', \$2\)/g);
    expect(tsqueryRefs).toHaveLength(2);
    expect(params).toEqual(["alice", "notes", 7]);
  });
});

describe("searchHybrid multi-owner threading", () => {
  it("threads additionalUserIds into both retrieval arms", async () => {
    const { client, raw } = prismaStub();
    await searchHybrid(client, {
      userId: "alice",
      additionalUserIds: [UUID],
      vector: [0.1, 0.2],
      query: "notes",
    });
    // One vector arm + one lexical arm.
    expect(raw).toHaveBeenCalledTimes(2);
    for (const call of raw.mock.calls as [string, ...unknown[]][]) {
      const [sql, ...params] = call;
      expect(sql).toMatch(/"userId"\s+IN\s+\(\$1,\s*\$2\)/);
      expect(params[0]).toBe("alice");
      expect(params[1]).toBe(UUID);
    }
  });
});
