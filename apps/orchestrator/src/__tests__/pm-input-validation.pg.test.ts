/**
 * WARP-3371 — the work-item API's input checks, against a real Postgres.
 *
 * Four of them are claims only the database can settle:
 *
 *   1. A parent cycle is refused, and two concurrent re-parents that would
 *      together close one cannot BOTH win: re-parenting reads a chain and then
 *      writes, which is write skew under READ COMMITTED. It runs SERIALIZABLE, so
 *      the loser is a P2034 -> `concurrent_mutation`, never a loop in the table.
 *   2. An unknown label id, and an assignee who is not an active person, are
 *      refused BEFORE the write with the offending ids named — no foreign-key
 *      error is ever the answer. (Assignee ids are plain strings, so nothing
 *      else would notice.)
 *   3. `sortOrder` is a double: 0.1 + 0.2 comes back as 0.1 + 0.2.
 *   4. Comments and activity page by (createdAt, id): rows that share a
 *      millisecond — a bulk insert, an automation — are neither repeated nor
 *      dropped at a page boundary.
 *
 * Gated like every other `*.pg.test.ts`: real Postgres, RUN_PG_INTEGRATION=1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import * as pm from "../services/pm/pm.service.js";
import type { Page } from "../services/pm/pm-paging.js";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PM input validation against Postgres (WARP-3371)", () => {
  let prisma: PrismaClient;
  const WS = "warp3371v-ws";
  const USERS = { startsWith: "warp3371v-" } as const;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.pmWorkspace.deleteMany({ where: { slug: WS } });
    await prisma.user.deleteMany({ where: { username: USERS } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.pmWorkspace.deleteMany({ where: { slug: WS } });
    await prisma.user.deleteMany({ where: { username: USERS } });
  });

  const uniq = () => Math.random().toString(36).slice(2, 8).toUpperCase();

  async function project() {
    return pm.createProject(prisma, null, { workspaceSlug: WS, name: `warp3371v-${uniq()}`, identifier: `V${uniq()}` });
  }
  const item = (projectId: string, name: string, over: Partial<Parameters<typeof pm.createWorkItem>[3]> = {}) =>
    pm.createWorkItem(prisma, null, projectId, { name, ...over });
  const person = (name: string, role: "owner" | "admin" | "family" | "guest" | "service", status: "ACTIVE" | "DEACTIVATED" = "ACTIVE") =>
    prisma.user.create({
      data: { username: `warp3371v-${name}-${uniq()}`, displayName: name, role, directoryStatus: status },
    });
  const parentOf = async (id: string) => (await prisma.pmWorkItem.findUniqueOrThrow({ where: { id } })).parentId;
  const rejection = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error & { ids?: string[] });

  // ── parent cycles ────────────────────────────────────────────────────────

  describe("parent cycles", () => {
    it("refuses a descendant as the new parent, at any depth, and leaves the tree as it was", async () => {
      const p = await project();
      const a = await item(p.id, "a");
      const b = await item(p.id, "b", { parentId: a.id });
      const c = await item(p.id, "c", { parentId: b.id });

      for (const [child, parent] of [[a.id, b.id], [a.id, c.id], [b.id, c.id]] as const) {
        expect((await rejection(pm.updateWorkItem(prisma, null, child, { parentId: parent })))?.message).toBe("parent_cycle");
      }
      expect(await parentOf(a.id)).toBeNull();
      expect(await parentOf(b.id)).toBe(a.id);
      // a legitimate move is untouched
      await pm.updateWorkItem(prisma, null, c.id, { parentId: a.id });
      expect(await parentOf(c.id)).toBe(a.id);
    });

    it("two concurrent re-parents that would together close a loop cannot both win", async () => {
      const p = await project();
      for (let round = 0; round < 8; round += 1) {
        const a = await item(p.id, `a${round}`);
        const b = await item(p.id, `b${round}`);
        const results = await Promise.allSettled([
          pm.updateWorkItem(prisma, null, a.id, { parentId: b.id }),
          pm.updateWorkItem(prisma, null, b.id, { parentId: a.id }),
        ]);
        const won = results.filter((r) => r.status === "fulfilled");
        expect(won, `round ${round}: both re-parents committed — a loop`).toHaveLength(1);
        // the loser is the cycle refusal (it saw the winner) or the serialization
        // loser (it did not) — never a raw database error
        const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(["parent_cycle", "concurrent_mutation"]).toContain((lost.reason as Error).message);
        // and the table holds no loop
        const [pa, pb] = [await parentOf(a.id), await parentOf(b.id)];
        expect(pa === b.id && pb === a.id).toBe(false);
      }
    });
  });

  // ── a work item keeps its state ──────────────────────────────────────────

  it("state_id:null is refused and the item keeps its column", async () => {
    const p = await project();
    const a = await item(p.id, "a");
    expect((await rejection(pm.updateWorkItem(prisma, null, a.id, { stateId: null })))?.message).toBe("state_required");
    expect((await prisma.pmWorkItem.findUniqueOrThrow({ where: { id: a.id } })).stateId).toBe(a.stateId);
  });

  // ── label ids ────────────────────────────────────────────────────────────

  describe("label ids", () => {
    it("an unknown id, and another project's, are refused with every offender named — never a foreign-key error", async () => {
      const p = await project();
      const other = await project();
      const mine = await prisma.pmLabel.create({ data: { projectId: p.id, name: "mine" } });
      const theirs = await prisma.pmLabel.create({ data: { projectId: other.id, name: "theirs" } });
      const ghost = "00000000-0000-4000-8000-0000000000aa";

      const onCreate = await rejection(item(p.id, "x", { labelIds: [mine.id, ghost, theirs.id] }));
      expect(onCreate?.message).toBe("invalid_label");
      expect((onCreate as { ids?: string[] }).ids).toEqual([ghost, theirs.id]);
      expect(await prisma.pmWorkItem.count({ where: { projectId: p.id } })).toBe(0);

      const a = await item(p.id, "a");
      const onUpdate = await rejection(pm.updateWorkItem(prisma, null, a.id, { labelIds: [ghost] }));
      expect(onUpdate?.message).toBe("invalid_label");
      expect((onUpdate as { ids?: string[] }).ids).toEqual([ghost]);
    });

    it("a repeated id is folded into one row", async () => {
      const p = await project();
      const mine = await prisma.pmLabel.create({ data: { projectId: p.id, name: "mine" } });
      const a = await item(p.id, "a", { labelIds: [mine.id, mine.id] });
      expect(a.labels).toHaveLength(1);
    });
  });

  // ── assignee ids ─────────────────────────────────────────────────────────

  describe("assignee ids", () => {
    it("only active people can be assigned: a ghost, a leaver and a service principal are named; an external guest is allowed", async () => {
      const p = await project();
      const ana = await person("ana", "family");
      const gus = await person("gus", "guest");
      const leaver = await person("olga", "family", "DEACTIVATED");
      const machine = await person("mcp", "service");

      const bad = await rejection(item(p.id, "x", { assignees: [ana.id, "ghost", leaver.id, machine.id] }));
      expect(bad?.message).toBe("invalid_assignee");
      expect((bad as { ids?: string[] }).ids).toEqual(["ghost", leaver.id, machine.id]);
      expect(await prisma.pmWorkItem.count({ where: { projectId: p.id } })).toBe(0);

      const ok = await item(p.id, "ok", { assignees: [ana.id, gus.id, ana.id] });
      expect([...ok.assignees].sort()).toEqual([ana.id, gus.id].sort());
    });

    it("an update checks only who it ADDS: a set still holding a leaver stays editable, and the leaver can be removed", async () => {
      const p = await project();
      const ana = await person("ana", "family");
      const gus = await person("gus", "guest");
      const a = await item(p.id, "a", { assignees: [ana.id] });
      await prisma.user.update({ where: { id: ana.id }, data: { directoryStatus: "DEACTIVATED" } });

      await expect(pm.updateWorkItem(prisma, null, a.id, { assignees: [ana.id], name: "renamed" })).resolves.toBeTruthy();
      expect((await rejection(pm.updateWorkItem(prisma, null, a.id, { assignees: [ana.id, "ghost"] })))?.message).toBe(
        "invalid_assignee",
      );
      const swapped = await pm.updateWorkItem(prisma, null, a.id, { assignees: [gus.id] });
      expect(swapped.assignees).toEqual([gus.id]);
    });
  });

  // ── sortOrder ────────────────────────────────────────────────────────────

  it("sortOrder is a double: the fractional values a drag inserts between two cards round-trip exactly", async () => {
    // "Exactly" within Prisma's own write precision: it serialises a Float with 16
    // significant digits (the same limit pm-paging's cursor and the activity
    // service's WARP-3011 note), so a value that needs 17 — 0.1 + 0.2 — is stored
    // as 0.3. Every value below has at most 15, which is what a midpoint between
    // two nearby cards is. A cursor is minted from the value READ back, so the
    // keyset compares what is stored with what is stored.
    const p = await project();
    const a = await item(p.id, "a");
    for (const value of [2.5, 2.75, 1.0009765625, 0.3, 1e-7, -3.25, 123456.789]) {
      const out = await pm.updateWorkItem(prisma, null, a.id, { sortOrder: value });
      expect(out.sortOrder).toBe(value);
      expect((await prisma.pmWorkItem.findUniqueOrThrow({ where: { id: a.id } })).sortOrder).toBe(value);
    }
    // …and what is stored is a fixed point of the round trip: reading it and
    // writing it back changes nothing, so a cursor built from it matches the row.
    const stored = await pm.updateWorkItem(prisma, null, a.id, { sortOrder: 0.1 + 0.2 });
    const again = await pm.updateWorkItem(prisma, null, a.id, { sortOrder: stored.sortOrder });
    expect(again.sortOrder).toBe(stored.sortOrder);
  });

  // ── comments and activity page by (createdAt, id) ────────────────────────

  describe("comments and activity pages", () => {
    it("rows that share a millisecond are neither repeated nor dropped at a boundary, and match Postgres's own order", async () => {
      const p = await project();
      const a = await item(p.id, "a");
      const same = new Date("2026-10-03T12:00:00.000Z");
      // 120 comments and 120 activity rows, three distinct instants: boundaries fall INSIDE ties.
      await prisma.pmComment.createMany({
        data: Array.from({ length: 120 }, (_, i) => ({
          workItemId: a.id,
          commentHtml: `<p>${i}</p>`,
          createdAt: new Date(same.getTime() + (i % 3) * 1000),
        })),
      });
      await prisma.pmActivity.createMany({
        data: Array.from({ length: 120 }, (_, i) => ({
          workItemId: a.id,
          verb: "updated" as const,
          field: `f${i}`,
          createdAt: new Date(same.getTime() + (i % 3) * 1000),
        })),
      });

      const dbOrder = async (table: "PmComment" | "PmActivity") =>
        (
          await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT "id" FROM "${table}" WHERE "workItemId" = $1 ORDER BY "createdAt" ASC, "id" ASC`,
            a.id,
          )
        ).map((r) => r.id);

      const walk = async (list: (cursor?: string) => Promise<Page<{ id: string }>>, expectedTotal: number) => {
        const ids: string[] = [];
        let cursor: string | undefined;
        let total = -1;
        do {
          const page = await list(cursor);
          total = page.total;
          ids.push(...page.items.map((r) => r.id));
          cursor = page.nextCursor ?? undefined;
          expect(ids.length).toBeLessThanOrEqual(240);
        } while (cursor);
        expect(total).toBe(expectedTotal);
        return ids;
      };

      const comments = await walk((cursor) => pm.listComments(prisma, a.id, { limit: 7, cursor }), 120);
      expect(comments).toHaveLength(120);
      expect(comments).toEqual(await dbOrder("PmComment"));

      // the item's own `created` row is the 121st row of its feed
      const activity = await walk((cursor) => pm.listActivity(prisma, a.id, { limit: 7, cursor }), 121);
      expect(activity).toHaveLength(121);
      expect(new Set(activity).size).toBe(121);
      expect(activity).toEqual(await dbOrder("PmActivity"));
    });
  });
});
