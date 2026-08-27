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
import {
  searchByVector,
  listRecent,
  hnswEfSearchFor,
  HNSW_EF_SEARCH_FLOOR,
  HNSW_EF_SEARCH_CEILING,
  type VectorCandidateStats,
} from "../services/file-search.service.js";

/** One statement the fake saw, tagged with the client it was issued on. */
interface FakeStatement {
  /** The transaction client object — identity is how "same transaction" is proven. */
  client: object;
  kind: "execute" | "query";
  sql: string;
}

type FakePrisma = PrismaClient & {
  /** Every statement issued on a TRANSACTION client, in order. */
  __journal: FakeStatement[];
  /** One entry per `$transaction` call, in order. */
  __txClients: object[];
};

/**
 * WARP-2193 — the fake models an INTERACTIVE TRANSACTION, because
 * `searchByVector` now issues `SET LOCAL hnsw.ef_search` and Postgres
 * treats `SET LOCAL` outside a transaction block as a no-op (it warns and
 * moves on). A fake without `$transaction` would make the fix both
 * unrunnable and — worse — untestable in the direction that matters.
 *
 * `$queryRawUnsafe` on the outer client and on the transaction client are
 * the SAME `vi.fn` spy, so every pre-existing assertion against
 * `prisma.$queryRawUnsafe.mock.calls` keeps working verbatim. What tells
 * the two apart is `__journal`: ONLY the transaction client records into
 * it, so a journal entry proves a statement ran inside the transaction,
 * and comparing the journal's query count against the spy's call count
 * proves none ran outside one.
 */
function buildFakePrisma(rowsByCall: unknown[][]): FakePrisma {
  const queryFn = vi.fn();
  for (const rows of rowsByCall) queryFn.mockResolvedValueOnce(rows);
  const execFn = vi.fn(async (..._args: unknown[]) => 0);
  const journal: FakeStatement[] = [];
  const txClients: object[] = [];

  function makeTxClient(): object {
    const tx = {
      $queryRawUnsafe: (...args: unknown[]) => {
        journal.push({ client: tx, kind: "query", sql: String(args[0]) });
        return queryFn(...args);
      },
      $executeRawUnsafe: (...args: unknown[]) => {
        journal.push({ client: tx, kind: "execute", sql: String(args[0]) });
        return execFn(...args);
      },
    };
    return tx;
  }

  return {
    $queryRawUnsafe: queryFn,
    $executeRawUnsafe: execFn,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = makeTxClient();
      txClients.push(tx);
      return fn(tx);
    }),
    __journal: journal,
    __txClients: txClients,
  } as unknown as FakePrisma;
}

/** Matches the `SET LOCAL hnsw.ef_search = <n>` statement, capturing <n>. */
const SET_LOCAL_EF_SEARCH = /^\s*SET\s+LOCAL\s+hnsw\.ef_search\s*=\s*(\d+)\s*$/i;
/** Matches the vector arm's SELECT (the pgvector cosine ORDER BY). */
const VECTOR_SELECT = /ORDER BY embedding <=>/;

function chunkRow(path: string, score: number) {
  return {
    source: "nextcloud",
    path,
    chunkIdx: 0,
    pageNumber: null,
    brainItemId: null,
    metadata: null,
    score,
    snippet: `snippet for ${path}`,
  };
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

  // WARP-1014 dual-shape reads lean on the WARP-1140 multi-owner
  // predicate: `additionalUserIds` expands to `IN` with one bind
  // parameter per id, and later params (limit here) shift positions
  // accordingly. Pin it so a predicate refactor can't silently drop the
  // UUID arm (brain chunks would vanish from /knowledge again).
  it("expands additionalUserIds to a parameterized IN list", async () => {
    const prisma = buildFakePrisma([[]]);
    await searchByVector(prisma, {
      userId: "alice",
      additionalUserIds: ["6f0f5a3e-2f4b-4a4e-9d7e-0a1b2c3d4e5f"],
      vector: [0.1],
      limit: 5,
      minSimilarity: 0.25,
    });
    const [sql, ...params] = (
      prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(sql).toMatch(/"userId"\s+IN\s+\(\$1,\s*\$2\)/);
    expect(params[0]).toBe("alice");
    expect(params[1]).toBe("6f0f5a3e-2f4b-4a4e-9d7e-0a1b2c3d4e5f");
    expect(params[2]).toBe(5); // limit shifted to $3
  });
});

/**
 * WARP-2193 — HNSW search-time wiring.
 *
 * The failure mode this suite exists to catch is NOT "no results come
 * back". It is "the setting looks applied and isn't": `SET LOCAL` issued
 * outside a transaction is silently ignored by Postgres, so a version of
 * this fix that calls `$executeRawUnsafe` on the top-level client would
 * pass any results-shaped test while leaving the graph walk on pgvector's
 * default ef_search of 40. Every assertion below is about WHERE the
 * statement ran, not what came back.
 */
