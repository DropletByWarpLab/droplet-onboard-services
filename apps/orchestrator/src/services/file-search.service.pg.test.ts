/**
 * WARP-2193 — real-Postgres proof that the HNSW wiring is actually in force.
 *
 * The mocked lane (src/__tests__/file-search.service.test.ts) can prove the
 * `SET LOCAL hnsw.ef_search` statement is issued on the same client object as
 * the SELECT. It cannot prove Postgres AGREED — that the two statements
 * really shared one transaction, and therefore that the setting was in effect
 * for the scan rather than warned about and discarded. `SET LOCAL` outside a
 * transaction block is a silent no-op, which is exactly the shape of bug this
 * ticket exists to fix, so the mock alone is not sufficient evidence.
 *
 * Two things are checked here that no mock can check:
 *
 *   1. the migration left an HNSW index on the column — an `ef_search` in
 *      force over a sequential scan buys nothing;
 *   2. the setting `searchByVector` asks for is readable, as that value, from
 *      inside the transaction `searchByVector` opened.
 *
 * `current_setting('hnsw.ef_search')` is the function form of
 * `SHOW hnsw.ef_search` — same value, an aliasable column name, and a
 * `missing_ok` variant for the read taken before the SET.
 *
 * Gated behind RUN_PG_INTEGRATION=1 + DATABASE_URL so the default
 * `npm run test:orchestrator` lane (no DB) skips. Run locally via
 * scripts/test-orchestrator-pg.sh; in CI via the `pg-integration` job in
 * .github/workflows/orchestrator-tests.yml.
 *
 * Shared-database hygiene: this suite inserts NOTHING and deletes NOTHING. It
 * searches as a userId that cannot exist (`warp2193-nobody`), so it returns
 * zero rows by construction and cannot disturb a parallel suite.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { searchByVector, hnswEfSearchFor } from "./file-search.service.js";

// The global unit setup (src/__tests__/setup.ts) mocks @prisma/client so the
// DB-less lane never needs Postgres. This file must talk to a REAL Postgres.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

/**
 * 384 dims, matching FileContentChunk.embedding. Non-zero on purpose: cosine
 * distance against a zero vector is NaN, which would turn this into a test
 * about the query rather than about the setting.
 */
const PROBE_VECTOR = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));

/** A userId no Nextcloud install can mint, so the SELECT returns nothing. */
const NOBODY = "warp2193-nobody";

const READ_EF_SEARCH = `SELECT current_setting('hnsw.ef_search', true) AS ef`;

describe.skipIf(!RUN)(
  "searchByVector — HNSW ef_search against a real Postgres (WARP-2193)",
  () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      const { PrismaClient: RealPrismaClient } = await vi.importActual<
        typeof import("@prisma/client")
      >("@prisma/client");
      prisma = new RealPrismaClient();
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it("the migration left exactly one ANN index on embedding, and it is HNSW", async () => {
      const rows = await prisma.$queryRawUnsafe<
        { indexname: string; amname: string }[]
      >(`
        SELECT i.relname AS indexname, am.amname
        FROM pg_class i
        JOIN pg_index x  ON x.indexrelid = i.oid
        JOIN pg_class t  ON t.oid = x.indrelid
        JOIN pg_am    am ON am.oid = i.relam
        WHERE t.relname = 'FileContentChunk'
          AND am.amname IN ('hnsw', 'ivfflat')
      `);
      // Not merely "an hnsw index exists": leaving the IVFFlat one standing
      // alongside would waste disk on every insert AND let the planner pick
      // either, which makes a latency measurement unrepeatable.
      expect(rows.map((r) => r.amname)).toEqual(["hnsw"]);
      expect(rows[0]!.indexname).toBe("FileContentChunk_embedding_hnsw_idx");
    });

    it("SET LOCAL hnsw.ef_search is in force inside the transaction that runs the SELECT", async () => {
      const observed: { before: string | null; inside: string | null } = {
        before: null,
        inside: null,
      };

      // A thin DELEGATING client, not a Proxy: Proxying a Prisma client
      // detaches `this` from its methods. Every call below stays in method
      // position on the real client, so `searchByVector` opens a REAL
      // transaction — and this reads the setting from inside that same
      // transaction, the only place SET LOCAL is observable and the only
      // place it matters.
      const probe = {
        $queryRawUnsafe: (sql: string, ...args: unknown[]) =>
          prisma.$queryRawUnsafe(sql, ...args),
        $executeRawUnsafe: (sql: string, ...args: unknown[]) =>
          prisma.$executeRawUnsafe(sql, ...args),
        $transaction: (
          /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
          fn: (tx: any) => Promise<unknown>,
          /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
          opts?: any,
        ) =>
          prisma.$transaction(async (tx) => {
            // missing_ok=true: before pgvector's library is loaded into this
            // backend the GUC may not exist yet, and an error here would hide
            // the result actually being measured.
            const [pre] = await tx.$queryRawUnsafe<{ ef: string | null }[]>(
              READ_EF_SEARCH,
            );
            observed.before = pre?.ef ?? null;

            const out = await fn(tx);

            const [post] = await tx.$queryRawUnsafe<{ ef: string | null }[]>(
              READ_EF_SEARCH,
            );
            observed.inside = post?.ef ?? null;
            return out;
          }, opts),
        // Never reached (zero rows come back), present so decrypt-on-read
        // cannot fail with a confusing TypeError if that ever changes.
        documentEncryptionKey: (
          prisma as unknown as { documentEncryptionKey: unknown }
        ).documentEncryptionKey,
      } as unknown as PrismaClient;

      const hits = await searchByVector(probe, {
        userId: NOBODY,
        vector: PROBE_VECTOR,
        limit: 250,
        minSimilarity: 0.3,
      });

      expect(hits).toEqual([]);
      // The whole point: Postgres reports the value the service asked for,
      // read back inside the service's own transaction.
      expect(observed.inside).toBe(String(hnswEfSearchFor(250)));
      expect(observed.inside).toBe("250");
      // …and it was not already that beforehand, so the assertion above is
      // measuring the SET and not some ambient session state.
      expect(observed.before).not.toBe("250");
    });

    it("the setting does not outlive its transaction", async () => {
      // SET LOCAL, not SET. If this were session-scoped it would ride the
      // pooled connection into whatever query borrowed it next.
      //
      // Honest about its limits: the follow-up read may land on a DIFFERENT
      // pooled connection, in which case this passes without having exercised
      // the leak. It can never false-FAIL, and on the connection that matters
      // it is the only check that catches a `SET` typed where `SET LOCAL`
      // belongs — so it is worth its three lines, and is not evidence on its
      // own.
      await searchByVector(prisma, {
        userId: NOBODY,
        vector: PROBE_VECTOR,
        limit: 250,
        minSimilarity: 0.3,
      });
      const [row] = await prisma.$queryRawUnsafe<{ ef: string | null }[]>(
        READ_EF_SEARCH,
      );
      // Either the GUC is back to pgvector's default or it was never
      // materialised on this connection. Both are "not 250"; a leak is not.
      expect(row?.ef ?? null).not.toBe("250");
    });
  },
);
