/**
 * WARP-1570 — real-Postgres proof that the isolation level is load-bearing.
 *
 * The shared seam (helpers/prisma-tx-harness.ts) SIMULATES Postgres SSI so
 * concurrency defects are reachable in the DB-less lane. A simulation is
 * only worth what it is calibrated against, and only a real Postgres can
 * calibrate it. This file is that calibration, on the exact scenario the
 * RBAC v2 rails exist to stop:
 *
 *   Rail 5, last-operator (role-mutation-guard.service.ts): COUNT the
 *   surviving non-disabled owner∪admin rows, then demote in the same
 *   transaction. Two requests each demoting one of the last two operators
 *   both read "one other operator remains", both pass the rail, and both
 *   commit — landing the zero-operator state that is unrecoverable from
 *   the dashboard.
 *
 * Under SERIALIZABLE, Postgres detects the read-write dependency cycle and
 * aborts the loser (SQLSTATE 40001 → Prisma P2034), which the routes map to
 * CONCURRENT_MUTATION. Under READ COMMITTED it does not, and the anomaly is
 * real. Both directions are asserted, because a test that only pins the
 * safe direction cannot tell you the isolation level is doing anything.
 *
 * ## Why the predicate is inlined rather than imported
 *
 * assertNotLastOperator() lives behind a module graph that pulls in the
 * session service, the NC clients and config validation — none of which the
 * pg lane provisions. The predicate is mirrored here verbatim instead, and a
 * drift assertion re-reads the service file so the mirror cannot rot
 * silently (same file-text-regression discipline as
 * access-role.schema.test.ts / pg-lane-image-parity.test.ts).
 *
 * ## Shared-database hygiene
 *
 * The pg lane runs its files IN PARALLEL against ONE throwaway database.
 * Every fixture here is namespaced `warp1570-` and every cleanup, count and
 * assertion is scoped to that prefix. An unscoped `deleteMany()` in this
 * file would eat another suite's rows mid-test — a planted cross-suite
 * flake, not a tidy-up.
 *
 * Gated behind RUN_PG_INTEGRATION=1 + DATABASE_URL so the default
 * `npm run test:orchestrator` lane skips. Run locally via
 * scripts/test-orchestrator-pg.sh; in CI via the `pg-integration` job in
 * .github/workflows/orchestrator-tests.yml.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { PrismaClient } from "@prisma/client";

// The global unit setup (src/__tests__/setup.ts) mocks @prisma/client so the
// DB-less lane never needs Postgres. This file must talk to a REAL Postgres.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

/** Every fixture this suite mints carries this prefix. */
const PREFIX = "warp1570-";
const OURS = { startsWith: PREFIX } as const;

/** A rendezvous both transactions must reach before either may write. */
function barrier(party: number): () => Promise<void> {
  let arrived = 0;
  const waiters: Array<() => void> = [];
  return () => {
    arrived += 1;
    if (arrived >= party) {
      waiters.splice(0, waiters.length).forEach((w) => w());
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiters.push(resolve));
  };
}

/** Postgres serialization failure, however Prisma chose to surface it. */
function isSerializationFailure(reason: unknown): boolean {
  const code = (reason as { code?: string } | null)?.code;
  if (code === "P2034" || code === "40001") return true;
  const message = String((reason as { message?: string } | null)?.message ?? "");
  return /could not serialize|write conflict|deadlock/i.test(message);
}

