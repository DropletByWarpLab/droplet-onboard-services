/**
 * WARP-3371 — what the DATABASE does when a PM list is paged.
 *
 * The board used to stop at 100 items and say nothing. Every list is now a keyset
 * page (`pm-paging.ts`), and the three claims that make "follow the cursor until
 * it is null" return EVERY row exactly once are claims about Postgres, not about
 * TypeScript — a Prisma fake that ignores `take` and `orderBy` cannot make any
 * of them:
 *
 *   1. The `(sortOrder, id)` / `(updatedAt, id)` keyset predicate agrees with the
 *      `ORDER BY` it pairs with — including on FLOAT sort keys (sortOrder is a
 *      Float column), on ties, and on the database's own collation of `id`.
 *   2. `total` is the exact size of the filtered set whatever the page size.
 *   3. The summary counts are computed over every row, not over a page: 250 open
 *      items read as 250 open items.
 *
 * Gated like every other `*.pg.test.ts`: real Postgres, RUN_PG_INTEGRATION=1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import * as pm from "../services/pm/pm.service.js";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PM list paging against Postgres (WARP-3371)", () => {
  let prisma: PrismaClient;

  // Every fixture is namespaced so cleanup scopes to this suite: the pg-gated
  // suites share one throwaway database.
  const WS = "warp3371-ws";

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.pmWorkspace.deleteMany({ where: { slug: WS } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Workspace -> project -> work item all CASCADE, so one delete clears it.
    await prisma.pmWorkspace.deleteMany({ where: { slug: WS } });
  });

  async function makeProject(identifier: string) {
    return pm.createProject(prisma, null, {
      workspaceSlug: WS,
      name: `warp3371-${identifier}`,
      identifier,
    });
  }

  /** Bulk-insert `n` open items straight into the table. */
  async function seed(
    projectId: string,
    n: number,
    over: (i: number) => Partial<{ sortOrder: number; updatedAt: Date; dueDate: Date | null; isArchived: boolean }> = () => ({}),
  ): Promise<void> {
    await prisma.pmWorkItem.createMany({
      data: Array.from({ length: n }, (_, k) => {
        const i = k + 1;
        return { projectId, sequenceId: i, name: `warp3371-item-${i}`, sortOrder: i, ...over(i) };
      }),
    });
  }

  /** The ids in the order Postgres itself would list them. */
  async function dbOrder(projectId: string, orderBy: string): Promise<string[]> {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "PmWorkItem" WHERE "projectId" = $1 AND "isArchived" = false ORDER BY ${orderBy}`,
      projectId,
    );
    return rows.map((r) => r.id);
  }

  async function walkBoard(projectId: string, limit?: number) {
    const pages: Array<{ ids: string[]; total: number; nextCursor: string | null }> = [];
    let cursor: string | undefined;
    do {
      const page = await pm.listWorkItems(prisma, projectId, { limit, cursor });
      pages.push({ ids: page.items.map((i) => i.id), total: page.total, nextCursor: page.nextCursor });
      cursor = page.nextCursor ?? undefined;
      expect(pages.length).toBeLessThan(500); // a stuck cursor must fail, not hang
    } while (cursor);
    return pages;
  }

  it("250 items: every one is reached exactly once, in the database's own order, with an exact total", async () => {
    const p = await makeProject("P250");
    await seed(p.id, 250);

    const pages = await walkBoard(p.id);
    expect(pages.map((x) => x.ids.length)).toEqual([100, 100, 50]);
    expect(pages.map((x) => x.total)).toEqual([250, 250, 250]);
    expect(pages[2].nextCursor).toBeNull();

    const ids = pages.flatMap((x) => x.ids);
    expect(new Set(ids).size).toBe(250);
    // The strongest statement available: the paged walk IS the table, ordered.
    expect(ids).toEqual(await dbOrder(p.id, `"sortOrder" ASC, "id" ASC`));
  });

  it("a page size of 7 over 250 rows is also the whole table, once", async () => {
    const p = await makeProject("P7");
    await seed(p.id, 250);
    const ids = (await walkBoard(p.id, 7)).flatMap((x) => x.ids);
    expect(ids).toHaveLength(250);
    expect(ids).toEqual(await dbOrder(p.id, `"sortOrder" ASC, "id" ASC`));
  });

  it("ties on sortOrder are closed by id: no row repeats or vanishes across a boundary", async () => {
    const p = await makeProject("PTIE");
    // 60 rows, only 4 distinct sort keys — most boundaries fall INSIDE a tie.
    await seed(p.id, 60, (i) => ({ sortOrder: (i % 4) + 1 }));
    const ids = (await walkBoard(p.id, 7)).flatMap((x) => x.ids);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    expect(ids).toEqual(await dbOrder(p.id, `"sortOrder" ASC, "id" ASC`));
  });

  it("float sort keys survive the cursor exactly (sortOrder is a Float, and a drag inserts BETWEEN two cards)", async () => {
    const p = await makeProject("PFLT");
    const keys = [0.1, 0.2, 0.1 + 0.2, 0.30000000000000004 + 1e-16, 1 / 3, 2 / 3, 1e-7, 123456.789, -4.5, 1e21, 5e-324];
    await seed(p.id, keys.length, (i) => ({ sortOrder: keys[i - 1] }));
    const ids = (await walkBoard(p.id, 2)).flatMap((x) => x.ids);
    expect(ids).toHaveLength(keys.length);
    expect(ids).toEqual(await dbOrder(p.id, `"sortOrder" ASC, "id" ASC`));
  });

  it("a row deleted between two pages — even the one the cursor names — loses nothing", async () => {
    const p = await makeProject("PDEL");
    await seed(p.id, 30);
    const first = await pm.listWorkItems(prisma, p.id, { limit: 10 });
    const last = first.items[first.items.length - 1];
    await prisma.pmWorkItem.delete({ where: { id: last.id } });
    const rest = await pm.listWorkItems(prisma, p.id, { limit: 500, cursor: first.nextCursor! });
    const expected = (await dbOrder(p.id, `"sortOrder" ASC, "id" ASC`)).filter(
      (id) => !first.items.some((i) => i.id === id),
    );
    expect(rest.items.map((i) => i.id)).toEqual(expected);
    expect(rest.items).toHaveLength(20);
    expect(rest.total).toBe(29);
  });

  it("`total` is the filtered set (archived rows and other projects excluded), whatever the page size", async () => {
    const a = await makeProject("PTOTA");
    const b = await makeProject("PTOTB");
    await seed(a.id, 40);
    await seed(b.id, 15);
    await prisma.pmWorkItem.updateMany({
      where: { projectId: a.id, sequenceId: { lte: 5 } },
      data: { isArchived: true, archivedAt: new Date() },
    });
    const page = await pm.listWorkItems(prisma, a.id, { limit: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(35);
  });

  it("the search and the own-assignments list page by (updatedAt desc, id desc), ties included", async () => {
    const p = await makeProject("PSRCH");
    const at = new Date("2026-10-03T12:00:00.000Z");
    // 40 rows over 4 distinct instants: boundaries land inside ties.
    await seed(p.id, 40, (i) => ({ updatedAt: new Date(at.getTime() + (i % 4) * 1000) }));
    const rows = await prisma.pmWorkItem.findMany({ where: { projectId: p.id }, select: { id: true } });
    await prisma.pmWorkItemAssignee.createMany({
      data: rows.map((r) => ({ workItemId: r.id, userId: "warp3371-user" })),
    });
    const expected = await dbOrder(p.id, `"updatedAt" DESC, "id" DESC`);

    const searched: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await pm.searchWorkItems(prisma, { q: "warp3371-item", workspaceSlug: WS, limit: 7, cursor });
      expect(page.total).toBe(40);
      searched.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(searched).toEqual(expected);

    const assigned: string[] = [];
    cursor = undefined;
    do {
      const page = await pm.listAssignedWorkItems(prisma, "warp3371-user", { limit: 9, cursor });
      expect(page.total).toBe(40);
      assigned.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(assigned).toEqual(expected);
  });

  it("summary counts are computed over EVERY row — 250 open items read as 250, not as one page", async () => {
    const p = await makeProject("PSUM");
    const yesterday = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    // 250 open items, 120 of them overdue.
    await seed(p.id, 250, (i) => ({ dueDate: i <= 120 ? yesterday : null }));

    const summary = await pm.getSummary(prisma, WS);
    expect(summary.itemsOpen).toBe(250);
    expect(summary.overdue).toBe(120);

    const projects = await pm.listProjects(prisma, { workspaceSlug: WS });
    const row = projects.find((x) => x.id === p.id)!;
    // Items with no state are open-but-uncategorised and land in `unstarted`.
    expect(row.openCount).toBe(250);
    expect(row.groups.unstarted).toBe(250);
  });
});
