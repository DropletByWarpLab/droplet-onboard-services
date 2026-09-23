/**
 * WARP-1026 — real-Postgres concurrency tests for the activity recorder.
 *
 * The mocked-Prisma unit suite (activity.service.test.ts) structurally
 * cannot catch the chain fork: it is a READ COMMITTED visibility artifact
 * of `SELECT ... FOR UPDATE` under concurrent writers (EvalPlanQual
 * re-checks only the locked row; it never re-scans for a newer, higher-id
 * tail). Only a real Postgres reproduces it.
 *
 * WARP-3011: the same goes for what the INSERT stores. Prisma's Json write
 * rounding a refs number to 16 digits happens inside the query engine, so
 * the exactness cases below need the real client and a real jsonb column.
 *
 * Gated behind RUN_PG_INTEGRATION=1 + DATABASE_URL so the default
 * `npm run test:orchestrator` lane (no DB) skips. Run locally via
 * scripts/test-orchestrator-pg.sh; in CI via the `pg-integration` job in
 * .github/workflows/orchestrator-tests.yml.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createActivityRecorder } from "./activity.service.js";
import { createHmacSigner, hashSignature } from "./audit-signing.service.js";
import { verifyActivityChain } from "./audit-verify.service.js";

// The global unit setup (src/__tests__/setup.ts) mocks @prisma/client so
// the DB-less lane never needs Postgres. This file is the opposite: it
// must talk to a REAL Postgres, so undo the mock for this module and pull
// the real client in at runtime.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)(
  "activity recorder — real-Postgres concurrency (WARP-1026)",
  () => {
    let prisma: PrismaClient;
    const signer = createHmacSigner(Buffer.alloc(32, 7));

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

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "ActivityRow" RESTART IDENTITY',
      );
    });

    it("25 concurrent record() calls never fork the chain", async () => {
      const recorder = createActivityRecorder({ prisma, signer });
      // Seed one row so every concurrent writer contends on a real tail.
      await recorder.record({
        kind: "system",
        severity: "info",
        sourceIcon: "activity",
        what: "seed",
        actor: { type: "system" },
      });

      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          recorder.record({
            kind: "system",
            severity: "info",
            sourceIcon: "activity",
            what: `concurrent write ${i}`,
            actor: { type: "system" },
          }),
        ),
      );

      const rows = await prisma.activityRow.findMany({
        orderBy: { id: "asc" },
      });
      expect(rows).toHaveLength(26);

      // A fork = two rows chaining from the same predecessor. Under a
      // correct recorder every prevSignatureHash is unique...
      const prevs = rows.map((r) => r.prevSignatureHash);
      expect(new Set(prevs).size).toBe(prevs.length);

      // ...and, stronger, every row links to the row IMMEDIATELY before
      // it in id order (lock-acquisition order == insertion order).
      expect(rows[0]!.prevSignatureHash).toBe("");
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.prevSignatureHash).toBe(
          hashSignature(rows[i - 1]!.signature),
        );
      }
    });

    it("concurrent genesis writers on an empty table produce exactly one origin row", async () => {
      const recorder = createActivityRecorder({ prisma, signer });
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          recorder.record({
            kind: "system",
            severity: "info",
            sourceIcon: "activity",
            what: `genesis race ${i}`,
            actor: { type: "system" },
          }),
        ),
      );
      const rows = await prisma.activityRow.findMany({
        orderBy: { id: "asc" },
      });
      expect(rows).toHaveLength(10);
      const genesisRows = rows.filter((r) => r.prevSignatureHash === "");
      expect(genesisRows).toHaveLength(1);
      expect(genesisRows[0]!.id).toBe(rows[0]!.id);
    });

    // WARP-3011 — Prisma 5.22's Json WRITE keeps 16 significant digits, so a
    // refs number that needs 17 was stored as a different value (0.1 + 0.2
    // as 0.3, 1.7976931348623157e308 as null) while the signature covers the
    // original: verification failed on that row, and so on the whole chain
    // after it, forever. The recorder now binds the canonical text itself.
    it("refs numbers that need 17 significant digits are stored exactly, and the chain verifies (WARP-3011)", async () => {
      const recorder = createActivityRecorder({ prisma, signer });
      const refs = {
        sum: 0.1 + 0.2,
        // An openWakeWord float32 score widened to a double, as routes/voice.ts
        // records it — about one in four of those needs 17 digits.
        score: Math.fround(0.123),
        nested: { list: [123.45600000000002, 5e-324, -1.5e-30] },
        max: 1.7976931348623157e308,
        big: 2 ** 64,
      };
      const row = await recorder.record({
        kind: "voice",
        severity: "info",
        sourceIcon: "mic",
        what: "Wake word heard",
        refs,
        actor: { type: "system" },
      });

      // The column holds every digit...
      const raw = await prisma.$queryRawUnsafe<Array<{ t: string }>>(
        'SELECT "refs"::text AS t FROM "ActivityRow" WHERE "id" = $1',
        row.id,
      );
      expect(JSON.parse(raw[0]!.t)).toEqual(refs);
      // ...Prisma reads it back exactly...
      const found = await prisma.activityRow.findUnique({ where: { id: row.id } });
      expect(found!.refs).toEqual(refs);
      expect((found!.refs as { sum: number }).sum).toBe(0.1 + 0.2);
      expect(row.refs).toEqual(refs);
      // ...and the chain verifies.
      await expect(verifyActivityChain(prisma, signer)).resolves.toEqual({
        ok: true,
        rowsChecked: 1,
        brokenAtId: null,
      });
    });

    it("every other column lands exactly as Prisma's own write stored it (WARP-3011)", async () => {
      const recorder = createActivityRecorder({ prisma, signer });
      const at = new Date("2026-09-23T12:34:56.789Z");
      const actorId = "11111111-1111-4111-8111-111111111111";
      const row = await recorder.record({
        kind: "auth",
        severity: "warn",
        sourceIcon: "log-in",
        what: "Sign-in throttled",
        sub: "from 192.168.50.42",
        actor: { type: "user", id: actorId },
        at,
      });
      expect(typeof row.id).toBe("bigint");

      const found = await prisma.activityRow.findUnique({ where: { id: row.id } });
      expect(found).toEqual({
        id: row.id,
        at,
        severity: "warn",
        sourceIcon: "log-in",
        what: "Sign-in throttled",
        sub: "from 192.168.50.42",
        kind: "auth",
        refs: null,
        signature: row.signature,
        prevSignatureHash: "",
        actorType: "user",
        actorId,
        schemaVersion: 2,
      });
      // No refs is SQL NULL, never the JSON value null.
      const isNull = await prisma.$queryRawUnsafe<Array<{ n: boolean }>>(
        'SELECT "refs" IS NULL AS n FROM "ActivityRow" WHERE "id" = $1',
        row.id,
      );
      expect(isNull[0]!.n).toBe(true);
      await expect(verifyActivityChain(prisma, signer)).resolves.toMatchObject({ ok: true });
    });

    it("`at` bound as ISO text is stored as UTC wall-clock whatever the session TimeZone", async () => {
      // The recorder's INSERT casts `$1::timestamp(3)`; that cast ignores the
      // `Z` rather than converting through the session TimeZone.
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Kiritimati'");
        return tx.$queryRawUnsafe<Array<{ t: string }>>(
          "SELECT $1::timestamp(3)::text AS t",
          "2026-09-23T12:34:56.789Z",
        );
      });
      expect(rows[0]!.t).toBe("2026-09-23 12:34:56.789");
    });
  },
);
