/**
 * WARP-2524 — HNSW search-time wiring for the MCP `search_content` arm.
 *
 * Deliberate mirror of the orchestrator's WARP-2193 suite
 * (`apps/orchestrator/src/__tests__/file-search.service.test.ts`): this copy
 * of `searchByVector` ran the graph walk at pgvector's DEFAULT ef_search of
 * 40 while `searchHybrid` requests `perArmK` (default 100) rows per arm, so
 * the vector arm silently capped below the candidate count it asked for.
 *
 * The failure mode this suite exists to catch is NOT "no results come back".
 * It is "the setting looks applied and isn't": Postgres treats `SET LOCAL`
 * outside a transaction block as a no-op (it warns and moves on), so a
 * version of the fix that issues the statement on the top-level client would
 * pass any results-shaped test while the walk stays at 40. Every assertion
 * below is about WHERE the statement ran.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  searchByVector,
  hnswEfSearchFor,
  HNSW_EF_SEARCH_FLOOR,
  HNSW_EF_SEARCH_CEILING,
  HNSW_EF_SEARCH_OVERSCAN,
} from "../src/file-search.service.js";

/** One statement the fake saw, tagged with the client it was issued on. */
interface FakeStatement {
  /** The transaction client object — identity proves "same transaction". */
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
 * The fake models an INTERACTIVE TRANSACTION, exactly like the orchestrator
 * suite's: `$queryRawUnsafe` on the outer client and on the transaction
 * client are the SAME `vi.fn` spy, so pre-existing assertions against
 * `prisma.$queryRawUnsafe.mock.calls` keep working verbatim. Only the
 * transaction client records into `__journal`, so a journal entry proves a
 * statement ran inside the transaction, and comparing the journal's query
 * count against the spy's call count proves none ran outside one.
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

describe("searchByVector — HNSW ef_search wiring (WARP-2524, mirrors WARP-2193)", () => {
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
    // …and both statements have to be on the SAME connection. A SET LOCAL on
    // any other one is a no-op for this query.
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
    expect(SET_LOCAL_EF_SEARCH.exec(stmt.sql)![1]).toBe(String(HNSW_EF_SEARCH_FLOOR));
  });

  it("opens the candidate list ABOVE the requested row count, not equal to it", async () => {
    // `ef_search == k` is the bare minimum at which the walk can hold the
    // rows it was asked for — the worst point of the recall curve. The floor
    // of 100 masks this at the perArmK=100 default, so use a larger budget.
    const prisma = buildFakePrisma([[]]);
    await searchByVector(prisma, {
      userId: "u1",
      vector: [0.1],
      limit: 250,
      minSimilarity: 0.3,
    });
    const stmt = prisma.__journal.find((e) => SET_LOCAL_EF_SEARCH.test(e.sql))!;
    const emitted = Number(SET_LOCAL_EF_SEARCH.exec(stmt.sql)![1]);
    expect(emitted).toBe(250 * HNSW_EF_SEARCH_OVERSCAN);
    expect(emitted).toBeGreaterThan(250);
  });

  it("clamps to pgvector's ceiling and only ever emits an integer literal", () => {
    // Same table as the orchestrator's suite — the two helpers must agree.
    expect(hnswEfSearchFor(100)).toBe(200);
    expect(hnswEfSearchFor(250)).toBe(500);
    expect(hnswEfSearchFor(10)).toBe(HNSW_EF_SEARCH_FLOOR);
    expect(hnswEfSearchFor(500)).toBe(HNSW_EF_SEARCH_CEILING);
    expect(hnswEfSearchFor(5_000)).toBe(HNSW_EF_SEARCH_CEILING);
    expect(hnswEfSearchFor(0)).toBe(HNSW_EF_SEARCH_FLOOR);
    expect(hnswEfSearchFor(-1)).toBe(HNSW_EF_SEARCH_FLOOR);
    expect(hnswEfSearchFor(Number.NaN)).toBe(HNSW_EF_SEARCH_FLOOR);
    expect(hnswEfSearchFor(Number.POSITIVE_INFINITY)).toBe(HNSW_EF_SEARCH_FLOOR);
    expect(hnswEfSearchFor(120.7)).toBe(240);
    // The value is interpolated into SQL, so it must not be capable of
    // carrying anything but digits — for ANY input, including the ones where
    // the overscan multiply is what overflows.
    for (const n of [
      5_000,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      120.7,
      1e9,
      Number.MAX_VALUE,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const v = hnswEfSearchFor(n);
      expect(Number.isInteger(v), `hnswEfSearchFor(${n}) === ${v}`).toBe(true);
      expect(v).toBeGreaterThanOrEqual(HNSW_EF_SEARCH_FLOOR);
      expect(v).toBeLessThanOrEqual(HNSW_EF_SEARCH_CEILING);
    }
  });
});