describe("searchByVector — HNSW ef_search wiring (WARP-2193)", () => {
  it("issues SET LOCAL hnsw.ef_search in the SAME transaction as the SELECT", async () => {
    const prisma = buildFakePrisma([[]]);
    await searchByVector(prisma, {
      userId: "u1",
      vector: [0.1],
      limit: 100,
      minSimilarity: 0.3,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__txClients).toHaveLength(1);

    const journal = prisma.__journal;
    const setIdx = journal.findIndex((e) => SET_LOCAL_EF_SEARCH.test(e.sql));
    const selIdx = journal.findIndex((e) => VECTOR_SELECT.test(e.sql));

    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(selIdx).toBeGreaterThanOrEqual(0);
    // The setting has to be in force BEFORE the scan it is meant to widen.
    expect(setIdx).toBeLessThan(selIdx);
    // …and both statements have to be on the SAME connection. A SET LOCAL
    // on any other one is a no-op for this query.
    expect(journal[setIdx]!.client).toBe(prisma.__txClients[0]);
    expect(journal[selIdx]!.client).toBe(prisma.__txClients[0]);
    // SET returns no rows — it must go through $executeRawUnsafe.
    expect(journal[setIdx]!.kind).toBe("execute");
  });

  it("never runs the vector SELECT outside a transaction", async () => {
    const prisma = buildFakePrisma([[]]);
    await searchByVector(prisma, {
      userId: "u1",
      vector: [0.1],
      limit: 100,
      minSimilarity: 0.3,
    });

    const spy = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;
    const inTx = prisma.__journal.filter((e) => e.kind === "query").length;
    // Every $queryRawUnsafe the service made was routed through a tx client.
    // If the SELECT were issued on the top-level client this would be 1 vs 0.
    expect(inTx).toBe(spy.mock.calls.length);
    expect(inTx).toBeGreaterThan(0);
  });

  it("sizes ef_search off the caller's row budget, floored at the arm's default", async () => {
    const prisma = buildFakePrisma([[]]);
    // limit IS perArmK when the caller is searchHybrid.
    await searchByVector(prisma, {
      userId: "u1",
      vector: [0.1],
      limit: 10,
      minSimilarity: 0.3,
    });
    const stmt = prisma.__journal.find((e) => SET_LOCAL_EF_SEARCH.test(e.sql))!;
    expect(SET_LOCAL_EF_SEARCH.exec(stmt.sql)![1]).toBe(
      String(HNSW_EF_SEARCH_FLOOR),
    );
  });

  it("raises ef_search when the caller asks for more rows than the floor", async () => {
    const prisma = buildFakePrisma([[]]);
    await searchByVector(prisma, {
      userId: "u1",
      vector: [0.1],
      limit: 250,
      minSimilarity: 0.3,
    });
    const stmt = prisma.__journal.find((e) => SET_LOCAL_EF_SEARCH.test(e.sql))!;
    expect(SET_LOCAL_EF_SEARCH.exec(stmt.sql)![1]).toBe("250");
  });

  it("clamps to pgvector's ceiling and only ever emits an integer literal", () => {
    expect(hnswEfSearchFor(5_000)).toBe(HNSW_EF_SEARCH_CEILING);
    expect(hnswEfSearchFor(0)).toBe(HNSW_EF_SEARCH_FLOOR);
    expect(hnswEfSearchFor(-1)).toBe(HNSW_EF_SEARCH_FLOOR);
    expect(hnswEfSearchFor(Number.NaN)).toBe(HNSW_EF_SEARCH_FLOOR);
    expect(hnswEfSearchFor(120.7)).toBe(120);
    // The value is interpolated into DDL-adjacent SQL, so it must not be
    // capable of carrying anything but digits.
    for (const n of [5_000, 0, -1, Number.NaN, 120.7, 1e9]) {
      expect(Number.isInteger(hnswEfSearchFor(n))).toBe(true);
    }
  });

  it("reports how many candidates survived the post-query minSimilarity floor", async () => {
    // The pipeline this ticket is about fetches perArmK and then discards
    // below the floor in JS. From outside, "12 results" looks healthy
    // whether it came from 12 candidates or 100 — so the surviving count
    // has to be observable, or recall changes cannot be measured.
    const prisma = buildFakePrisma([
      [chunkRow("/a.pdf", 0.81), chunkRow("/b.pdf", 0.1), chunkRow("/c.pdf", 0.55)],
    ]);
    const seen: VectorCandidateStats[] = [];
    const hits = await searchByVector(prisma, {
      userId: "u1",
      vector: [0.1],
      limit: 100,
      minSimilarity: 0.3,
      onCandidates: (s) => seen.push(s),
    });

    expect(hits).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      requested: 100,
      returned: 3,
      aboveFloor: 2,
      readable: 2,
      efSearch: 100,
      minSimilarity: 0.3,
    });
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
