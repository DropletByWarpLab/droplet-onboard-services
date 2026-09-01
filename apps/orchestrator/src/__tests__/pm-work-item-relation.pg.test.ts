/**
 * WARP-2586 (ADR-045 slice G) — the invariants that only a real database can
 * prove.
 *
 * Three of the guarantees this slice rests on are enforced NOWHERE in
 * TypeScript:
 *
 *   * `PmWorkItemRelation_no_self_edge` and
 *     `PmWorkItemRelation_symmetric_canonical_order` are CHECK constraints
 *     that live only in migration SQL. A mocked Prisma will happily accept the
 *     rows they reject, so a green unit suite says nothing about them.
 *   * `pmworkitem_parent_same_project` is a TRIGGER. Same story, and it is the
 *     first database-level opinion PM has ever had about parenting.
 *   * The double CASCADE is a database behaviour, not a service behaviour.
 *
 * The canonical-order case is the one worth stating plainly: it is what makes
 * a symmetric relation ONE row. If it silently stopped being enforced, the
 * service would keep canonicalising and everything would look fine — until a
 * non-service writer (a fix-up script, a future importer) inserted the mirror,
 * and then the drawer's delete would appear not to work, intermittently, on
 * one customer's box.
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

describe.skipIf(!RUN)("PmWorkItemRelation — the database's own guarantees (WARP-2586)", () => {
  let prisma: PrismaClient;

  // Every fixture is namespaced `warp2607-`: the pg-gated suites share one
  // throwaway database and run in the same lane, so an unscoped deleteMany()
  // would eat another suite's rows.
  const OURS = { startsWith: "warp2607-" } as const;

  let projectA = "";
  let projectB = "";
  let seq = 0;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // FK-ordered and scoped. Projects cascade to their work items, which
    // cascade to relations and activity.
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });

    const ws = await prisma.pmWorkspace.create({
      data: { slug: `warp2607-ws-${Date.now()}`, name: "warp2607-ws" },
    });
    const a = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp2607-alpha", identifier: "W26A" },
    });
    const b = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp2607-bravo", identifier: "W26B" },
    });
    projectA = a.id;
    projectB = b.id;
    seq = 0;
  });

  const item = (projectId: string, name = "warp2607-item") =>
    prisma.pmWorkItem.create({
      data: { projectId, sequenceId: ++seq, name: `warp2607-${name}` },
    });

  // ── the CHECK constraints ────────────────────────────────────────────────

  it("rejects a self-edge (PmWorkItemRelation_no_self_edge)", async () => {
    const a = await item(projectA);
    await expect(
      prisma.pmWorkItemRelation.create({
        data: { fromId: a.id, toId: a.id, kind: "BLOCKS" },
      }),
    ).rejects.toThrow();
  });

  it("rejects a symmetric row stored in NON-canonical order — this is what keeps it one row", async () => {
    const a = await item(projectA, "lo");
    const b = await item(projectB, "hi");
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];

    // The canonical direction is accepted...
    await expect(
      prisma.pmWorkItemRelation.create({
        data: { fromId: lo.id, toId: hi.id, kind: "RELATES" },
      }),
    ).resolves.toBeTruthy();

    // ...and the mirror is refused by the database, not merely avoided by the
    // service. Bypassing pm-relations.service is the point of this assertion.
    await expect(
      prisma.pmWorkItemRelation.create({
        data: { fromId: hi.id, toId: lo.id, kind: "RELATES" },
      }),
    ).rejects.toThrow();

    const rows = await prisma.pmWorkItemRelation.findMany({
      where: { OR: [{ fromId: lo.id }, { toId: lo.id }] },
    });
    expect(rows).toHaveLength(1);
  });

  it("accepts BLOCKS in BOTH directions — it is directional, and the cycle rule is the service's job", async () => {
    const a = await item(projectA, "one");
    const b = await item(projectA, "two");
    await prisma.pmWorkItemRelation.create({
      data: { fromId: a.id, toId: b.id, kind: "BLOCKS" },
    });
    // The DB does not know about cycles — createRelation refuses this, but a
    // CHECK constraint cannot walk a graph, so nothing here stops it. Asserted
    // so nobody later reads the CHECKs as a cycle guarantee they are not.
    await expect(
      prisma.pmWorkItemRelation.create({
        data: { fromId: b.id, toId: a.id, kind: "BLOCKS" },
      }),
    ).resolves.toBeTruthy();
  });

  it("rejects a duplicate (fromId, toId, kind), and the three columns are NOT NULL", async () => {
    const a = await item(projectA, "one");
    const b = await item(projectB, "two");
    await prisma.pmWorkItemRelation.create({
      data: { fromId: a.id, toId: b.id, kind: "BLOCKS" },
    });
    await expect(
      prisma.pmWorkItemRelation.create({
        data: { fromId: a.id, toId: b.id, kind: "BLOCKS" },
      }),
    ).rejects.toThrow();

    // Because none of the three is nullable, the unique index MATCHES — the
    // NULL = NULL is false trap that makes `upsert` silently never match a
    // compound unique with a nullable member does not apply here.
    const upserted = await prisma.pmWorkItemRelation.upsert({
      where: { fromId_toId_kind: { fromId: a.id, toId: b.id, kind: "BLOCKS" } },
      create: { fromId: a.id, toId: b.id, kind: "BLOCKS" },
      update: { createdById: "warp2607-upsert-proof" },
    });
    expect(upserted.createdById).toBe("warp2607-upsert-proof");
    expect(
      await prisma.pmWorkItemRelation.count({ where: { fromId: a.id, toId: b.id } }),
    ).toBe(1);
  });

  it("deleting either end takes the edge with it (double CASCADE)", async () => {
    const a = await item(projectA, "one");
    const b = await item(projectB, "two");
    await prisma.pmWorkItemRelation.create({
      data: { fromId: a.id, toId: b.id, kind: "BLOCKS" },
    });
    await prisma.pmWorkItem.delete({ where: { id: b.id } });
    expect(await prisma.pmWorkItemRelation.count({ where: { fromId: a.id } })).toBe(0);
  });

  // ── the parenting trigger ────────────────────────────────────────────────

  it("refuses a parent in another project on INSERT (pmworkitem_parent_same_project)", async () => {
    const parentInB = await item(projectB, "parent");
    await expect(
      prisma.pmWorkItem.create({
        data: {
          projectId: projectA,
          sequenceId: ++seq,
          name: "warp2607-child",
          parentId: parentInB.id,
        },
      }),
    ).rejects.toThrow(/same project|WARP-2586/i);
  });

  it("refuses re-parenting across a project boundary on UPDATE", async () => {
    const childInA = await item(projectA, "child");
    const parentInB = await item(projectB, "parent");
    await expect(
      prisma.pmWorkItem.update({
        where: { id: childInA.id },
        data: { parentId: parentInB.id },
      }),
    ).rejects.toThrow(/same project|WARP-2586/i);
  });

  it("allows same-project parenting, and still nulls the child on parent delete", async () => {
    const parent = await item(projectA, "parent");
    const child = await prisma.pmWorkItem.create({
      data: {
        projectId: projectA,
        sequenceId: ++seq,
        name: "warp2607-child",
        parentId: parent.id,
      },
    });
    // The trigger must not interfere with ON DELETE SET NULL: it writes NULL,
    // which passes the guard.
    await prisma.pmWorkItem.delete({ where: { id: parent.id } });
    const after = await prisma.pmWorkItem.findUnique({ where: { id: child.id } });
    expect(after?.parentId).toBeNull();
  });

  it("refuses moving an item to another project while a sub-issue stays behind", async () => {
    const parent = await item(projectA, "parent");
    await prisma.pmWorkItem.create({
      data: {
        projectId: projectA,
        sequenceId: ++seq,
        name: "warp2607-child",
        parentId: parent.id,
      },
    });
    // No write path sets projectId today. That is exactly why this is pinned
    // now: the guard has to already be there on the day one lands.
    await expect(
      prisma.pmWorkItem.update({
        where: { id: parent.id },
        data: { projectId: projectB },
      }),
    ).rejects.toThrow(/another project|WARP-2586/i);
  });

  it("the migration's repair pass left NO cross-project parents behind", async () => {
    // Expected to be zero on every box — no shipped code path could ever write
    // one (pm.service.ts has rejected it on both write paths since ADR-026 P2).
    // Asserted rather than assumed, because the trigger does not validate rows
    // that already existed, so a survivor would sit there until somebody
    // touched it.
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n
      FROM "PmWorkItem" c
      JOIN "PmWorkItem" p ON p."id" = c."parentId"
      WHERE c."projectId" <> p."projectId"
    `;
    expect(rows[0].n).toBe(BigInt(0));
  });
});
