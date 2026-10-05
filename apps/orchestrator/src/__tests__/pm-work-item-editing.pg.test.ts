/**
 * WARP-3520 (ADR-069 WS-4) — what the DATABASE does underneath the editing
 * surfaces of work items and states.
 *
 * A mocked Prisma cannot prove any of these, and each one is the kind of thing
 * that passes a unit test and fails on a box:
 *
 *   * Setting a state as the default swaps under the REAL partial unique index
 *     `PmState_projectId_isDefault_key` (one default per project). Set-then-unset
 *     would violate it; the order in the service is the whole feature.
 *   * Deleting a state moves its items to the chosen state and re-syncs
 *     `isCompleted` / `completedAt` when terminal-ness differs — a join the
 *     in-memory fake does not model.
 *   * Archive is `UPDATE ... WHERE isArchived = false` and branches on the row
 *     count, so two concurrent archives write ONE activity row (P1: a
 *     findUnique-then-update would write two).
 *   * The parent-cycle walk reads real ancestor chains, and the database trigger
 *     `pmworkitem_parent_same_project` is still in force beneath it.
 *   * One edit writes one activity row: a start-date change names itself
 *     (`start_date_changed`) and no longer leaks into the residual `updated` row.
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

describe.skipIf(!RUN)("PM work-item editing — the database's own guarantees (WARP-3520)", () => {
  let prisma: PrismaClient;

  // Every fixture is namespaced `warp3520a-`: the pg-gated suites share one
  // throwaway database and run in the same lane.
  const OURS = { startsWith: "warp3520a-" } as const;
  const WS = `warp3520a-ws-${process.pid}`;

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

  let projectId = "";
  let identifier = "";
  let states: Record<string, { id: string }> = {};
  let nth = 0;

  beforeEach(async () => {
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    nth += 1;
    identifier = `W35A${nth}`;
    const project = await pm.createProject(prisma, null, {
      workspaceSlug: WS,
      name: `warp3520a-alpha-${nth}`,
      identifier,
    });
    projectId = project.id;
    // The five seeded states, by name: Backlog / Todo (default) / In Progress / Done / Cancelled.
    states = Object.fromEntries((await pm.listStates(prisma, projectId)).map((s) => [s.name, { id: s.id }]));
  });

  const make = (name: string, input: Partial<Parameters<typeof pm.createWorkItem>[3]> = {}) =>
    pm.createWorkItem(prisma, null, projectId, { name: `warp3520a-${name}`, ...input });

  const activity = (workItemId: string) =>
    prisma.pmActivity.findMany({ where: { workItemId }, orderBy: { createdAt: "asc" } });
  const verbs = async (workItemId: string) => (await activity(workItemId)).map((a) => a.verb);

  // ── states: default ──────────────────────────────────────────────────────

  describe("set default", () => {
    const defaults = () => prisma.pmState.findMany({ where: { projectId, isDefault: true } });

    it("swaps the default atomically — exactly one default before, during and after", async () => {
      expect((await defaults()).map((s) => s.name)).toEqual(["Todo"]);
      const updated = await pm.updateState(prisma, states["In Progress"].id, { isDefault: true });
      expect(updated.isDefault).toBe(true);
      expect((await defaults()).map((s) => s.name)).toEqual(["In Progress"]);
    });

    it("is idempotent for the state that already is the default", async () => {
      await expect(pm.updateState(prisma, states.Todo.id, { isDefault: true })).resolves.toMatchObject({
        isDefault: true,
      });
      expect(await defaults()).toHaveLength(1);
    });

    it("needs the old default unset FIRST — the partial unique index refuses two", async () => {
      // Proves the ordering in updateState matters: a naive set-then-unset hits this.
      await expect(
        prisma.pmState.update({ where: { id: states["In Progress"].id }, data: { isDefault: true } }),
      ).rejects.toThrow();
    });

    it("refuses a done or cancelled state as the default, and changes nothing", async () => {
      for (const name of ["Done", "Cancelled"]) {
        await expect(pm.updateState(prisma, states[name].id, { isDefault: true })).rejects.toThrow(
          "state_default_terminal",
        );
      }
      // …including a state that is being MOVED to a terminal group in the same request.
      await expect(
        pm.updateState(prisma, states["In Progress"].id, { isDefault: true, group: "completed" }),
      ).rejects.toThrow("state_default_terminal");
      expect((await defaults()).map((s) => s.name)).toEqual(["Todo"]);
    });

    it("lets the OLD default be deleted once another state has taken over", async () => {
      await expect(pm.deleteState(prisma, states.Todo.id)).rejects.toThrow("state_is_default");
      await pm.updateState(prisma, states["In Progress"].id, { isDefault: true });
      await expect(pm.deleteState(prisma, states.Todo.id)).resolves.toBeUndefined();
    });
  });

  // ── states: delete with reassign ─────────────────────────────────────────

  describe("delete with reassign", () => {
    it("moves the items to the CHOSEN state and re-syncs completion when terminal-ness differs", async () => {
      const done = await make("done-item", { stateId: states.Done.id });
      expect(done.state?.group).toBe("completed");
      const row = await prisma.pmWorkItem.findUniqueOrThrow({ where: { id: done.id } });
      expect(row.isCompleted).toBe(true);
      expect(row.completedAt).not.toBeNull();

      await pm.deleteState(prisma, states.Done.id, { reassignTo: states["In Progress"].id });

      const moved = await prisma.pmWorkItem.findUniqueOrThrow({ where: { id: done.id } });
      expect(moved.stateId).toBe(states["In Progress"].id);
      // Landing in a started state un-completes it, in the same transaction.
      expect(moved.isCompleted).toBe(false);
      expect(moved.completedAt).toBeNull();
      expect(await prisma.pmState.findUnique({ where: { id: states.Done.id } })).toBeNull();
    });

    it("keeps a completed item completed when it lands in another terminal state", async () => {
      const done = await make("done-item", { stateId: states.Done.id });
      await pm.deleteState(prisma, states.Done.id, { reassignTo: states.Cancelled.id });
      const moved = await prisma.pmWorkItem.findUniqueOrThrow({ where: { id: done.id } });
      expect(moved.stateId).toBe(states.Cancelled.id);
      expect(moved.isCompleted).toBe(true);
    });

    it("without reassignTo, items land in the project's default state as before", async () => {
      const item = await make("started-item", { stateId: states["In Progress"].id });
      await pm.deleteState(prisma, states["In Progress"].id);
      const moved = await prisma.pmWorkItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(moved.stateId).toBe(states.Todo.id);
    });

    it("refuses a target that is the deleted state, missing, or in another project", async () => {
      const other = await pm.createProject(prisma, null, {
        workspaceSlug: WS,
        name: `warp3520a-other-${nth}`,
        identifier: `W35O${nth}`,
      });
      const foreign = (await pm.listStates(prisma, other.id))[0];
      await expect(pm.deleteState(prisma, states.Backlog.id, { reassignTo: states.Backlog.id })).rejects.toThrow(
        "invalid_state",
      );
      await expect(pm.deleteState(prisma, states.Backlog.id, { reassignTo: foreign.id })).rejects.toThrow(
        "invalid_state",
      );
      await expect(pm.deleteState(prisma, states.Backlog.id, { reassignTo: "does-not-exist" })).rejects.toThrow(
        "state_not_found",
      );
      // None of the refusals deleted anything.
      expect(await prisma.pmState.findUnique({ where: { id: states.Backlog.id } })).not.toBeNull();
    });

    it("still refuses to delete the default state and the last state", async () => {
      await expect(pm.deleteState(prisma, states.Todo.id, { reassignTo: states.Backlog.id })).rejects.toThrow(
        "state_is_default",
      );
      for (const name of ["Backlog", "In Progress", "Done"]) await pm.deleteState(prisma, states[name].id);
      await pm.deleteState(prisma, states.Cancelled.id);
      await expect(pm.deleteState(prisma, states.Todo.id)).rejects.toThrow("state_is_last");
    });
  });

  // ── states: reorder ──────────────────────────────────────────────────────

  describe("reorder", () => {
    const order = async () => (await pm.listStates(prisma, projectId)).map((s) => s.name);

    it("writes sortOrder = index for every state in one go", async () => {
      const reversed = (await pm.listStates(prisma, projectId)).map((s) => s.id).reverse();
      const result = await pm.reorderStates(prisma, projectId, reversed);
      expect(result.map((s) => s.sortOrder)).toEqual([0, 1, 2, 3, 4]);
      expect(await order()).toEqual(["Cancelled", "Done", "In Progress", "Todo", "Backlog"]);
    });

    it("refuses a list that is partial, duplicated or foreign — and writes nothing", async () => {
      const before = await order();
      const ids = (await pm.listStates(prisma, projectId)).map((s) => s.id);
      for (const bad of [ids.slice(1), [...ids, ids[0]], [...ids.slice(1), "not-a-state"], []]) {
        await expect(pm.reorderStates(prisma, projectId, bad)).rejects.toThrow("invalid_order");
      }
      expect(await order()).toEqual(before);
    });

    it("is a project_not_found for a missing project", async () => {
      await expect(pm.reorderStates(prisma, "nope", ["a"])).rejects.toThrow("project_not_found");
    });
  });

  // ── archive / restore ────────────────────────────────────────────────────

  describe("archive / restore", () => {
    it("hides the item from the live list and keeps it in the Archived list", async () => {
      const keep = await make("keep");
      const gone = await make("gone");

      const archived = await pm.archiveWorkItem(prisma, "u1", gone.id);
      expect(archived.isArchived).toBe(true);
      expect(archived.archivedAt).not.toBeNull();

      expect((await pm.listWorkItems(prisma, projectId)).items.map((i) => i.id)).toEqual([keep.id]);
      expect((await pm.listWorkItems(prisma, projectId, { archived: "only" })).items.map((i) => i.id)).toEqual([gone.id]);
      // Archived work is out of the counts and the search too.
      expect(await pm.searchWorkItems(prisma, { q: "warp3520a-gone" })).toMatchObject({ items: [], total: 0, nextCursor: null });
      // …but still readable by id: the Archived list and an old link need it.
      expect((await pm.getWorkItem(prisma, gone.id)).isArchived).toBe(true);
    });

    it("orders the Archived list newest-archived first", async () => {
      const a = await make("a");
      const b = await make("b");
      await pm.archiveWorkItem(prisma, null, a.id);
      await new Promise((r) => setTimeout(r, 15));
      await pm.archiveWorkItem(prisma, null, b.id);
      expect((await pm.listWorkItems(prisma, projectId, { archived: "only" })).items.map((i) => i.id)).toEqual([b.id, a.id]);
    });

    it("pages tied archive instants and legacy missing instants without losing or repeating an item", async () => {
      const recent = [await make("archive-a"), await make("archive-b")];
      const legacy = [await make("legacy-a"), await make("legacy-b")];
      await prisma.pmWorkItem.updateMany({
        where: { id: { in: recent.map((i) => i.id) } },
        data: { isArchived: true, archivedAt: new Date("2026-10-04T12:00:00.000Z") },
      });
      await prisma.pmWorkItem.updateMany({
        where: { id: { in: legacy.map((i) => i.id) } },
        data: { isArchived: true, archivedAt: null },
      });
      const expected = [...recent.map((i) => i.id).sort(), ...legacy.map((i) => i.id).sort()];
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let n = 0; n < expected.length; n++) {
        const page = await pm.listWorkItems(prisma, projectId, { archived: "only", limit: 1, cursor });
        expect(page.total).toBe(4);
        expect(page.items).toHaveLength(1);
        seen.push(page.items[0].id);
        expect(page.nextCursor).toEqual(n === expected.length - 1 ? null : expect.any(String));
        cursor = page.nextCursor ?? undefined;
      }
      expect(seen).toEqual(expected);
    });

    it("restores, clearing archivedAt", async () => {
      const item = await make("round-trip");
      await pm.archiveWorkItem(prisma, null, item.id);
      const restored = await pm.restoreWorkItem(prisma, null, item.id);
      expect(restored.isArchived).toBe(false);
      expect(restored.archivedAt).toBeNull();
      expect((await pm.listWorkItems(prisma, projectId)).items.map((i) => i.id)).toEqual([item.id]);
    });

    it("answers 409-class codes for a no-op and 404 for a missing item", async () => {
      const item = await make("twice");
      await expect(pm.restoreWorkItem(prisma, null, item.id)).rejects.toThrow("work_item_not_archived");
      await pm.archiveWorkItem(prisma, null, item.id);
      await expect(pm.archiveWorkItem(prisma, null, item.id)).rejects.toThrow("work_item_archived");
      await expect(pm.archiveWorkItem(prisma, null, "nope")).rejects.toThrow("work_item_not_found");
      await expect(pm.restoreWorkItem(prisma, null, "nope")).rejects.toThrow("work_item_not_found");
    });

    it("writes one archived / restored activity row per event", async () => {
      const item = await make("audited");
      await pm.archiveWorkItem(prisma, "u1", item.id);
      await pm.restoreWorkItem(prisma, "u1", item.id);
      expect(await verbs(item.id)).toEqual(["created", "archived", "restored"]);
    });

    it("two concurrent archives write ONE row — the state check is in the write (P1)", async () => {
      const item = await make("raced");
      const results = await Promise.allSettled([
        pm.archiveWorkItem(prisma, "u1", item.id),
        pm.archiveWorkItem(prisma, "u2", item.id),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect((loser.reason as Error).message).toBe("work_item_archived");
      expect((await verbs(item.id)).filter((v) => v === "archived")).toHaveLength(1);
    });
  });

  // ── parent cycles ────────────────────────────────────────────────────────

  describe("parent cycles", () => {
    it("refuses a loop of any length and leaves the tree untouched", async () => {
      const a = await make("a");
      const b = await make("b", { parentId: a.id });
      const c = await make("c", { parentId: b.id });

      await expect(pm.updateWorkItem(prisma, null, a.id, { parentId: c.id })).rejects.toThrow("parent_cycle");
      await expect(pm.updateWorkItem(prisma, null, a.id, { parentId: b.id })).rejects.toThrow("parent_cycle");
      await expect(pm.updateWorkItem(prisma, null, b.id, { parentId: c.id })).rejects.toThrow("parent_cycle");
      expect((await pm.getWorkItem(prisma, a.id)).parentId).toBeNull();
    });

    it("still refuses self-parenting and a parent in another project with the old codes", async () => {
      const a = await make("a");
      await expect(pm.updateWorkItem(prisma, null, a.id, { parentId: a.id })).rejects.toThrow("invalid_parent");
      const other = await pm.createProject(prisma, null, {
        workspaceSlug: WS,
        name: `warp3520a-other-${nth}`,
        identifier: `W35O${nth}`,
      });
      const foreign = await pm.createWorkItem(prisma, null, other.id, { name: "warp3520a-foreign" });
      await expect(pm.updateWorkItem(prisma, null, a.id, { parentId: foreign.id })).rejects.toThrow(
        "invalid_parent",
      );
    });

    it("allows re-parenting down, flattening and clearing", async () => {
      const a = await make("a");
      const b = await make("b", { parentId: a.id });
      const c = await make("c", { parentId: b.id });
      // Move c up to a (flatten), then clear b.
      expect((await pm.updateWorkItem(prisma, null, c.id, { parentId: a.id })).parentId).toBe(a.id);
      expect((await pm.updateWorkItem(prisma, null, b.id, { parentId: null })).parentId).toBeNull();
      // Re-sending the current parent is fine.
      expect((await pm.updateWorkItem(prisma, null, c.id, { parentId: a.id })).parentId).toBe(a.id);
    });

    it("fails closed on a chain longer than the walk bound", async () => {
      const outsider = await make("outsider");
      let parent = (await make("link-0")).id;
      for (let i = 1; i <= 55; i += 1) parent = (await make(`link-${i}`, { parentId: parent })).id;
      // The outsider is not in that chain, but the chain is too long to prove it.
      await expect(pm.updateWorkItem(prisma, null, outsider.id, { parentId: parent })).rejects.toThrow(
        "parent_cycle",
      );
    });
  });

  // ── type / estimate / dates: one edit, one row ───────────────────────────

  describe("type, estimate and start date", () => {
    it("creates with a type and an estimate and writes only `created`", async () => {
      const item = await make("typed", { type: "incident", estimate: 8 });
      expect(item.type).toBe("incident");
      expect(item.estimate).toBe(8);
      expect(await verbs(item.id)).toEqual(["created"]);
    });

    it("defaults to a task with no estimate", async () => {
      const item = await make("plain");
      expect(item.type).toBe("task");
      expect(item.estimate).toBeNull();
    });

    it("writes type_changed once per change, and nothing for an identity write", async () => {
      const item = await make("kind");
      await pm.updateWorkItem(prisma, "u1", item.id, { type: "bug" });
      await pm.updateWorkItem(prisma, "u1", item.id, { type: "bug" });
      const rows = (await activity(item.id)).filter((a) => a.verb === "type_changed");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ field: "type", oldValue: "task", newValue: "bug", actorId: "u1" });
    });

    it("sets, changes and clears the estimate, recording each", async () => {
      const item = await make("sized");
      await pm.updateWorkItem(prisma, null, item.id, { estimate: 3 });
      await pm.updateWorkItem(prisma, null, item.id, { estimate: 5 });
      expect((await pm.updateWorkItem(prisma, null, item.id, { estimate: null })).estimate).toBeNull();
      const rows = (await activity(item.id)).filter((a) => a.verb === "estimate_changed");
      expect(rows.map((r) => [r.oldValue, r.newValue])).toEqual([
        [null, "3"],
        ["3", "5"],
        ["5", null],
      ]);
      // A patch that does not mention the estimate leaves it alone.
      await pm.updateWorkItem(prisma, null, item.id, { estimate: 2 });
      expect((await pm.updateWorkItem(prisma, null, item.id, { name: "warp3520a-renamed" })).estimate).toBe(2);
    });

    it("names a start-date change and does NOT also write the residual `updated` row", async () => {
      const item = await make("dated");
      const start = new Date("2026-10-04T00:00:00.000Z");
      await pm.updateWorkItem(prisma, "u1", item.id, { startDate: start });
      await pm.updateWorkItem(prisma, "u1", item.id, { startDate: start });
      await pm.updateWorkItem(prisma, "u1", item.id, { startDate: null });
      const rows = await activity(item.id);
      expect(rows.filter((a) => a.verb === "updated")).toHaveLength(0);
      expect(rows.filter((a) => a.verb === "start_date_changed").map((r) => [r.oldValue, r.newValue])).toEqual([
        [null, "2026-10-04T00:00:00.000Z"],
        ["2026-10-04T00:00:00.000Z", null],
      ]);
    });

    it("still writes the residual `updated` row for a rename", async () => {
      const item = await make("old-name");
      await pm.updateWorkItem(prisma, null, item.id, { name: "warp3520a-new-name" });
      expect((await activity(item.id)).filter((a) => a.verb === "updated" && a.field === "fields")).toHaveLength(1);
    });
  });

  // ── search by key ────────────────────────────────────────────────────────

  describe("search by key", () => {
    it("finds an item by its pasted key, ignoring case", async () => {
      const item = await make("unrelated title");
      const key = item.key;
      expect(key).toBe(`${identifier}-1`);
      for (const q of [key, key.toLowerCase()]) {
        const hits = await pm.searchWorkItems(prisma, { q, workspaceSlug: WS });
        expect(hits).toMatchObject({ total: 1, nextCursor: null });
        expect(hits.items.map((i) => i.id)).toEqual([item.id]);
      }
    });

    it("finds nothing for a key that does not exist, and ignores an over-long number", async () => {
      await make("only");
      expect(await pm.searchWorkItems(prisma, { q: `${identifier}-999`, workspaceSlug: WS })).toMatchObject({ items: [], total: 0, nextCursor: null });
      expect(await pm.searchWorkItems(prisma, { q: `${identifier}-99999999999`, workspaceSlug: WS })).toMatchObject({ items: [], total: 0, nextCursor: null });
    });

    it("keeps the name search working beside it", async () => {
      const item = await make("findable-by-name");
      expect((await pm.searchWorkItems(prisma, { q: "findable-by", workspaceSlug: WS })).items.map((i) => i.id)).toEqual([
        item.id,
      ]);
    });
  });

  // ── custom-field values ride along on every read ─────────────────────────

  describe("properties on reads", () => {
    it("returns each item's values keyed by property id, on lists and on a single read", async () => {
      const withValue = await make("with-value");
      const without = await make("without");
      const property = await prisma.pmCustomProperty.create({
        data: { projectId, name: "warp3520a-severity", type: "number" },
      });
      await prisma.pmWorkItemPropertyValue.create({
        data: { workItemId: withValue.id, propertyId: property.id, value: { number: 7 } },
      });

      const first = await pm.listWorkItems(prisma, projectId, { limit: 1 });
      expect(first.total).toBe(2);
      expect(first.nextCursor).toEqual(expect.any(String));
      const rest = await pm.listWorkItems(prisma, projectId, { limit: 1, cursor: first.nextCursor! });
      expect(rest).toMatchObject({ total: 2, nextCursor: null });
      const byId = new Map([...first.items, ...rest.items].map((i) => [i.id, i]));
      expect(byId.size).toBe(2);
      expect(byId.get(withValue.id)?.properties).toEqual({ [property.id]: { number: 7 } });
      expect(byId.get(without.id)?.properties).toEqual({});
      expect((await pm.getWorkItem(prisma, withValue.id)).properties).toEqual({ [property.id]: { number: 7 } });
    });
  });
});
