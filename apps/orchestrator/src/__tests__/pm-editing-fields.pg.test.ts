/**
 * WARP-3520 (ADR-069 WS-4) — the invariants of `PmWorkItem.type` / `.estimate`
 * that only a real database can prove.
 *
 * A mocked Prisma accepts anything, so none of these are visible to the DB-less
 * lane:
 *
 *   * `PmWorkItem_estimate_range` is a CHECK that lives only in migration SQL.
 *     The route validates the same 0..1000 bounds; this proves a NON-route
 *     writer (a fix-up script, a future importer) is refused too, NaN included.
 *   * `type` defaults to `task` in the database, not in the service — so a row
 *     inserted without it (raw SQL, an older orchestrator mid-deploy) is valid.
 *   * the four new `PmActivityVerb` members exist and are writable once the
 *     migration has committed (the migration itself never uses them).
 *
 * Gated the same way the other *.pg.test.ts files are.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PmWorkItem type + estimate — the database's own guarantees (WARP-3520)", () => {
  let prisma: PrismaClient;

  // Every fixture is namespaced `warp3520e-`: the pg-gated suites share one
  // throwaway database and run in the same lane.
  const OURS = { startsWith: "warp3520e-" } as const;

  let projectId = "";
  let seq = 0;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    const ws = await prisma.pmWorkspace.create({
      data: { slug: `warp3520e-ws-${Date.now()}`, name: "warp3520e-ws" },
    });
    const project = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3520e-alpha", identifier: "W35E" },
    });
    projectId = project.id;
    seq = 0;
  });

  const item = (data: Record<string, unknown> = {}) =>
    prisma.pmWorkItem.create({
      data: { projectId, sequenceId: ++seq, name: "warp3520e-item", ...data },
    });

  it("defaults type to 'task' and estimate to NULL (not estimated is not 0)", async () => {
    const row = await item();
    expect(row.type).toBe("task");
    expect(row.estimate).toBeNull();
  });

  it("stores every PmWorkItemType and refuses one that is not in the enum", async () => {
    for (const type of ["task", "bug", "feature", "improvement", "question", "incident"] as const) {
      const row = await item({ type });
      expect(row.type).toBe(type);
    }
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "PmWorkItem" ("id","projectId","sequenceId","name","type","updatedAt") VALUES (gen_random_uuid()::text, $1, 9999, 'warp3520e-bad', 'epic', now())`,
        projectId,
      ),
    ).rejects.toThrow();
  });

  it("accepts the whole 0..1000 estimate range, fractions included", async () => {
    for (const estimate of [0, 0.5, 1, 13, 1000]) {
      const row = await item({ estimate });
      expect(row.estimate).toBe(estimate);
    }
  });

  it("refuses a negative, over-range or NaN estimate (PmWorkItem_estimate_range)", async () => {
    await expect(item({ estimate: -1 })).rejects.toThrow();
    await expect(item({ estimate: 1000.5 })).rejects.toThrow();
    // Postgres orders NaN above every number, so the `<= 1000` arm rejects it.
    // Raw SQL on purpose: Prisma's JSON protocol serialises a JS NaN as `null`,
    // so the real NaN can only reach the column from a non-Prisma writer — which
    // is exactly the writer this CHECK exists for.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "PmWorkItem" ("id","projectId","sequenceId","name","estimate","updatedAt") VALUES (gen_random_uuid()::text, $1, 9998, 'warp3520e-nan', 'NaN'::double precision, now())`,
        projectId,
      ),
    ).rejects.toThrow();
  });

  it("can write the four new activity verbs", async () => {
    const row = await item();
    for (const verb of ["start_date_changed", "type_changed", "estimate_changed", "property_changed"] as const) {
      const activity = await prisma.pmActivity.create({
        data: { workItemId: row.id, verb, field: "x", oldValue: "a", newValue: "b" },
      });
      expect(activity.verb).toBe(verb);
    }
  });
});
