/**
 * WARP-1026 — real-Postgres concurrency tests for the activity recorder.
 *
 * The mocked-Prisma unit suite (activity.service.test.ts) structurally
 * cannot catch the chain fork: it is a READ COMMITTED visibility artifact
 * of `SELECT ... FOR UPDATE` under concurrent writers (EvalPlanQual
 * re-checks only the locked row; it never re-scans for a newer, higher-id
 * tail). Only a real Postgres reproduces it.
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
  },
);
