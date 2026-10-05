/**
 * WARP-3370 — what the DATABASE does for a project's lifecycle.
 *
 * "Delete project" used to remove a project and every work item under it for any
 * member, leaving no trace. It is now an archive (reversible), and a hard delete
 * that is owner/admin only, archived-only, identifier-confirmed, and appends its
 * audit row IN THE SAME TRANSACTION. Three of those claims are claims about
 * Postgres, which a Prisma fake cannot make:
 *
 *   1. The cascade really takes EVERYTHING under the project (and only that):
 *      states, labels, work items, their comments / activity / assignees /
 *      labels / attachments / custom values, cycles, modules — and the edge from
 *      one of its items to an item in ANOTHER project, while that other item
 *      survives.
 *   2. The delete is a compare-and-set on `isArchived: true`: an active project
 *      is untouched, whatever the request says.
 *   3. The ActivityRow is written by the REAL recorder, names the actor and the
 *      project, and commits or rolls back WITH the delete — if the row cannot be
 *      appended the project is still there.
 *
 * Gated like every other `*.pg.test.ts`: real Postgres, RUN_PG_INTEGRATION=1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import * as pm from "../services/pm/pm.service.js";
import { createPmNativeRouter } from "../routes/pm/native.js";
import {
  _initActivityRecorderWithKeysForTests,
  _setActivityRecorderForTests,
  recordActivityInTx,
} from "../services/activity.singleton.js";
import type { AuthUser } from "../middleware/auth.js";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PM project lifecycle against Postgres (WARP-3370)", () => {
  let prisma: PrismaClient;
  const WS = "warp3370-ws";
  const ACTOR = "11111111-1111-4111-8111-111111111111";

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    // The REAL recorder, signing with a throwaway key: what lands in ActivityRow
    // is what production would write.
    _initActivityRecorderWithKeysForTests(prisma, [Buffer.alloc(32, 7)]);
  });

  afterAll(async () => {
    await prisma.pmWorkspace.deleteMany({ where: { slug: WS } });
    _setActivityRecorderForTests(null, null);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Workspace -> project -> everything below it all CASCADE.
    await prisma.pmWorkspace.deleteMany({ where: { slug: WS } });
  });

  // ── fixtures ─────────────────────────────────────────────────────────────

  const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /** A project with something in every table the cascade has to reach. */
  async function fullProject(identifier: string) {
    const project = await pm.createProject(prisma, null, { workspaceSlug: WS, name: `warp3370-${identifier}`, identifier });
    const states = await prisma.pmState.findMany({ where: { projectId: project.id } });
    const label = await prisma.pmLabel.create({ data: { projectId: project.id, name: "warp3370-label" } });
    const parent = await prisma.pmWorkItem.create({
      data: {
        projectId: project.id,
        sequenceId: 1,
        name: "warp3370-parent",
        stateId: states[0].id,
        assignees: { create: [{ userId: ACTOR }] },
        labels: { create: [{ labelId: label.id }] },
        comments: { create: [{ commentHtml: "<p>hi</p>" }] },
        activity: { create: [{ verb: "created" }] },
        attachments: {
          create: [{ fileName: "f.txt", mimeType: "text/plain", sizeBytes: BigInt(1), sha256: "0".repeat(64), storageKey: `warp3370-${uniq()}` }],
        },
      },
    });
    const child = await prisma.pmWorkItem.create({
      data: { projectId: project.id, sequenceId: 2, name: "warp3370-child", parentId: parent.id, stateId: states[0].id },
    });
    const cycle = await prisma.pmCycle.create({ data: { projectId: project.id, name: "warp3370-cycle" } });
    await prisma.pmWorkItem.update({ where: { id: child.id }, data: { cycleId: cycle.id } });
    await prisma.pmModule.create({
      data: { projectId: project.id, name: "warp3370-module", workItems: { create: [{ workItemId: parent.id }] } },
    });
    await prisma.pmCustomProperty.create({
      data: { projectId: project.id, name: "warp3370-prop", type: "text", values: { create: [{ workItemId: parent.id, value: "v" }] } },
    });
    return { project, itemIds: [parent.id, child.id], parentId: parent.id };
  }

  /** How many rows of each kind still hang off the project. */
  async function under(projectId: string, itemIds: string[]) {
    const byItem = { workItemId: { in: itemIds } };
    return {
      project: await prisma.pmProject.count({ where: { id: projectId } }),
      states: await prisma.pmState.count({ where: { projectId } }),
      labels: await prisma.pmLabel.count({ where: { projectId } }),
      items: await prisma.pmWorkItem.count({ where: { projectId } }),
      cycles: await prisma.pmCycle.count({ where: { projectId } }),
      modules: await prisma.pmModule.count({ where: { projectId } }),
      moduleItems: await prisma.pmModuleWorkItem.count({ where: byItem }),
      properties: await prisma.pmCustomProperty.count({ where: { projectId } }),
      propertyValues: await prisma.pmWorkItemPropertyValue.count({ where: byItem }),
      comments: await prisma.pmComment.count({ where: byItem }),
      activity: await prisma.pmActivity.count({ where: byItem }),
      assignees: await prisma.pmWorkItemAssignee.count({ where: byItem }),
      itemLabels: await prisma.pmWorkItemLabel.count({ where: byItem }),
      attachments: await prisma.pmAttachment.count({ where: byItem }),
    };
  }

  /** The audit callback the route passes: the real in-transaction append. */
  const realAudit = (tx: Parameters<typeof recordActivityInTx>[0], p: pm.DeletedProjectInfo) =>
    recordActivityInTx(tx, {
      kind: "system",
      severity: "warn",
      sourceIcon: "trash-2",
      what: "Project deleted",
      sub: `${p.name} (${p.identifier})`,
      refs: { projectId: p.id, projectName: p.name, projectIdentifier: p.identifier, workItemsDeleted: p.workItemCount },
      actor: { type: "user", id: ACTOR },
    });

  const deletedRows = (projectId: string) =>
    prisma.activityRow.findMany({
      where: { what: "Project deleted", refs: { path: ["projectId"], equals: projectId } },
    });

  // ── archive / restore ────────────────────────────────────────────────────

  describe("archive and restore", () => {
    it("moves isArchived and archivedAt TOGETHER, and says whether THIS call moved it", async () => {
      const { project } = await fullProject("W70A");

      const first = await pm.setProjectArchived(prisma, project.id, true);
      expect(first.changed).toBe(true);
      expect(first.project.archived).toBe(true);
      const row = await prisma.pmProject.findUniqueOrThrow({ where: { id: project.id } });
      expect(row.isArchived).toBe(true);
      expect(row.archivedAt).toBeInstanceOf(Date);

      // Asking again changes nothing, and says so — that is what keeps a repeat
      // from writing a second audit row.
      const again = await pm.setProjectArchived(prisma, project.id, true);
      expect(again.changed).toBe(false);
      expect((await prisma.pmProject.findUniqueOrThrow({ where: { id: project.id } })).archivedAt?.getTime()).toBe(
        row.archivedAt?.getTime(),
      );

      const restored = await pm.setProjectArchived(prisma, project.id, false);
      expect(restored.changed).toBe(true);
      const back = await prisma.pmProject.findUniqueOrThrow({ where: { id: project.id } });
      expect(back.isArchived).toBe(false);
      expect(back.archivedAt).toBeNull();
    });

    it("two concurrent archives move the project once (the compare-and-set has one winner)", async () => {
      const { project } = await fullProject("W70B");
      const results = await Promise.all([
        pm.setProjectArchived(prisma, project.id, true),
        pm.setProjectArchived(prisma, project.id, true),
        pm.setProjectArchived(prisma, project.id, true),
      ]);
      expect(results.filter((r) => r.changed)).toHaveLength(1);
    });

    it("archiving keeps every work item", async () => {
      const { project, itemIds } = await fullProject("W70C");
      await pm.setProjectArchived(prisma, project.id, true);
      const left = await under(project.id, itemIds);
      expect(left.items).toBe(2);
      expect(left.comments).toBe(1);
    });

    it("a project that does not exist is project_not_found", async () => {
      await expect(pm.setProjectArchived(prisma, "00000000-0000-4000-8000-00000000dead", true)).rejects.toThrow(
        "project_not_found",
      );
    });
  });

  // ── hard delete ──────────────────────────────────────────────────────────

  describe("hard delete", () => {
    it("takes EVERYTHING under an archived project, spares the other project's item, and writes its audit row in the transaction", async () => {
      const { project, itemIds, parentId } = await fullProject("W70D");
      // An item in ANOTHER project, linked to one of ours: the edge must go, the item must not.
      const other = await pm.createProject(prisma, null, { workspaceSlug: WS, name: "warp3370-other", identifier: "W70O" });
      const survivor = await prisma.pmWorkItem.create({
        data: { projectId: other.id, sequenceId: 1, name: "warp3370-survivor" },
      });
      await prisma.pmWorkItemRelation.create({ data: { fromId: parentId, toId: survivor.id, kind: "BLOCKS" } });
      await pm.setProjectArchived(prisma, project.id, true);

      const before = await under(project.id, itemIds);
      expect(Object.values(before).every((n) => n >= 1)).toBe(true); // the fixture reached every table

      await pm.deleteProject(prisma, project.id, { confirmIdentifier: "W70D", audit: realAudit });

      expect(await under(project.id, itemIds)).toEqual({
        project: 0,
        states: 0,
        labels: 0,
        items: 0,
        cycles: 0,
        modules: 0,
        moduleItems: 0,
        properties: 0,
        propertyValues: 0,
        comments: 0,
        activity: 0,
        assignees: 0,
        itemLabels: 0,
        attachments: 0,
      });
      // The other project, its item and its states are untouched; only the edge went.
      expect(await prisma.pmProject.count({ where: { id: other.id } })).toBe(1);
      expect(await prisma.pmWorkItem.count({ where: { id: survivor.id } })).toBe(1);
      expect(await prisma.pmState.count({ where: { projectId: other.id } })).toBe(5);
      expect(await prisma.pmWorkItemRelation.count({ where: { OR: [{ fromId: parentId }, { toId: survivor.id }] } })).toBe(0);

      // The audit row: the real recorder, naming the actor and the project.
      const rows = await deletedRows(project.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "system",
        severity: "warn",
        what: "Project deleted",
        sub: "warp3370-W70D (W70D)",
        actorType: "user",
        actorId: ACTOR,
      });
      expect(rows[0].refs).toMatchObject({ projectId: project.id, projectIdentifier: "W70D", workItemsDeleted: 2 });
      expect(rows[0].signature.length).toBeGreaterThan(10);
    });

    it("an ACTIVE project is untouched whatever is asked: project_not_archived, no audit row", async () => {
      const { project, itemIds } = await fullProject("W70E");
      const before = await under(project.id, itemIds);
      await expect(
        pm.deleteProject(prisma, project.id, { confirmIdentifier: "W70E", audit: realAudit }),
      ).rejects.toThrow("project_not_archived");
      expect(await under(project.id, itemIds)).toEqual(before);
      expect(await deletedRows(project.id)).toHaveLength(0);
    });

    it("the wrong identifier is identifier_mismatch and nothing is deleted or audited", async () => {
      const { project, itemIds } = await fullProject("W70F");
      await pm.setProjectArchived(prisma, project.id, true);
      const before = await under(project.id, itemIds);
      for (const typed of ["", "w70f", "W70", "W70F "]) {
        await expect(
          pm.deleteProject(prisma, project.id, { confirmIdentifier: typed, audit: realAudit }),
        ).rejects.toThrow("identifier_mismatch");
      }
      expect(await under(project.id, itemIds)).toEqual(before);
      expect(await deletedRows(project.id)).toHaveLength(0);
    });

    it("if the audit row cannot be appended the project is STILL THERE — the delete rolls back with it", async () => {
      const { project, itemIds } = await fullProject("W70G");
      await pm.setProjectArchived(prisma, project.id, true);
      const before = await under(project.id, itemIds);

      await expect(
        pm.deleteProject(prisma, project.id, {
          confirmIdentifier: "W70G",
          audit: async () => {
            throw new Error("the audit chain is unavailable");
          },
        }),
      ).rejects.toThrow("the audit chain is unavailable");

      // Everything the cascade took inside the transaction is back.
      expect(await under(project.id, itemIds)).toEqual(before);
      expect(await deletedRows(project.id)).toHaveLength(0);
    });

    it("a restore that lands between the check and the delete wins: project_not_archived, nothing cascaded", async () => {
      const { project, itemIds } = await fullProject("W70H");
      await pm.setProjectArchived(prisma, project.id, true);

      // The service reads the row (archived); then, before its compare-and-set
      // delete, another request restores the project for real.
      let raced = false;
      const racing = new Proxy(prisma, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "pmProject") {
            return new Proxy(value as object, {
              get(model, method) {
                const fn = Reflect.get(model, method);
                if (method !== "findUnique") return typeof fn === "function" ? fn.bind(model) : fn;
                return async (args: never) => {
                  const row = await (fn as (a: never) => Promise<unknown>).call(model, args);
                  if (!raced) {
                    raced = true;
                    await pm.setProjectArchived(prisma, project.id, false);
                  }
                  return row;
                };
              },
            });
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      await expect(
        pm.deleteProject(racing, project.id, { confirmIdentifier: "W70H", audit: realAudit }),
      ).rejects.toThrow("project_not_archived");
      expect(raced).toBe(true);
      const left = await under(project.id, itemIds);
      expect(left.project).toBe(1);
      expect(left.items).toBe(2);
      expect(await deletedRows(project.id)).toHaveLength(0);
    });
  });

  // ── the whole path: route -> service -> real recorder -> ActivityRow ─────

  describe("through the route, against the real recorder", () => {
    const appAs = (user: { id: string; role: string; username?: string }) => {
      const app = express();
      app.use(express.json());
      app.use((req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { user?: AuthUser }).user = {
          id: user.id,
          username: user.username ?? user.id,
          displayName: user.id,
          role: user.role as AuthUser["role"],
        };
        next();
      });
      app.use("/api", createPmNativeRouter(prisma));
      return app;
    };
    const OWNER = { id: ACTOR, role: "owner", username: "ada" };
    const MEMBER = { id: "22222222-2222-4222-8222-222222222222", role: "family", username: "bob" };

    it("a member archives (audited), an owner deletes with the identifier (audited in the transaction), a member cannot", async () => {
      const { project, itemIds } = await fullProject("W70J");

      // member archives
      const archived = await request(appAs(MEMBER)).patch(`/api/pm/projects/${project.id}`).send({ archived: true });
      expect(archived.status).toBe(200);
      const archiveRows = await prisma.activityRow.findMany({
        where: { what: "Project archived", refs: { path: ["projectId"], equals: project.id } },
      });
      expect(archiveRows).toHaveLength(1);
      expect(archiveRows[0]).toMatchObject({ actorType: "user", actorId: MEMBER.id, sub: "warp3370-W70J (W70J)" });
      expect(archiveRows[0].refs).toMatchObject({ actor: "bob", projectIdentifier: "W70J" });

      // the member cannot destroy it
      const denied = await request(appAs(MEMBER)).delete(`/api/pm/projects/${project.id}`).send({ confirm_identifier: "W70J" });
      expect(denied.status).toBe(403);
      expect((await under(project.id, itemIds)).items).toBe(2);

      // the owner must type the identifier…
      const unconfirmed = await request(appAs(OWNER)).delete(`/api/pm/projects/${project.id}`).send({});
      expect(unconfirmed.status).toBe(400);
      const wrong = await request(appAs(OWNER)).delete(`/api/pm/projects/${project.id}`).send({ confirm_identifier: "NOPE" });
      expect(wrong.status).toBe(422);
      expect((await under(project.id, itemIds)).items).toBe(2);

      // …and then it goes, with the row that names who did it
      const gone = await request(appAs(OWNER)).delete(`/api/pm/projects/${project.id}`).send({ confirm_identifier: "W70J" });
      expect(gone.status).toBe(200);
      expect((await under(project.id, itemIds)).project).toBe(0);
      const rows = await deletedRows(project.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: "user", actorId: OWNER.id });
      expect(rows[0].refs).toMatchObject({ actor: "ada", projectId: project.id, workItemsDeleted: 2 });

      // restore on a deleted project is a 404, not a resurrection
      const ghost = await request(appAs(OWNER)).patch(`/api/pm/projects/${project.id}`).send({ archived: false });
      expect(ghost.status).toBe(404);
    });

    it("restore is audited too, and only the transitions are", async () => {
      const { project } = await fullProject("W70K");
      const owner = appAs(OWNER);
      await request(owner).patch(`/api/pm/projects/${project.id}`).send({ archived: true });
      await request(owner).patch(`/api/pm/projects/${project.id}`).send({ archived: true }); // repeat
      await request(owner).patch(`/api/pm/projects/${project.id}`).send({ archived: false });
      const rows = await prisma.activityRow.findMany({
        // By project id: audit rows are permanent, so an earlier run's must not count.
        where: { what: { in: ["Project archived", "Project restored"] }, refs: { path: ["projectId"], equals: project.id } },
        orderBy: { id: "asc" },
      });
      expect(rows.map((r) => r.what)).toEqual(["Project archived", "Project restored"]);
    });
  });
});
