/**
 * ADR-045 §5.3 (slice 8) — what the DATABASE actually does to work when a
 * department changes underneath it.
 *
 * Three claims hold this design up and none of them is provable against a
 * mocked Prisma:
 *
 *   1. Deleting a department SET NULLs the pointer and destroys no work. If
 *      that FK were ever written as Cascade, every ticket a department ever
 *      owned would vanish with it, and no unit test in this repo could tell.
 *   2. ARCHIVING a department is NOT deleting it — `DELETE /api/departments/:id`
 *      sets `state='archiving'`, so the row survives and every ticket keeps
 *      pointing at it. The archived department's work must stay visible and
 *      keep its label; only NEW assignment is refused. That pair (old tag
 *      survives / new tag refused) is the whole archive answer and it is
 *      exactly the pair a service-layer-only test would get wrong.
 *   3. Both ON DELETE SET NULL FKs are INDEXED (WARP-845). An index is not
 *      observable from application code, so it is asserted against pg_indexes
 *      or it is not asserted at all — which is how five of them already shipped
 *      unindexed on the CRM side.
 *
 * Gated like every other `*.pg.test.ts`: real Postgres, RUN_PG_INTEGRATION=1.
 * The orchestrator-tests workflow runs this lane on any PR touching
 * apps/orchestrator, which this slice does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import * as pm from "../services/pm/pm.service.js";
import { PM_DEPARTMENT_ERRORS } from "../services/pm/pm-department.js";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PM department dimension (ADR-045 §5.3)", () => {
  let prisma: PrismaClient;

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

  // Every fixture is namespaced `adr045h-` so cleanup and counts scope to this
  // suite: the pg-gated suites share one throwaway DB, so an unscoped
  // deleteMany() would eat another suite's rows.
  const OURS = { startsWith: "adr045h-" } as const;

  beforeEach(async () => {
    // FK-ordered: items and projects before the departments they point at, so a
    // failed run cannot leave a row that blocks the department delete.
    await prisma.pmWorkItem.deleteMany({ where: { name: OURS } });
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.department.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
  });

  async function makeDepartment(
    suffix: string,
    over: Partial<{
      kind: "HOUSEHOLD" | "DEPARTMENT" | "TEAM";
      state:
        | "pending"
        | "provisioning"
        | "active"
        | "failed"
        | "archiving"
        | "archived"
        | "archive_failed";
      provisionError: string | null;
      parentId: string | null;
    }> = {},
  ) {
    return prisma.department.create({
      data: {
        name: `adr045h-${suffix}`,
        slug: `adr045h-${suffix}`,
        // `createdBy` is a bare String on Department — a local User.id by
        // convention, with no FK — so no User fixture is needed.
        createdBy: "adr045h-actor",
        kind: over.kind ?? "DEPARTMENT",
        state: over.state ?? "active",
        provisionError: over.provisionError ?? null,
        parentId: over.parentId ?? null,
      },
    });
  }

  async function makeProject(suffix: string, departmentId: string | null) {
    const ws = await prisma.pmWorkspace.upsert({
      where: { slug: "adr045h-ws" },
      create: { slug: "adr045h-ws", name: "adr045h workspace" },
      update: {},
    });
    return prisma.pmProject.create({
      data: {
        workspaceId: ws.id,
        name: `adr045h-${suffix}`,
        identifier: `A45${suffix.toUpperCase().slice(0, 2)}`,
        departmentId,
      },
    });
  }

  // ── 1. provisioning state does not gate the work half ────────────────

  for (const state of ["pending", "provisioning", "failed"] as const) {
    it(`assigns work to a department in state=${state}, provisionError set`, async () => {
      const dept = await makeDepartment(`unconverged-${state}`, {
        state,
        provisionError:
          state === "failed" ? "adr045h- groupfolder create returned 412" : null,
      });
      const project = await makeProject(`p-${state}`, null);

      const item = await pm.createWorkItem(prisma, null, project.id, {
        name: `adr045h-ticket-${state}`,
        departmentId: dept.id,
      });

      // Assignable AND visible. Storage convergence is not a precondition for
      // a ticket existing.
      expect(item.department).toMatchObject({
        id: dept.id,
        source: "item",
      });
      const listed = await pm.listWorkItems(prisma, project.id, {
        departmentId: dept.id,
      });
      expect(listed.map((i) => i.id)).toContain(item.id);
    });
  }

  // ── 2. kinds ─────────────────────────────────────────────────────────

  it("refuses HOUSEHOLD as an owner of work, explicitly", async () => {
    const household = await makeDepartment("household", { kind: "HOUSEHOLD" });
    const project = await makeProject("p-household", null);
    await expect(
      pm.createWorkItem(prisma, null, project.id, {
        name: "adr045h-ticket-household",
        departmentId: household.id,
      }),
    ).rejects.toThrow(PM_DEPARTMENT_ERRORS.DEPARTMENT_NOT_ASSIGNABLE);
  });

  it("a TEAM owns work in its own right and does NOT imply its parent", async () => {
    const dept = await makeDepartment("clinical");
    const team = await makeDepartment("hygiene", {
      kind: "TEAM",
      parentId: dept.id,
    });
    const project = await makeProject("p-team", null);

    const item = await pm.createWorkItem(prisma, null, project.id, {
      name: "adr045h-ticket-team",
      departmentId: team.id,
    });
    // Exactly one owner is stored. The parent is a READ-side rollup, never a
    // second row.
    expect(item.department?.id).toBe(team.id);
    expect(item.department?.parentId).toBe(dept.id);

    // Filtering by the PARENT department finds the team's item...
    const byParent = await pm.listWorkItems(prisma, project.id, {
      departmentId: dept.id,
    });
    expect(byParent.map((i) => i.id)).toContain(item.id);
    // ...and filtering by the TEAM does not reach up.
    const other = await pm.createWorkItem(prisma, null, project.id, {
      name: "adr045h-ticket-parentowned",
      departmentId: dept.id,
    });
    const byTeam = await pm.listWorkItems(prisma, project.id, {
      departmentId: team.id,
    });
    expect(byTeam.map((i) => i.id)).toContain(item.id);
    expect(byTeam.map((i) => i.id)).not.toContain(other.id);
  });

  // ── 3. archive ───────────────────────────────────────────────────────

  it("archiving keeps existing tickets, their label and their visibility", async () => {
    const dept = await makeDepartment("tobearchived");
    const project = await makeProject("p-archive", null);
    const item = await pm.createWorkItem(prisma, null, project.id, {
      name: "adr045h-ticket-survives",
      departmentId: dept.id,
    });

    // Exactly what DELETE /api/departments/:id does — state + archivedAt, no
    // row delete, no membership delete, purge not exposed in v1.
    await prisma.department.update({
      where: { id: dept.id },
      data: { state: "archiving", archivedAt: new Date() },
    });

    const after = await pm.getWorkItem(prisma, item.id);
    expect(after.department).toMatchObject({ id: dept.id, name: dept.name });
    const listed = await pm.listWorkItems(prisma, project.id, {
      departmentId: dept.id,
    });
    expect(listed.map((i) => i.id)).toContain(item.id);
  });

  it("refuses a NEW assignment into an archive-intent department", async () => {
    const dept = await makeDepartment("archived", { state: "archived" });
    const project = await makeProject("p-archived", null);
    await expect(
      pm.createWorkItem(prisma, null, project.id, {
        name: "adr045h-ticket-refused",
        departmentId: dept.id,
      }),
    ).rejects.toThrow(PM_DEPARTMENT_ERRORS.DEPARTMENT_ARCHIVED);
  });

  it("CLEARING is never blocked by the state that makes clearing right", async () => {
    const dept = await makeDepartment("clearable");
    const project = await makeProject("p-clear", null);
    const item = await pm.createWorkItem(prisma, null, project.id, {
      name: "adr045h-ticket-clear",
      departmentId: dept.id,
    });
    await prisma.department.update({
      where: { id: dept.id },
      data: { state: "archived", archivedAt: new Date() },
    });
    const cleared = await pm.updateWorkItem(prisma, null, item.id, {
      departmentId: null,
    });
    expect(cleared.department).toBeNull();
  });

  // ── 4. the override rule, end to end ─────────────────────────────────

  it("an item's department overrides its project's; clearing falls back", async () => {
    const front = await makeDepartment("frontdesk");
    const clinical = await makeDepartment("clinicaloverride");
    const project = await makeProject("p-override", front.id);

    const inherited = await pm.createWorkItem(prisma, null, project.id, {
      name: "adr045h-ticket-inherits",
    });
    expect(inherited.department).toMatchObject({
      id: front.id,
      source: "project",
    });

    const overridden = await pm.updateWorkItem(prisma, null, inherited.id, {
      departmentId: clinical.id,
    });
    expect(overridden.department).toMatchObject({
      id: clinical.id,
      source: "item",
    });

    const back = await pm.updateWorkItem(prisma, null, inherited.id, {
      departmentId: null,
    });
    expect(back.department).toMatchObject({ id: front.id, source: "project" });
  });

  it("records a department change on the work item's own activity feed", async () => {
    const dept = await makeDepartment("activity");
    const project = await makeProject("p-activity", null);
    const item = await pm.createWorkItem(prisma, null, project.id, {
      name: "adr045h-ticket-activity",
    });
    await pm.updateWorkItem(prisma, null, item.id, { departmentId: dept.id });
    const feed = await pm.listActivity(prisma, item.id);
    const row = feed.find((a) => a.field === "department");
    expect(row).toBeDefined();
    expect(row?.oldValue).toBeNull();
    expect(row?.newValue).toBe(dept.id);
  });

  // ── 5. referential action + indexes ──────────────────────────────────

  it("deleting a department SET NULLs both pointers and destroys no work", async () => {
    const dept = await makeDepartment("deletable");
    const project = await makeProject("p-delete", dept.id);
    const item = await pm.createWorkItem(prisma, null, project.id, {
      name: "adr045h-ticket-orphaned",
      departmentId: dept.id,
    });

    await prisma.department.delete({ where: { id: dept.id } });

    const survivingItem = await prisma.pmWorkItem.findUnique({
      where: { id: item.id },
    });
    const survivingProject = await prisma.pmProject.findUnique({
      where: { id: project.id },
    });
    expect(survivingItem, "deleting a department must not delete work").not.toBeNull();
    expect(survivingProject).not.toBeNull();
    expect(survivingItem?.departmentId).toBeNull();
    expect(survivingProject?.departmentId).toBeNull();
  });

  it("indexes every departmentId FK — WARP-845", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename IN ('PmProject', 'PmWorkItem')
    `;
    const names = rows.map((r) => r.indexname);
    // An unindexed ON DELETE SET NULL FK turns the parent delete into a
    // sequential scan of the child table. Not observable from application
    // code, so it is asserted here or it is not asserted at all.
    expect(names).toContain("PmProject_departmentId_idx");
    expect(names).toContain("PmWorkItem_departmentId_idx");
    // The board filter's composite — a different question from the FK scan,
    // and the departmentId-only index cannot answer it (wrong leading column).
    expect(names).toContain("PmWorkItem_projectId_departmentId_idx");
  });
});