describe.skipIf(!RUN)(
  "WARP-1570 — transaction isolation against a real Postgres",
  () => {
    let a: PrismaClient;
    let b: PrismaClient;

    beforeAll(async () => {
      const { PrismaClient: RealPrismaClient } = await vi.importActual<
        typeof import("@prisma/client")
      >("@prisma/client");
      // TWO clients, so the two transactions are genuinely on separate
      // connections rather than sharing one and serializing by accident.
      a = new RealPrismaClient();
      b = new RealPrismaClient();
      await Promise.all([a.$connect(), b.$connect()]);
    });

    afterAll(async () => {
      await a.userAccessException.deleteMany({ where: { user: { username: OURS } } });
      await a.user.deleteMany({ where: { username: OURS } });
      await Promise.all([a.$disconnect(), b.$disconnect()]);
    });

    beforeEach(async () => {
      // Scoped to THIS suite's prefix only — sibling pg suites are running
      // against the same database at the same time.
      await a.userAccessException.deleteMany({ where: { user: { username: OURS } } });
      await a.user.deleteMany({ where: { username: OURS } });
    });

    /**
     * Seed exactly two ACTIVE operators, then have both demote themselves
     * at once, parked at a barrier between the rail's COUNT and its write.
     */
    async function raceTwoDemotions(
      isolationLevel: "Serializable" | "ReadCommitted",
    ) {
      const [one, two] = await Promise.all([
        a.user.create({
          data: {
            username: `${PREFIX}admin-one`,
            displayName: "One",
            role: "admin",
            directoryStatus: "ACTIVE",
          },
        }),
        a.user.create({
          data: {
            username: `${PREFIX}admin-two`,
            displayName: "Two",
            role: "admin",
            directoryStatus: "ACTIVE",
          },
        }),
      ]);

      const bothRead = barrier(2);

      const demote = (client: PrismaClient, id: string) =>
        client.$transaction(
          async (tx) => {
            // Mirrors assertNotLastOperator(). The extra `username`
            // conjunct scopes the count to this suite's fixtures — required
            // on a shared parallel database, and immaterial to the property
            // under test: it still range-reads the rows both transactions
            // are about to write, which is what SSI tracks.
            const remaining = await tx.user.count({
              where: {
                username: OURS,
                role: { in: ["owner", "admin"] },
                directoryStatus: "ACTIVE",
                id: { not: id },
              },
            });
            await bothRead();
            if (remaining === 0) throw new Error("LAST_OPERATOR_INVARIANT");
            await tx.user.update({ where: { id }, data: { role: "guest" } });
          },
          { isolationLevel, timeout: 20_000, maxWait: 20_000 },
        );

      const results = await Promise.allSettled([
        demote(a, one.id),
        demote(b, two.id),
      ]);
      const operators = await a.user.count({
        where: {
          username: OURS,
          role: { in: ["owner", "admin"] },
          directoryStatus: "ACTIVE",
        },
      });
      return { results, operators };
    }

    it("SERIALIZABLE: Postgres aborts the loser, one operator survives", async () => {
      const { results, operators } = await raceTwoDemotions("Serializable");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(
        isSerializationFailure((rejected[0] as PromiseRejectedResult).reason),
        `expected a serialization failure, got ${String(
          (rejected[0] as PromiseRejectedResult).reason,
        )}`,
      ).toBe(true);
      expect(operators).toBe(1);
    }, 40_000);

    it("READ COMMITTED: both demotions commit — zero operators, the anomaly is real", async () => {
      // The negative half. Without it, "SERIALIZABLE is safe" says nothing
      // about whether the isolation level is what made it safe.
      const { results, operators } = await raceTwoDemotions("ReadCommitted");
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      expect(operators).toBe(0);
    }, 40_000);

    it("the mirrored rail-5 predicate has not drifted from the service", () => {
      const service = readFileSync(
        path.resolve(process.cwd(), "src/services/role-mutation-guard.service.ts"),
        "utf-8",
      );
      const start = service.indexOf("async function assertNotLastOperator");
      expect(
        start,
        "role-mutation-guard.service.ts must still declare assertNotLastOperator",
      ).toBeGreaterThanOrEqual(0);
      const body = service.slice(start, start + 900);
      // The three conjuncts this file mirrors. If the rail's predicate
      // changes, this file's proof stops covering the shipped rail.
      expect(body).toContain("role: { in: [...ADMIN_TIER_ROLES] }");
      expect(body).toContain('directoryStatus: "ACTIVE"');
      expect(body).toContain("id: { not: target.id }");
    });
  },
);
