/**
 * WARP-3522 — what the DATABASE does to saved views.
 *
 * Four claims, none provable against a mocked Prisma:
 *
 *   1. The migration's raw invariants hold: a name must be 1..60 characters, a
 *      filter must be a JSON object, and one name is one view per place — where a
 *      PERSONAL view's place includes its owner (two people may both keep a
 *      "Mine") and a cross-project view's place is "no project" (Postgres'
 *      NULL-distinct rule would otherwise let it repeat).
 *   2. Deleting a project takes its views with it and leaves the cross-project
 *      ones — the FK is Cascade, and a cross-project view has no project to lose.
 *   3. Who sees and who may change what: someone else's PERSONAL view is not
 *      listed and is `view_not_found`, never `view_forbidden`.
 *   4. The cap holds under a race: two saves cannot both slip under it.
 *
 * Gated like every other `*.pg.test.ts`: real Postgres, RUN_PG_INTEGRATION=1.
 * Fixtures are namespaced `ws6v-`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PM_VIEW_LIMIT, type PmFilter } from "@droplet/shared-types";
import {
  createView,
  deleteView,
  listViews,
  updateView,
  type CreateViewInput,
  type ViewActor,
} from "../services/pm/pm-views.service.js";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const PREFIX = "ws6v-";
const ALL: PmFilter = { and: [] };
const MINE: PmFilter = { and: [{ field: "assignee", op: "is", value: "me" }] };

describe.skipIf(!RUN)("PM saved views (WARP-3522)", () => {
  let prisma: PrismaClient;
  let wsId: string;
  let wsSlug: string;
  let p1: string;
  let p2: string;
  const who: Record<string, ViewActor> = {};

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    await cleanup();

    wsSlug = `${PREFIX}ws`;
    wsId = (await prisma.pmWorkspace.create({ data: { slug: wsSlug, name: "ws6v" } })).id;

    const user = async (key: string, role: "owner" | "admin" | "family") => {
      const u = await prisma.user.create({ data: { username: `${PREFIX}${key}`, displayName: key, role } });
      who[key] = { userId: u.id, role };
    };
    await user("owner", "owner");
    await user("admin", "admin");
    await user("lead", "family");
    await user("fam", "family");
    await user("other", "family");

    p1 = (
      await prisma.pmProject.create({
        data: { workspaceId: wsId, name: `${PREFIX}p1`, identifier: "W6VA", leadId: who.lead.userId },
      })
    ).id;
    p2 = (await prisma.pmProject.create({ data: { workspaceId: wsId, name: `${PREFIX}p2`, identifier: "W6VB" } })).id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup() {
    await prisma.pmWorkspace.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  }

  beforeEach(async () => {
    await prisma.pmSavedView.deleteMany({ where: { workspaceId: wsId } });
  });

  const input = (over: Partial<CreateViewInput> = {}): CreateViewInput => ({
    workspace: wsSlug,
    projectId: p1,
    scope: "PERSONAL",
    name: "Mine",
    layout: "BOARD",
    filter: MINE,
    ...over,
  });
  const create = (actor: ViewActor, over: Partial<CreateViewInput> = {}) => createView(prisma, actor, input(over));
  const list = (actor: ViewActor | null, project?: string) => listViews(prisma, actor, { workspace: wsSlug, project });
  const rawInsert = (over: Record<string, unknown>) =>
    prisma.pmSavedView.create({
      data: {
        workspaceId: wsId,
        projectId: p1,
        ownerId: who.fam.userId,
        scope: "PERSONAL",
        name: "x",
        layout: "BOARD",
        filter: {},
        ...over,
      } as never,
    });

  // ── 1. the migration's invariants ──────────────────────────────────────────

  describe("database invariants", () => {
    it("refuses a name that is empty once trimmed, or longer than 60 characters", async () => {
      await expect(rawInsert({ name: "" })).rejects.toThrow(/PmSavedView_name_length/);
      await expect(rawInsert({ name: "   " })).rejects.toThrow(/PmSavedView_name_length/);
      await expect(rawInsert({ name: "x".repeat(61) })).rejects.toThrow(/PmSavedView_name_length/);
      await expect(rawInsert({ name: "x".repeat(60) })).resolves.toBeTruthy();
    });

    it("refuses a filter that is not a JSON object", async () => {
      await expect(rawInsert({ name: "a", filter: [] })).rejects.toThrow(/PmSavedView_filter_is_object/);
      await expect(rawInsert({ name: "b", filter: "x" })).rejects.toThrow(/PmSavedView_filter_is_object/);
      await expect(rawInsert({ name: "c", filter: 3 })).rejects.toThrow(/PmSavedView_filter_is_object/);
      await expect(rawInsert({ name: "d", filter: { and: [] } })).resolves.toBeTruthy();
    });

    it("one name per place, compared case-insensitively", async () => {
      await rawInsert({ name: "Overdue" });
      await expect(rawInsert({ name: "overdue" })).rejects.toThrow(/PmSavedView_name_scope_key|Unique constraint/);
    });

    it("two people may each keep a PERSONAL view of the same name", async () => {
      await rawInsert({ name: "Mine", ownerId: who.fam.userId });
      await expect(rawInsert({ name: "Mine", ownerId: who.other.userId })).resolves.toBeTruthy();
    });

    it("a SHARED name is unique across owners", async () => {
      await rawInsert({ name: "Team", scope: "SHARED", ownerId: who.admin.userId });
      await expect(rawInsert({ name: "team", scope: "SHARED", ownerId: who.owner.userId })).rejects.toThrow(
        /PmSavedView_name_scope_key|Unique constraint/,
      );
    });

    it("the same name may live in another project", async () => {
      await rawInsert({ name: "Mine" });
      await expect(rawInsert({ name: "Mine", projectId: p2 })).resolves.toBeTruthy();
    });

    it("a CROSS-PROJECT name is unique too, though its projectId is NULL", async () => {
      await rawInsert({ name: "Everything", projectId: null });
      await expect(rawInsert({ name: "everything", projectId: null })).rejects.toThrow(
        /PmSavedView_name_scope_key|Unique constraint/,
      );
      await expect(rawInsert({ name: "Everything", projectId: null, scope: "SHARED" })).resolves.toBeTruthy();
    });
  });

  // ── 2. cascades ────────────────────────────────────────────────────────────

  describe("cascades", () => {
    it("deleting a project deletes its views and leaves the cross-project ones", async () => {
      const doomed = await prisma.pmProject.create({ data: { workspaceId: wsId, name: `${PREFIX}doomed`, identifier: "W6VZ" } });
      await rawInsert({ name: "in doomed", projectId: doomed.id });
      await rawInsert({ name: "cross", projectId: null });
      await prisma.pmProject.delete({ where: { id: doomed.id } });
      const names = (await prisma.pmSavedView.findMany({ where: { workspaceId: wsId } })).map((v) => v.name);
      expect(names).toEqual(["cross"]);
    });
  });

  // ── 3. visibility and permission ───────────────────────────────────────────

  describe("who sees what", () => {
    it("lists the built-ins, every shared view and only the caller's own personal ones", async () => {
      await create(who.fam, { name: "fam personal" });
      await create(who.other, { name: "other personal" });
      await create(who.admin, { name: "shared", scope: "SHARED" });

      const forFam = await list(who.fam, p1);
      expect(forFam.builtin.map((v) => v.id)).toEqual(["all", "mine", "active", "overdue", "noassignee"]);
      expect(forFam.views.map((v) => v.name).sort()).toEqual(["fam personal", "shared"]);

      const forOther = await list(who.other, p1);
      expect(forOther.views.map((v) => v.name).sort()).toEqual(["other personal", "shared"]);

      // An admin does not see anybody's personal views, either.
      const forAdmin = await list(who.admin, p1);
      expect(forAdmin.views.map((v) => v.name)).toEqual(["shared"]);

      // The service principal has no person: shared only, and nothing is editable.
      const forService = await list(null, p1);
      expect(forService.views.map((v) => v.name)).toEqual(["shared"]);
      expect(forService.views[0].canEdit).toBe(false);
    });

    it("scopes by project, by 'none' (cross-project), or not at all", async () => {
      await create(who.fam, { name: "in p1", projectId: p1 });
      await create(who.fam, { name: "in p2", projectId: p2 });
      await create(who.fam, { name: "cross", projectId: null });
      expect((await list(who.fam, p1)).views.map((v) => v.name)).toEqual(["in p1"]);
      expect((await list(who.fam, p2)).views.map((v) => v.name)).toEqual(["in p2"]);
      expect((await list(who.fam, "none")).views.map((v) => v.name)).toEqual(["cross"]);
      expect((await list(who.fam)).views.map((v) => v.name).sort()).toEqual(["cross", "in p1", "in p2"]);
    });

    it("says which views the caller may change", async () => {
      await create(who.fam, { name: "mine" });
      await create(who.admin, { name: "shared", scope: "SHARED" });

      const asFam = (await list(who.fam, p1)).views;
      expect(Object.fromEntries(asFam.map((v) => [v.name, v.canEdit]))).toEqual({ mine: true, shared: false });
      const asLead = (await list(who.lead, p1)).views;
      expect(Object.fromEntries(asLead.map((v) => [v.name, v.canEdit]))).toEqual({ shared: true }); // lead of p1
      const asLeadElsewhere = await create(who.admin, { name: "shared p2", scope: "SHARED", projectId: p2 });
      const leadSeesP2 = (await list(who.lead, p2)).views.find((v) => v.id === asLeadElsewhere.id)!;
      expect(leadSeesP2.canEdit).toBe(false); // not the lead of p2
      const asAdmin = (await list(who.admin, p1)).views;
      expect(asAdmin.every((v) => v.canEdit)).toBe(true);
    });
  });

  describe("create", () => {
    it("lets any human create a PERSONAL view and returns it with its filter, layout and owner", async () => {
      const v = await create(who.fam, { layout: "LIST", groupBy: "state", sortBy: [{ field: "dueDate", dir: "asc" }], columns: ["key", "state"] });
      expect(v).toMatchObject({
        projectId: p1,
        ownerId: who.fam.userId,
        scope: "PERSONAL",
        name: "Mine",
        layout: "LIST",
        filter: MINE,
        groupBy: "state",
        sortBy: [{ field: "dueDate", dir: "asc" }],
        columns: ["key", "state"],
        canEdit: true,
        sortOrder: 0,
      });
    });

    it("refuses a SHARED view from someone who is neither owner, admin nor the project's lead", async () => {
      await expect(create(who.fam, { scope: "SHARED" })).rejects.toThrow("view_forbidden");
      await expect(create(who.lead, { scope: "SHARED", projectId: p2 })).rejects.toThrow("view_forbidden");
      await expect(create(who.lead, { scope: "SHARED", projectId: null })).rejects.toThrow("view_forbidden");
    });

    it("lets the lead share in their project, and an admin share anywhere", async () => {
      await expect(create(who.lead, { scope: "SHARED", name: "lead's" })).resolves.toMatchObject({ scope: "SHARED" });
      await expect(create(who.admin, { scope: "SHARED", projectId: p2, name: "admin's" })).resolves.toBeTruthy();
      await expect(create(who.owner, { scope: "SHARED", projectId: null, name: "everywhere" })).resolves.toBeTruthy();
    });

    it("404s a project that does not exist", async () => {
      await expect(create(who.fam, { projectId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow("project_not_found");
    });

    it("refuses a duplicate name in the same place with view_name_taken", async () => {
      await create(who.fam, { name: "Overdue" });
      await expect(create(who.fam, { name: "overdue" })).rejects.toThrow("view_name_taken");
      // …but another person's personal view of that name is no clash.
      await expect(create(who.other, { name: "Overdue" })).resolves.toBeTruthy();
    });

    it("appends: each new view takes the next sortOrder in its place", async () => {
      const a = await create(who.fam, { name: "a" });
      const b = await create(who.fam, { name: "b" });
      const c = await create(who.fam, { name: "c" });
      expect([a.sortOrder, b.sortOrder, c.sortOrder]).toEqual([0, 1, 2]);
    });
  });

  describe("update", () => {
    it("renames and re-filters the owner's own view", async () => {
      const v = await create(who.fam);
      const u = await updateView(prisma, who.fam, v.id, { name: "Renamed", filter: ALL, layout: "LIST" });
      expect(u).toMatchObject({ name: "Renamed", filter: ALL, layout: "LIST", canEdit: true });
    });

    it("clears groupBy / sortBy / columns with null and leaves them alone when absent", async () => {
      const v = await create(who.fam, { groupBy: "priority", sortBy: [{ field: "name", dir: "asc" }], columns: ["key"] });
      const same = await updateView(prisma, who.fam, v.id, { name: "Still" });
      expect(same).toMatchObject({ groupBy: "priority", sortBy: [{ field: "name", dir: "asc" }], columns: ["key"] });
      const cleared = await updateView(prisma, who.fam, v.id, { groupBy: null, sortBy: null, columns: null });
      expect(cleared).toMatchObject({ groupBy: null, sortBy: null, columns: null });
      const row = await prisma.pmSavedView.findUniqueOrThrow({ where: { id: v.id } });
      expect(row.sortBy).toBeNull();
      expect(row.columns).toBeNull();
    });

    it("someone else's PERSONAL view is not found — never forbidden", async () => {
      const v = await create(who.fam);
      await expect(updateView(prisma, who.other, v.id, { name: "x" })).rejects.toThrow("view_not_found");
      await expect(updateView(prisma, who.admin, v.id, { name: "x" })).rejects.toThrow("view_not_found");
      await expect(deleteView(prisma, who.owner, v.id)).rejects.toThrow("view_not_found");
    });

    it("a SHARED view is read-only to non-editors, editable by owner, admin and the project lead", async () => {
      const v = await create(who.admin, { scope: "SHARED", name: "Team" });
      await expect(updateView(prisma, who.fam, v.id, { name: "x" })).rejects.toThrow("view_forbidden");
      await expect(deleteView(prisma, who.fam, v.id)).rejects.toThrow("view_forbidden");
      await expect(updateView(prisma, who.lead, v.id, { name: "by lead" })).resolves.toMatchObject({ name: "by lead" });
      await expect(updateView(prisma, who.owner, v.id, { name: "by owner" })).resolves.toMatchObject({ name: "by owner" });
    });

    it("refuses a rename onto an existing name", async () => {
      await create(who.fam, { name: "One" });
      const two = await create(who.fam, { name: "Two" });
      await expect(updateView(prisma, who.fam, two.id, { name: "one" })).rejects.toThrow("view_name_taken");
    });

    it("404s a view that does not exist, and refuses a built-in id with view_is_builtin", async () => {
      await expect(updateView(prisma, who.fam, "00000000-0000-4000-8000-000000000000", { name: "x" })).rejects.toThrow("view_not_found");
      await expect(updateView(prisma, who.admin, "mine", { name: "x" })).rejects.toThrow("view_is_builtin");
      await expect(deleteView(prisma, who.admin, "overdue")).rejects.toThrow("view_is_builtin");
    });
  });

  describe("delete", () => {
    it("removes the view", async () => {
      const v = await create(who.fam);
      await deleteView(prisma, who.fam, v.id);
      expect(await prisma.pmSavedView.count({ where: { id: v.id } })).toBe(0);
    });

    it("a deleted name can be used again", async () => {
      const v = await create(who.fam, { name: "Again" });
      await deleteView(prisma, who.fam, v.id);
      await expect(create(who.fam, { name: "Again" })).resolves.toBeTruthy();
    });
  });

  // ── 4. the cap ─────────────────────────────────────────────────────────────

  describe("the view limit", () => {
    it(`allows ${PM_VIEW_LIMIT} personal views per owner per place and refuses the next`, async () => {
      for (let i = 0; i < PM_VIEW_LIMIT; i += 1) await create(who.fam, { name: `v${i}` });
      await expect(create(who.fam, { name: "one too many" })).rejects.toThrow("view_limit_reached");
      // Another owner, another project, and the shared space each have their own cap.
      await expect(create(who.other, { name: "fine" })).resolves.toBeTruthy();
      await expect(create(who.fam, { name: "fine", projectId: p2 })).resolves.toBeTruthy();
      await expect(create(who.admin, { name: "fine", scope: "SHARED" })).resolves.toBeTruthy();
    });

    it("counts shared views per place against everyone", async () => {
      for (let i = 0; i < PM_VIEW_LIMIT; i += 1) await create(i % 2 ? who.admin : who.owner, { name: `s${i}`, scope: "SHARED" });
      await expect(create(who.admin, { name: "one too many", scope: "SHARED" })).rejects.toThrow("view_limit_reached");
    });

    it("holds under a race: concurrent saves cannot all slip under the cap", async () => {
      for (let i = 0; i < PM_VIEW_LIMIT - 2; i += 1) await create(who.fam, { name: `seed${i}` });
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => create(who.fam, { name: `race${i}` })),
      );
      const total = await prisma.pmSavedView.count({ where: { workspaceId: wsId, ownerId: who.fam.userId, projectId: p1 } });
      expect(total).toBeLessThanOrEqual(PM_VIEW_LIMIT);
      for (const r of results) {
        if (r.status === "rejected") {
          const msg = r.reason instanceof Error ? r.reason.message : "";
          const code = (r.reason as { code?: string }).code;
          expect(msg === "view_limit_reached" || code === "P2034").toBe(true);
        }
      }
    });
  });

  describe("a stored filter is never trusted", () => {
    it("reads a filter that no longer validates as 'no filter' instead of failing the list", async () => {
      await rawInsert({ name: "legacy", filter: { field: "color", op: "is", value: "red" } });
      const views = (await list(who.fam, p1)).views;
      expect(views).toHaveLength(1);
      expect(views[0].filter).toEqual(ALL);
    });

    it("reads a bad sort / columns / groupBy as absent", async () => {
      await rawInsert({ name: "odd", sortBy: [{ field: "nope", dir: "asc" }], columns: ["a b"], groupBy: "nope" });
      const [v] = (await list(who.fam, p1)).views;
      expect(v).toMatchObject({ sortBy: null, columns: null, groupBy: null });
    });
  });
});
