/**
 * WARP-3521 (ADR-069 slice WS-5) — modules (milestones / epics).
 *
 * A module groups work items beyond the sprint boundary: a launch, a migration,
 * an epic. Many items per module, and an item may sit in several modules, hence
 * the `PmModuleWorkItem` join. Unlike a cycle a module has no state machine —
 * its `status` is a label the owner moves by hand — so this is a plain CRUD
 * service plus membership.
 *
 * Membership writes are SERIALIZABLE (read the links, insert or delete the
 * difference, audit exactly what changed): without it two overlapping adds of
 * the same item both write a `module_added` row for one link. The same
 * transaction level `deleteModule` uses, for the reason `deleteWorkItem` does —
 * audit-then-cascade has to see the member list it is about to erase.
 *
 * Every membership change writes one `PmActivity` row per item
 * (`module_added` / `module_removed`, `field = "module"`), which is the item's
 * own record of why it appears in a module.
 *
 * Errors are `Error(code)` — see pm-planning.ts — mapped to HTTP in the route.
 */

import type { Prisma, PrismaClient, PmStateGroup } from "@prisma/client";
import { nudgeOutbox } from "./pm-outbox.js";
import { SERIALIZABLE_TX } from "../../lib/prisma-tx.js";
import { PM_ERRORS, isPrismaCode, isServiceDesk, listWorkItemsWhere, type ApiWorkItem } from "./pm.service.js";
import { PM_PLANNING_ERRORS, PmPlanningError, formatDateOnly } from "./pm-planning.js";
import { emptyProgress, summarizeProgress, type ApiPlanningProgress } from "./pm-progress.js";

type Db = PrismaClient | Prisma.TransactionClient;
type ModuleRow = Prisma.PmModuleGetPayload<object>;

// ── API shapes ───────────────────────────────────────────────────────────────

export interface ApiModule {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  /** A User.id, like every PM attribution column. */
  leadId: string | null;
  status: ModuleRow["status"];
  /** Calendar dates, `YYYY-MM-DD`. */
  startDate: string | null;
  targetDate: string | null;
  progress: ApiPlanningProgress;
  createdAt: string;
  updatedAt: string;
}

/** What the work-item drawer needs to render and toggle a module. */
export interface ApiModuleRef {
  id: string;
  name: string;
  status: ModuleRow["status"];
}

export interface ModuleFields {
  name?: string;
  description?: string | null;
  leadId?: string | null;
  status?: ModuleRow["status"];
  startDate?: Date | null;
  targetDate?: Date | null;
}

