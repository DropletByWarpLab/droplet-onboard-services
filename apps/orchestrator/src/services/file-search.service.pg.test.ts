/**
 * WARP-2193 — real-Postgres proof that the HNSW wiring is actually in force.
 *
 * The mocked lane (src/__tests__/file-search.service.test.ts) can prove the
 * `SET LOCAL hnsw.ef_search` statement is issued on the same client object as
 * the SELECT. It cannot prove Postgres AGREED — that the two statements
 * really shared one transaction, and therefore that the setting was in effect
 * for the scan rather than warned about and discarded. `SET LOCAL` outside a
 * transaction block is a silent no-op, which is precisely the shape of bug
 * this ticket exists to fix, so the mock alone is not enough evidence.
 *
 * This file reads the setting back from INSIDE the transaction
 * `searchByVector` opened (`current_setting('hnsw.ef_search')`, the function
 * form of `SHOW hnsw.ef_search` — same value, aliasable column name, and a
 * `missing_ok` variant for the pre-SET read). It also asserts the migration
 * left an HNSW index on the column, since an `ef_search` in force over a
 * sequential scan buys nothing.
 *
 * Gated behind RUN_PG_INTEGRATION=1 + DATABASE_URL so the default
 * `npm run test:orchestrator` lane (no DB) skips. Run locally via
 * scripts/test-orchestrator-pg.sh; in CI via the `pg-integration` job in
 * .github/workflows/orchestrator-tests.yml.
 *
 * Shared-database hygiene: this suite inserts NOTHING and deletes NOTHING. It
 * searches as a userId that cannot exist (`warp2193-nobody`), so it returns
 * zero rows by construction and cannot interfere with a parallel suite.
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

/** 384 dims, matching FileContentChunk.embedding. Non-zero: cosine distance
 *  against a zero vector is NaN, which would make the assertion about the
 *  QUERY rather than about the setting. */
const PROBE_VECTOR = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));

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

    it("the migration left exactly one ANN index on the column, and it is HNSW", async () => {
      const rows = await prisma.$queryRawUnsafe<
        { indexname: string; amname: string }[]
      >(`
        SELECT i.relname AS indexname, am.amname
        FROM pg_class i
        JOIN pg_index x ON x.indexrelid = i.oid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_am    am ON am.oid = i.relam
        WHERE t.relname = 'FileContentChunk'
          AND am.amname IN ('hnsw', 'ivfflat')
      `);
      // Not just "an hnsw index exists": leaving the IVFFlat one alongside it
      // would waste disk AND let the planner pick either.
      expect(rows.map((r) => r.amname)).toEqual(["hnsw"]);
      expect(rows[0]!.indexname).toBe("FileContentChunk_embedding_hnsw_idx");
    });

    it("SET LOCAL hnsw.ef_search is in force inside the transaction that runs the SELECT", async () => {
      const observed: { before: string | null; inside: string | null } = {
        before: null,
        inside: null,
      };

      // A thin delegating client, not a Proxy: it hands `searchByVector` a
      // REAL prisma so a REAL transaction is opened, and reads the setting
      // from inside that same transaction — the only place `SET LOCAL` is
      // observable, and the only place it matters.
      const probe = {
        $queryRawUnsafe: (...a: unknown[]) =>
          (prisma as unknown as {
            $queryRawUnsafe: (...a: unknown[]) => Promise<unknown>;
          }).$queryRawUnsafe(...a),
        $executeRawUnsafe: (...a: unknown[]) =>
          (prisma as unknown as {
            $executeRawUnsafe: (...a: unknown[]) => Promise<unknown>;
          }).$executeRawUnsafe(...a),
        $transaction: (
          fn: (tx: unknown) => Promise<unknown>,
          opts?: unknown,
        ) =>
          (prisma.$transaction as unknown as (
            f: (tx: unknown) => Promise<unknown>,
            o?: unknown,
          ) => Promise<unknown>)(async (tx: unknown) => {
            const t = tx as {
              $queryRawUnsafe: <T>(sql: string) => Promise<T>;
            };
            const [pre] = await t.$queryRawUnsafe<{ ef: string | null }[]>(
              // missing_ok=true: before pgvector's library is loaded into this
              // backend the GUC may not exist yet, and an error here would
              // hide the result we actually care about.
              `SELECT current_setting('hnsw.ef_search', true) AS ef`,
            );
            observed.before = pre?.ef ?? null;

            const out = await fn(tx);

            const [post] = await t.$queryRawUnsafe<{ ef: string | null }[]>(
              `SELECT current_setting('hnsw.ef_search', true) AS ef`,
            );
            observed.inside = post?.ef ?? null;
            return out;
          }, opts),
        // Never reached (zero rows come back), present so a future
        // decrypt-on-read path cannot fail with a confusing TypeError.
        documentEncryptionKey: (
          prisma as unknown as { documentEncryptionKey: unknown }
        ).documentEncryptionKey,
      } as unknown as PrismaClient;

      const hits = await searchByVector(probe, {
        userId: "warp2193-nobody",
        vector: PROBE_VECTOR,
        limit: 250,
        minSimilarity: 0.3,
      });

      expect(hits).toEqual([]);
      // The whole point: Postgres reports the value the service asked for,
      // read back inside the service's own transaction.
      expect(observed.inside).toBe(String(hnswEfSearchFor(250)));
      expect(observed.inside).toBe("250");
      // …and it was not already that before the SET, so the assertion above
      // is measuring the SET and not some ambient session state.
      expect(observed.before).not.toBe("250");
    });
  },
);
