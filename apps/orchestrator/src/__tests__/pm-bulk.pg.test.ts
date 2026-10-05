/**
 * WARP-3537 — what the DATABASE does to a bulk edit.
 *
 * The claims, none of them provable against a mocked Prisma:
 *
 *   1. ALL OR NOTHING. A batch with one forbidden item, one item that is not a
 *      work item, one state from another project or one unknown label changes
 *      NOTHING — not the items before the bad one, not the activity feed. And a
 *      failure in the middle of the writes (here: the activity insert itself)
 *      rolls the earlier writes back, because the writes and their history share
 *      one transaction.
 *   2. ONE ACTIVITY ROW PER CHANGED FIELD PER ITEM, written in that transaction,
 *      none for a field an item already holds, with the old and new value true.
 *   3. THE COLUMNS FOLLOW: moving into a completed state stamps completion and
 *      moving out clears it (WARP-884), archive sets and clears archivedAt, a
 *      change that only touches a join table still moves updatedAt.
 *   4. THE PER-ITEM PERMISSION: a guest assigned to some items of a batch gets a
 *      403 listing the rest and nothing is written for the ones they could have.
 *   5. SCALE AND RACES: 500 items in one call, and two overlapping calls never
 *      leave a half-applied batch.
 *
 * Gated like every other `*.pg.test.ts`: real Postgres, RUN_PG_INTEGRATION=1.
 * Fixtures are namespaced `ws6b-`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import * as pm from "../services/pm/pm.service.js";
import {
  PM_BULK_ERRORS,
  PmBulkError,
  bulkUpdateWorkItems,
  type BulkActor,
} from "../services/pm/pm-bulk.service.js";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const PREFIX = "ws6b-";

describe.skipIf(!RUN)("PM bulk edit (WARP-3537)", () => {
  let prisma: PrismaClient;
  let owner: BulkActor;
  let guest: BulkActor;
  let other: BulkActor;
  let p1: string;
  let p2: string;
  const st1: Record<string, string> = {};
  const st2: Record<string, string> = {};
  let label1a: string;
  let label1b: string;
  let label2: string;
  let cycle1: string;
  let cycle2: string;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    await cleanup();

    const user = async (key: string, role: "owner" | "guest" | "family"): Promise<BulkActor> => {
      const u = await prisma.user.create({ data: { username: `${PREFIX}${key}`, displayName: key, role } });
      return { userId: u.id, role };
    };
    owner = await user("owner", "owner");
    guest = await user("guest", "guest");
    other = await user("other", "family");
    // Assignee ids name real active people, as the single-item and bulk
    // reference guards require; these fixtures are removed by cleanup().
    await prisma.user.createMany({
      data: ["a", "b", "c", "x", "z", "q"].map((key) => ({
        id: `${PREFIX}${key}`, username: `${PREFIX}${key}`, displayName: key,
        role: "family" as const, directoryStatus: "ACTIVE" as const,
      })),
    });

    const slug = `${PREFIX}ws`;
    const a = await pm.createProject(prisma, owner.userId, { workspaceSlug: slug, name: `${PREFIX}a`, identifier: "W6BA" });
    const b = await pm.createProject(prisma, owner.userId, { workspaceSlug: slug, name: `${PREFIX}b`, identifier: "W6BB" });
    p1 = a.id;
    p2 = b.id;
    for (const [pid, into] of [
      [p1, st1],
      [p2, st2],
    ] as const) {
      for (const s of await prisma.pmState.findMany({ where: { projectId: pid } })) into[s.name] = s.id;
    }
    label1a = (await prisma.pmLabel.create({ data: { projectId: p1, name: "bug" } })).id;
    label1b = (await prisma.pmLabel.create({ data: { projectId: p1, name: "docs" } })).id;
    label2 = (await prisma.pmLabel.create({ data: { projectId: p2, name: "bug" } })).id;
    cycle1 = (await prisma.pmCycle.create({ data: { projectId: p1, name: "Sprint 1" } })).id;
    cycle2 = (await prisma.pmCycle.create({ data: { projectId: p2, name: "Sprint 1" } })).id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup() {
    await prisma.pmWorkspace.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  }

  /** Activity rows that exist because an item was CREATED (`created`, and an `assigned` per
   *  assignee it was created with). Not what a bulk edit wrote, so `feed` leaves them out. */
  const baseline = new Set<string>();
  const mk = async (projectId: string, n: number, over: Partial<Parameters<typeof pm.createWorkItem>[3]> = {}) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      out.push((await pm.createWorkItem(prisma, owner.userId, projectId, { name: `${PREFIX}item ${i}`, ...over })).id);
    }
    for (const r of await prisma.pmActivity.findMany({ where: { workItemId: { in: out } }, select: { id: true } })) {
      baseline.add(r.id);
    }
    return out;
  };
  const rowsOf = (ids: string[]) =>
    prisma.pmWorkItem.findMany({
      where: { id: { in: ids } },
      include: { assignees: true, labels: true },
      orderBy: { sequenceId: "asc" },
    });
  /** What a bulk edit wrote to these items' history: everything except what creating them wrote. */
  const feed = async (ids: string[]) =>
    (
      await prisma.pmActivity.findMany({
        where: { workItemId: { in: ids } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    ).filter((r) => !baseline.has(r.id));
  const bulk = (ids: string[], patch: Parameters<typeof bulkUpdateWorkItems>[2]["patch"], actor: BulkActor = owner) =>
    bulkUpdateWorkItems(prisma, actor, { ids, patch });
  const refusal = async (p: Promise<unknown>): Promise<PmBulkError> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof PmBulkError) return e;
      throw e;
    }
    throw new Error("expected a PmBulkError, got a result");
  };

  // ── 2 + 3. activity and the columns that follow ─────────────────────────────

  describe("a change", () => {
    it("moves every item, writes one row per changed field per item, and returns the items in request order", async () => {
      const ids = await mk(p1, 3);
      const asked = [ids[2], ids[0], ids[1]];
      const res = await bulk(asked, { stateId: st1["In Progress"], priority: "high" });

      expect(res.changed).toBe(3);
      expect(res.work_items.map((w) => w.id)).toEqual(asked);
      expect(res.work_items.every((w) => w.state?.name === "In Progress" && w.priority === "high")).toBe(true);

      const rows = await rowsOf(ids);
      expect(rows.every((r) => r.stateId === st1["In Progress"] && r.priority === "high")).toBe(true);

      const history = await feed(ids);
      expect(history).toHaveLength(6);
      expect(history.filter((r) => r.verb === "state_changed")).toHaveLength(3);
      expect(history.filter((r) => r.verb === "updated" && r.field === "priority")).toHaveLength(3);
      for (const r of history) expect(r.actorId).toBe(owner.userId);
      const s = history.find((r) => r.verb === "state_changed")!;
      expect([s.field, s.oldValue, s.newValue]).toEqual(["state", st1["Todo"], st1["In Progress"]]);
      const p = history.find((r) => r.field === "priority")!;
      expect([p.oldValue, p.newValue]).toEqual(["none", "high"]);
    });

    it("writes nothing — no row, no updatedAt — for a field the item already holds", async () => {
      const ids = await mk(p1, 2);
      await bulk(ids, { priority: "low" });
      const before = await rowsOf(ids);
      const rowsBefore = (await feed(ids)).length;

      const res = await bulk(ids, { priority: "low" });
      expect(res.changed).toBe(0);
      expect(await feed(ids)).toHaveLength(rowsBefore);
      const after = await rowsOf(ids);
      expect(after.map((r) => r.updatedAt.getTime())).toEqual(before.map((r) => r.updatedAt.getTime()));
    });

    it("only the items that differ get a row when a batch is part-way there already", async () => {
      const ids = await mk(p1, 3);
      await bulk([ids[0]], { priority: "urgent" });
      const rowsBefore = (await feed(ids)).length;
      const res = await bulk(ids, { priority: "urgent" });
      expect(res.changed).toBe(2);
      expect((await feed(ids)).length - rowsBefore).toBe(2);
    });

    it("stamps completion going into a completed state and clears it coming out (WARP-884)", async () => {
      const ids = await mk(p1, 2);
      await bulk(ids, { stateId: st1["Done"] });
      let rows = await rowsOf(ids);
      expect(rows.every((r) => r.isCompleted && r.completedAt !== null)).toBe(true);

      await bulk(ids, { stateId: st1["In Progress"] });
      rows = await rowsOf(ids);
      expect(rows.every((r) => !r.isCompleted && r.completedAt === null)).toBe(true);

      await bulk(ids, { stateId: st1["Cancelled"] });
      rows = await rowsOf(ids);
      expect(rows.every((r) => r.isCompleted && r.completedAt !== null)).toBe(true);
    });

    it("replaces the assignees: adds who is new, removes who is gone, one row per person, none for an identical set", async () => {
      const ids = await mk(p1, 2, { assignees: ["ws6b-a", "ws6b-b"] });
      await bulk(ids, { assigneeIds: ["ws6b-b", "ws6b-c"] });

      const rows = await rowsOf(ids);
      for (const r of rows) expect(r.assignees.map((a) => a.userId).sort()).toEqual(["ws6b-b", "ws6b-c"]);
      const history = await feed(ids);
      expect(history.filter((r) => r.verb === "assigned").map((r) => r.newValue)).toEqual(["ws6b-c", "ws6b-c"]);
      expect(history.filter((r) => r.verb === "unassigned").map((r) => r.oldValue)).toEqual(["ws6b-a", "ws6b-a"]);

      const before = history.length;
      const res = await bulk(ids, { assigneeIds: ["ws6b-c", "ws6b-b"] });
      expect(res.changed).toBe(0);
      expect(await feed(ids)).toHaveLength(before);

      await bulk(ids, { assigneeIds: [] });
      expect((await rowsOf(ids)).every((r) => r.assignees.length === 0)).toBe(true);
    });

    it("adds and removes labels as a delta, tolerating one already there", async () => {
      const ids = await mk(p1, 2, { labelIds: [label1a] });
      await bulk(ids, { addLabelIds: [label1a, label1b] });
      let rows = await rowsOf(ids);
      for (const r of rows) expect(r.labels.map((l) => l.labelId).sort()).toEqual([label1a, label1b].sort());
      // label1a was already there: only label1b is a change.
      const added = (await feed(ids)).filter((r) => r.verb === "label_added");
      expect(added.map((r) => r.newValue)).toEqual([label1b, label1b]);

      await bulk([ids[0]], { removeLabelIds: [label1a] });
      rows = await rowsOf(ids);
      expect(rows[0].labels.map((l) => l.labelId)).toEqual([label1b]);
      expect(rows[1].labels).toHaveLength(2);
      expect((await feed(ids)).filter((r) => r.verb === "label_removed").map((r) => r.oldValue)).toEqual([label1a]);
    });

    it("moves items into a cycle (naming the one they left), and out again with null", async () => {
      const ids = await mk(p1, 2);
      await prisma.pmWorkItem.update({ where: { id: ids[1] }, data: { cycleId: cycle1 } });
      const other1 = (await prisma.pmCycle.create({ data: { projectId: p1, name: "Sprint 2" } })).id;

      await bulk(ids, { cycleId: other1 });
      expect((await rowsOf(ids)).map((r) => r.cycleId)).toEqual([other1, other1]);
      // Rows of one batch share a timestamp, so their order among themselves is not
      // a claim: read them by item.
      const added = new Map((await feed(ids)).filter((r) => r.verb === "cycle_added").map((r) => [r.workItemId, r]));
      expect([added.get(ids[0])!.oldValue, added.get(ids[0])!.newValue]).toEqual([null, other1]);
      expect([added.get(ids[1])!.oldValue, added.get(ids[1])!.newValue]).toEqual([cycle1, other1]);

      await bulk(ids, { cycleId: null });
      expect((await rowsOf(ids)).map((r) => r.cycleId)).toEqual([null, null]);
      expect((await feed(ids)).filter((r) => r.verb === "cycle_removed").map((r) => r.oldValue)).toEqual([other1, other1]);
    });

    it("archives and restores, with archivedAt following the flag", async () => {
      const ids = await mk(p1, 2);
      await bulk(ids, { isArchived: true });
      let rows = await rowsOf(ids);
      expect(rows.every((r) => r.isArchived && r.archivedAt !== null)).toBe(true);
      expect((await feed(ids)).filter((r) => r.verb === "archived")).toHaveLength(2);

      await bulk(ids, { isArchived: false });
      rows = await rowsOf(ids);
      expect(rows.every((r) => !r.isArchived && r.archivedAt === null)).toBe(true);
      expect((await feed(ids)).filter((r) => r.verb === "restored")).toHaveLength(2);
    });

    it("moves updatedAt for an item that only changed through a join table", async () => {
      const ids = await mk(p1, 1);
      const [before] = await rowsOf(ids);
      await new Promise((r) => setTimeout(r, 15));
      await bulk(ids, { assigneeIds: ["ws6b-x"] });
      const [after] = await rowsOf(ids);
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    });

    it("treats a repeated id as one item", async () => {
      const ids = await mk(p1, 1);
      const res = await bulk([ids[0], ids[0], ids[0]], { priority: "high" });
      expect(res.work_items).toHaveLength(1);
      expect(await feed(ids)).toHaveLength(1);
    });
  });

  // ── 1. all or nothing ───────────────────────────────────────────────────────

  describe("a refusal changes nothing", () => {
    async function untouched(ids: string[], rowsBefore: Awaited<ReturnType<typeof rowsOf>>) {
      const after = await rowsOf(ids);
      expect(after.map((r) => [r.stateId, r.priority, r.cycleId, r.isArchived, r.updatedAt.getTime()])).toEqual(
        rowsBefore.map((r) => [r.stateId, r.priority, r.cycleId, r.isArchived, r.updatedAt.getTime()]),
      );
      expect(await feed(ids)).toHaveLength(0);
    }

    it("refuses unknown, deactivated and service assignees before changing any item or history", async () => {
      const leaver = await prisma.user.create({
        data: { username: `${PREFIX}leaver`, displayName: "Leaver", role: "family", directoryStatus: "DEACTIVATED" },
      });
      const machine = await prisma.user.create({
        data: { username: `${PREFIX}machine`, displayName: "Machine", role: "service" },
      });
      const ids = await mk(p1, 2);
      const before = await rowsOf(ids);
      await expect(bulk(ids, { assigneeIds: ["ws6b-a", "missing", leaver.id, machine.id], priority: "high" }))
        .rejects.toMatchObject({ message: "invalid_assignee", ids: ["missing", leaver.id, machine.id] });
      await untouched(ids, before);
      expect((await rowsOf(ids)).every((r) => r.assignees.length === 0)).toBe(true);
    });

    it("can retain an existing leaver while editing another field, then remove them", async () => {
      const person = await prisma.user.create({
        data: { username: `${PREFIX}retained-leaver`, displayName: "Retained leaver", role: "family" },
      });
      const ids = await mk(p1, 2, { assignees: [person.id] });
      await prisma.user.update({ where: { id: person.id }, data: { directoryStatus: "DEACTIVATED" } });
      await expect(bulk(ids, { assigneeIds: [person.id], priority: "high" })).resolves.toMatchObject({ changed: 2 });
      for (const row of await rowsOf(ids)) expect(row.assignees.map((a) => a.userId)).toEqual([person.id]);
      await bulk(ids, { assigneeIds: [] });
      expect((await rowsOf(ids)).every((r) => r.assignees.length === 0)).toBe(true);
    });

  it("404 work_item_not_found: an id that is not a work item sinks the batch, and is named", async () => {
      const ids = await mk(p1, 2);
      const before = await rowsOf(ids);
      const err = await refusal(bulk([ids[0], "no-such-id", ids[1]], { priority: "high" }));
      expect(err.code).toBe("work_item_not_found");
      expect(err.ids).toEqual(["no-such-id"]);
    await untouched(ids, before);
  });

  it("treats a service-desk ticket id as missing before planning or writing", async () => {
    const workspace = await prisma.pmWorkspace.findUniqueOrThrow({ where: { slug: `${PREFIX}ws` } });
    const desk = await prisma.pmProject.create({
      data: { workspaceId: workspace.id, name: `${PREFIX}desk`, identifier: "W6BD", kind: "SERVICE_DESK" },
    });
    const ticketItem = await prisma.pmWorkItem.create({
      data: { projectId: desk.id, sequenceId: 1, name: `${PREFIX}ticket` },
    });
    await prisma.pmTicket.create({
      data: {
        workItemId: ticketItem.id,
        requesterKind: "USER",
        requesterUserId: `${PREFIX}requester`,
        requesterName: `${PREFIX}requester`,
        channel: "INTERNAL",
      } as never,
    });

    const err = await refusal(bulk([ticketItem.id], { priority: "high" }));
    expect(err.code).toBe("work_item_not_found");
    expect(err.ids).toEqual([ticketItem.id]);
    expect((await prisma.pmWorkItem.findUniqueOrThrow({ where: { id: ticketItem.id } })).priority).toBe("none");
  });

    it("422 invalid_state: a state from another project sinks the batch, and names the items it does not fit", async () => {
      const a = await mk(p1, 2);
      const b = await mk(p2, 1);
      const before = await rowsOf([...a, ...b]);
      const err = await refusal(bulk([...a, ...b], { stateId: st1["Done"], priority: "high" }));
      expect(err.code).toBe("invalid_state");
      expect(err.ids).toEqual(b);
      await untouched([...a, ...b], before);
    });

    it("404 state_not_found / label_not_found / cycle_not_found", async () => {
      const ids = await mk(p1, 1);
      const before = await rowsOf(ids);
      expect((await refusal(bulk(ids, { stateId: "gone", priority: "high" }))).code).toBe("state_not_found");
      expect((await refusal(bulk(ids, { addLabelIds: [label1a, "gone"], priority: "high" }))).code).toBe("label_not_found");
      expect((await refusal(bulk(ids, { cycleId: "gone", priority: "high" }))).code).toBe(PM_BULK_ERRORS.CYCLE_NOT_FOUND);
      await untouched(ids, before);
    });

    it("422 invalid_label / invalid_cycle: another project's label or cycle", async () => {
      const ids = await mk(p1, 2);
      const before = await rowsOf(ids);
      const l = await refusal(bulk(ids, { addLabelIds: [label2], priority: "high" }));
      expect(l.code).toBe("invalid_label");
      expect(l.ids).toEqual(ids);
      const c = await refusal(bulk(ids, { cycleId: cycle2, priority: "high" }));
      expect(c.code).toBe(PM_BULK_ERRORS.INVALID_CYCLE);
      expect(c.ids).toEqual(ids);
      await untouched(ids, before);
    });

    it("rolls the item writes back when the activity insert itself fails — the history shares the transaction", async () => {
      const ids = await mk(p1, 3);
      const before = await rowsOf(ids);
      const failing = prisma.$extends({
        query: {
          pmActivity: {
            createMany() {
              throw new Error("activity insert failed");
            },
          },
        },
      }) as unknown as PrismaClient;

      await expect(
        bulkUpdateWorkItems(failing, owner, {
          ids,
          patch: { stateId: st1["Done"], priority: "urgent", assigneeIds: ["ws6b-z"], addLabelIds: [label1a], isArchived: true },
        }),
      ).rejects.toThrow(/activity insert failed/);

      const after = await rowsOf(ids);
      expect(after.map((r) => [r.stateId, r.priority, r.isArchived, r.isCompleted, r.assignees.length, r.labels.length])).toEqual(
        before.map((r) => [r.stateId, r.priority, r.isArchived, r.isCompleted, r.assignees.length, r.labels.length]),
      );
      expect(await feed(ids)).toHaveLength(0);
    });
  });

  // ── 4. the per-item permission ──────────────────────────────────────────────

  describe("the per-item permission", () => {
    it("403 work_items_forbidden lists EVERY item the caller may not touch, and writes nothing for the ones they could", async () => {
      const mine = await mk(p1, 2, { assignees: [guest.userId] });
      const notMine = await mk(p1, 2);
      const asked = [mine[0], notMine[0], mine[1], notMine[1]];
      const before = await rowsOf(asked);

      const err = await refusal(bulk(asked, { stateId: st1["Done"] }, guest));
      expect(err.code).toBe(PM_BULK_ERRORS.FORBIDDEN);
      expect(err.ids).toEqual([notMine[0], notMine[1]]);

      const after = await rowsOf(asked);
      expect(after.map((r) => r.stateId)).toEqual(before.map((r) => r.stateId));
      expect(await feed(asked)).toHaveLength(0);
    });

    it("lets a guest move the state of a batch that is ALL theirs — the share, and nothing past it", async () => {
      const mine = await mk(p1, 2, { assignees: [guest.userId] });
      const res = await bulk(mine, { stateId: st1["Done"] }, guest);
      expect(res.changed).toBe(2);
      expect((await rowsOf(mine)).every((r) => r.stateId === st1["Done"])).toBe(true);
      expect((await feed(mine)).every((r) => r.actorId === guest.userId)).toBe(true);
    });

    it("refuses a guest any other field, even on items assigned to them", async () => {
      const mine = await mk(p1, 2, { assignees: [guest.userId] });
      const err = await refusal(bulk(mine, { priority: "urgent" }, guest));
      expect(err.code).toBe(PM_BULK_ERRORS.FORBIDDEN);
      expect(err.ids).toEqual(mine);
      expect((await rowsOf(mine)).every((r) => r.priority === "none")).toBe(true);
    });

    it("tells a guest nothing about which ids exist: an unknown id is forbidden to them, not 'not found'", async () => {
      const mine = await mk(p1, 1, { assignees: [guest.userId] });
      const err = await refusal(bulk([mine[0], "no-such-id"], { stateId: st1["Done"] }, guest));
      expect(err.code).toBe(PM_BULK_ERRORS.FORBIDDEN);
      expect(err.ids).toEqual(["no-such-id"]);
    });

    it("an owner and a family member may touch every item", async () => {
      const ids = await mk(p1, 2, { assignees: [guest.userId] });
      expect((await bulk(ids, { priority: "low" }, other)).changed).toBe(2);
      expect((await bulk(ids, { priority: "high" }, owner)).changed).toBe(2);
    });
  });

  // ── 5. scale and races ──────────────────────────────────────────────────────

  describe("scale and races", () => {
    it("changes 500 items in one call, with one row each — inside the transaction budget", async () => {
      const base = 10_000;
      await prisma.pmWorkItem.createMany({
        data: Array.from({ length: 500 }, (_, i) => ({
          projectId: p1,
          sequenceId: base + i,
          name: `${PREFIX}bulk ${i}`,
          stateId: st1["Todo"],
          sortOrder: i,
        })),
      });
      const ids = (await prisma.pmWorkItem.findMany({ where: { projectId: p1, sequenceId: { gte: base } }, select: { id: true } })).map(
        (r) => r.id,
      );
      expect(ids).toHaveLength(500);

      const started = Date.now();
      const res = await bulk(ids, { stateId: st1["Done"], priority: "high", addLabelIds: [label1a], assigneeIds: ["ws6b-q"] });
      expect(Date.now() - started).toBeLessThan(4000);
      expect(res.changed).toBe(500);
      expect(res.work_items).toHaveLength(500);
      // state + priority + one label + one assignee = four rows per item.
      expect(await prisma.pmActivity.count({ where: { workItemId: { in: ids }, NOT: { verb: "created" } } })).toBe(2000);
    }, 30_000);

    it("two overlapping calls never leave a half-applied batch: each applies whole, or says 409 and applied nothing", async () => {
      const ids = await mk(p1, 25);
      const results = await Promise.allSettled([
        bulk(ids, { priority: "high", stateId: st1["In Progress"] }),
        bulk(ids, { priority: "low", stateId: st1["Done"] }),
      ]);
      for (const r of results) {
        if (r.status === "rejected") expect((r.reason as Error).message).toBe("concurrent_mutation");
      }
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);

      const rows = await rowsOf(ids);
      // Whichever won, the batch is one thing: uniform, never mixed.
      expect(new Set(rows.map((r) => `${r.priority}/${r.stateId}`)).size).toBe(1);
      // And the history is the committed history: no row for a change that rolled back.
      const per = new Map<string, number>();
      for (const r of await feed(ids)) per.set(r.workItemId, (per.get(r.workItemId) ?? 0) + 1);
      const winners = results.filter((r) => r.status === "fulfilled").length;
      for (const id of ids) expect(per.get(id)).toBe(2 * winners);
    });
  });
});