function mapModule(row: ModuleRow, progress: ApiPlanningProgress): ApiModule {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    leadId: row.leadId,
    status: row.status,
    startDate: formatDateOnly(row.startDate),
    targetDate: formatDateOnly(row.targetDate),
    progress,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function assertDates(start: Date | null, target: Date | null): void {
  if (start && target && target.getTime() < start.getTime()) {
    throw new PmPlanningError(PM_PLANNING_ERRORS.INVALID_DATES, { reason: "target_before_start" });
  }
}

/** The same rule a project lead follows: an external guest is admitted to the one
 *  work item assigned to them, never to a role that runs a body of work
 *  (WARP-3365). Existence is not checked — PM user references are plain ids. */
async function assertLeadAllowed(db: Db, leadId: string | null | undefined): Promise<void> {
  if (!leadId) return;
  const lead = await db.user.findUnique({ where: { id: leadId }, select: { role: true } });
  if (lead?.role === "guest") throw new Error(PM_ERRORS.LEAD_IS_GUEST);
}

async function assertProject(db: Db, projectId: string): Promise<void> {
  const project = await db.pmProject.findUnique({ where: { id: projectId }, select: { id: true, kind: true } });
  if (!project || isServiceDesk(project)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
}

async function loadModuleRow(db: Db, id: string): Promise<ModuleRow> {
  const row = await db.pmModule.findUnique({ where: { id }, include: { project: { select: { kind: true } } } });
  if (!row || isServiceDesk(row.project)) throw new Error(PM_PLANNING_ERRORS.MODULE_NOT_FOUND);
  return row;
}

/** Progress for a set of modules in one round trip (household scale — see
 *  `progressByCycle` in pm-cycles.service.ts for the same trade). */
async function progressByModule(
  db: Db,
  moduleIds: string[],
): Promise<Map<string, ApiPlanningProgress>> {
  const out = new Map<string, ApiPlanningProgress>();
  for (const id of moduleIds) out.set(id, emptyProgress());
  if (moduleIds.length === 0) return out;

  const rows = await db.pmModuleWorkItem.findMany({
    where: { moduleId: { in: moduleIds }, workItem: { isArchived: false } },
    select: {
      moduleId: true,
      workItem: { select: { estimate: true, state: { select: { group: true } } } },
    },
  });
  const grouped = new Map<string, Array<{ estimate: number | null; state: { group: PmStateGroup } | null }>>();
  for (const r of rows) {
    const list = grouped.get(r.moduleId) ?? [];
    list.push({ estimate: r.workItem.estimate, state: r.workItem.state });
    grouped.set(r.moduleId, list);
  }
  for (const [moduleId, list] of grouped) out.set(moduleId, summarizeProgress(list));
  return out;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listModules(prisma: PrismaClient, projectId: string): Promise<ApiModule[]> {
  await assertProject(prisma, projectId);
  const rows = await prisma.pmModule.findMany({ where: { projectId } });
  const progress = await progressByModule(
    prisma,
    rows.map((r) => r.id),
  );
  return [...rows]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    // pre-filled for every id by `progressByModule` — a miss would be a bug
    .map((r) => mapModule(r, progress.get(r.id)!));
}

export async function getModule(prisma: PrismaClient, moduleId: string): Promise<ApiModule> {
  const row = await loadModuleRow(prisma, moduleId);
  const progress = await progressByModule(prisma, [row.id]);
  return mapModule(row, progress.get(row.id)!);
}

/** The module's own work items, with the exact total (see `listWorkItemsWhere`). */
export async function listModuleWorkItems(
  prisma: PrismaClient,
  moduleId: string,
  opts: { perPage?: number; page?: number },
): Promise<{ work_items: ApiWorkItem[]; total: number }> {
  const mod = await loadModuleRow(prisma, moduleId);
  const { items, total } = await listWorkItemsWhere(
    prisma,
    mod.projectId,
    { modules: { some: { moduleId } } },
    opts,
  );
  return { work_items: items, total };
}

/** The modules one work item is in — the drawer's picker reads this. */
export async function listModulesForWorkItem(
  prisma: PrismaClient,
  workItemId: string,
): Promise<ApiModuleRef[]> {
  const item = await prisma.pmWorkItem.findUnique({ where: { id: workItemId }, select: { id: true, project: { select: { kind: true } } } });
  if (!item || isServiceDesk(item.project)) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  const rows = await prisma.pmModuleWorkItem.findMany({
    where: { workItemId },
    select: { module: { select: { id: true, name: true, status: true } } },
  });
  return rows
    .map((r) => ({ id: r.module.id, name: r.module.name, status: r.module.status }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createModule(
  prisma: PrismaClient,
  projectId: string,
  input: ModuleFields & { name: string },
): Promise<ApiModule> {
  await assertProject(prisma, projectId);
  await assertLeadAllowed(prisma, input.leadId);
  const startDate = input.startDate ?? null;
  const targetDate = input.targetDate ?? null;
  assertDates(startDate, targetDate);
  const row = await prisma.pmModule.create({
    data: {
      projectId,
      name: input.name,
      description: input.description ?? null,
      leadId: input.leadId ?? null,
      ...(input.status !== undefined ? { status: input.status } : {}),
      startDate,
      targetDate,
    },
  });
  return mapModule(row, emptyProgress());
}

export async function updateModule(
  prisma: PrismaClient,
  moduleId: string,
  fields: ModuleFields,
): Promise<ApiModule> {
  const existing = await loadModuleRow(prisma, moduleId);
  await assertLeadAllowed(prisma, fields.leadId);
  assertDates(
    fields.startDate !== undefined ? fields.startDate : existing.startDate,
    fields.targetDate !== undefined ? fields.targetDate : existing.targetDate,
  );

  const data: Prisma.PmModuleUpdateInput = {};
  if (fields.name !== undefined) data.name = fields.name;
  if (fields.description !== undefined) data.description = fields.description;
  if (fields.leadId !== undefined) data.leadId = fields.leadId;
  if (fields.status !== undefined) data.status = fields.status;
  if (fields.startDate !== undefined) data.startDate = fields.startDate;
  if (fields.targetDate !== undefined) data.targetDate = fields.targetDate;

  try {
    await prisma.pmModule.update({ where: { id: moduleId }, data });
  } catch (err) {
    if (isPrismaCode(err, "P2025")) throw new Error(PM_PLANNING_ERRORS.MODULE_NOT_FOUND);
    throw err;
  }
  return getModule(prisma, moduleId);
}

/** Delete a module. Its links CASCADE, which is silent at the database, so every
 *  member is audited first (`module_removed`), in the same SERIALIZABLE
 *  transaction — the `deleteWorkItem` / `deleteCycle` discipline. */
export async function deleteModule(
  prisma: PrismaClient,
  actorId: string | null,
  moduleId: string,
): Promise<void> {
  let wroteActivity = false;
  try {
    await prisma.$transaction(async (tx) => {
      await loadModuleRow(tx, moduleId);
      const members = await tx.pmModuleWorkItem.findMany({
        where: { moduleId },
        select: { workItemId: true },
      });
      if (members.length > 0) {
        await tx.pmActivity.createMany({
          data: members.map((m) => ({
            workItemId: m.workItemId,
            actorId,
            verb: "module_removed" as const,
            field: "module",
            oldValue: moduleId,
            newValue: null,
          })),
        });
        wroteActivity = true;
      }
      await tx.pmModule.delete({ where: { id: moduleId } });
    }, SERIALIZABLE_TX);
  } catch (err) {
    if (isPrismaCode(err, "P2034")) throw new Error(PM_ERRORS.CONCURRENT_MUTATION);
    if (isPrismaCode(err, "P2025")) throw new Error(PM_PLANNING_ERRORS.MODULE_NOT_FOUND);
    throw err;
  }
  if (wroteActivity) nudgeOutbox();
}

/**
 * Put work items in a module. Idempotent: an item already there is skipped and
 * not audited again. Every item must exist (404, naming the missing ids) and live
 * in the module's project (422) — and the whole call is all-or-nothing.
 */
export async function addModuleWorkItems(
  prisma: PrismaClient,
  actorId: string | null,
  moduleId: string,
  workItemIds: string[],
): Promise<{ added: number; module: ApiModule }> {
  const ids = [...new Set(workItemIds)];
  let added = 0;
  try {
    added = await prisma.$transaction(async (tx) => {
      const mod = await loadModuleRow(tx, moduleId);
      const items = await tx.pmWorkItem.findMany({
          where: { id: { in: ids }, project: { kind: "PROJECT" } },
        select: { id: true, projectId: true },
      });
      if (items.length !== ids.length) {
        const found = new Set(items.map((i) => i.id));
        throw new PmPlanningError(PM_ERRORS.WORK_ITEM_NOT_FOUND, {
          missingIds: ids.filter((id) => !found.has(id)),
        });
      }
      if (items.some((i) => i.projectId !== mod.projectId)) {
        throw new Error(PM_PLANNING_ERRORS.INVALID_WORK_ITEM);
      }

      const existing = await tx.pmModuleWorkItem.findMany({
        where: { moduleId, workItemId: { in: ids } },
        select: { workItemId: true },
      });
      const have = new Set(existing.map((e) => e.workItemId));
      const fresh = ids.filter((id) => !have.has(id));
      if (fresh.length > 0) {
        await tx.pmModuleWorkItem.createMany({
          data: fresh.map((workItemId) => ({ moduleId, workItemId })),
        });
        await tx.pmActivity.createMany({
          data: fresh.map((workItemId) => ({
            workItemId,
            actorId,
            verb: "module_added" as const,
            field: "module",
            oldValue: null,
            newValue: moduleId,
          })),
        });
      }
      return fresh.length;
    }, SERIALIZABLE_TX);
  } catch (err) {
    if (isPrismaCode(err, "P2034")) throw new Error(PM_ERRORS.CONCURRENT_MUTATION);
    // The same link inserted by somebody else a moment ago: nothing was applied
    // here, and a retry finds it already there (an idempotent no-op).
    if (isPrismaCode(err, "P2002")) throw new Error(PM_ERRORS.CONCURRENT_MUTATION);
    // An item deleted between the existence read and the insert fails the FK.
    if (isPrismaCode(err, "P2003")) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
    throw err;
  }
  if (added > 0) nudgeOutbox();
  return { added, module: await getModule(prisma, moduleId) };
}

/** Take work items out of a module. Ids that were not in it are skipped. */
export async function removeModuleWorkItems(
  prisma: PrismaClient,
  actorId: string | null,
  moduleId: string,
  workItemIds: string[],
): Promise<{ removed: number; module: ApiModule }> {
  const ids = [...new Set(workItemIds)];
  let removed = 0;
  try {
    removed = await prisma.$transaction(async (tx) => {
      await loadModuleRow(tx, moduleId);
      const existing = await tx.pmModuleWorkItem.findMany({
        where: { moduleId, workItemId: { in: ids } },
        select: { workItemId: true },
      });
      const linked = existing.map((e) => e.workItemId);
      if (linked.length === 0) return 0;
      await tx.pmModuleWorkItem.deleteMany({ where: { moduleId, workItemId: { in: linked } } });
      await tx.pmActivity.createMany({
        data: linked.map((workItemId) => ({
          workItemId,
          actorId,
          verb: "module_removed" as const,
          field: "module",
          oldValue: moduleId,
          newValue: null,
        })),
      });
      return linked.length;
    }, SERIALIZABLE_TX);
  } catch (err) {
    if (isPrismaCode(err, "P2034")) throw new Error(PM_ERRORS.CONCURRENT_MUTATION);
    throw err;
  }
  if (removed > 0) nudgeOutbox();
  return { removed, module: await getModule(prisma, moduleId) };
}
