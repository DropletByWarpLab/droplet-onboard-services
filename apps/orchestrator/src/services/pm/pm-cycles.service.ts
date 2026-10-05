/**
 * WARP-3521 (ADR-069 slice WS-5) — cycles (sprints).
 *
 * `PmCycle` has existed since the ADR-026 foundation with no writer. This is the
 * writer, and the reader behind `GET /api/pm/cycles/:id/burndown`.
 *
 * ── the state machine ──────────────────────────────────────────────────────
 *
 *     draft ──start──▶ active ──complete──▶ completed
 *
 * `start` needs both dates and refuses a second active cycle in the project; the
 * database holds that last rule itself (the partial unique index
 * `PmCycle_projectId_active_key`) and the friendly pre-check here only exists so
 * the refusal can NAME the cycle in the way. `complete` is the interesting one:
 * it moves every unfinished item out of the cycle — to the backlog or to another
 * cycle — in ONE transaction, so a completed cycle never still holds open work.
 *
 * ── why `completeCycle` is SERIALIZABLE, and starts with a CAS ──────────────
 *
 * It is read-then-decide-then-write: read the unfinished items, move them. Under
 * READ COMMITTED an item finished between the read and the write would be moved
 * out of the cycle that earned it. SERIALIZABLE makes the loser abort (P2034,
 * answered `concurrent_mutation`, nothing applied, retry).
 *
 * SERIALIZABLE alone does not cover a work item PLANNED INTO the cycle while it
 * is completing — that write comes from `pm.service`'s READ COMMITTED
 * transaction, which Postgres' SSI does not watch. `lockAttachableCycle` closes
 * that side (see pm-planning.ts): attaching is a compare-and-set on the cycle
 * row, and completing opens with the mirror-image CAS on the same row, so the
 * two serialise on a row lock. Either the attach lands first and is moved with
 * the rest, or it finds the cycle completed and is refused.
 *
 * ── history ────────────────────────────────────────────────────────────────
 *
 * Every membership change writes a `PmActivity` row with `field = "cycle"` and
 * `oldValue` / `newValue` naming the cycle left and the cycle joined. The
 * burndown is rebuilt from those rows (pm-burndown.ts); there is no snapshot
 * table.
 *
 * Errors are `Error(code)` — see pm-planning.ts — mapped to HTTP in the route.
 */

import type { Prisma, PrismaClient, PmStateGroup } from "@prisma/client";
import { REPEATABLE_READ_TX, SERIALIZABLE_TX } from "../../lib/prisma-tx.js";
import { PM_ERRORS, isPrismaCode, isServiceDesk, listWorkItemsWhere, type ApiWorkItem } from "./pm.service.js";
import {
  reconstructBurndown,
  utcDayBoundaries,
  type BurndownEvent,
  type BurndownItem,
  type BurndownPoint,
} from "./pm-burndown.js";
import {
  MAX_CYCLE_DAYS,
  PM_PLANNING_ERRORS,
  PmPlanningError,
  daysInclusive,
  formatDateOnly,
  lockAttachableCycle,
} from "./pm-planning.js";
import { emptyProgress, summarizeProgress, type ApiPlanningProgress } from "./pm-progress.js";

/** A Prisma client OR an interactive-transaction handle. */
type Db = PrismaClient | Prisma.TransactionClient;

type CycleRow = Prisma.PmCycleGetPayload<object>;

// ── API shape ────────────────────────────────────────────────────────────────

export interface ApiCycle {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  /** Calendar dates, `YYYY-MM-DD`. */
  startDate: string | null;
  endDate: string | null;
  status: CycleRow["status"];
  /** The instant `completeCycle` ran. Null until then. */
  completedAt: string | null;
  /** How many unfinished items `completeCycle` moved out. 0 until then. */
  carriedOverCount: number;
  progress: ApiPlanningProgress;
  createdAt: string;
  updatedAt: string;
}

export interface ApiBurndown {
  cycleId: string;
  status: CycleRow["status"];
  startDate: string | null;
  endDate: string | null;
  /** The last day that has actual numbers (today, for a running cycle). */
  through: string | null;
  /** True when anything in scope carries an estimate — the chart hides the
   *  estimate series otherwise rather than draw a flat zero line. */
  hasEstimates: boolean;
  days: BurndownPoint[];
}

export interface CycleFields {
  name?: string;
  description?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
}

function mapCycle(row: CycleRow, progress: ApiPlanningProgress): ApiCycle {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    startDate: formatDateOnly(row.startDate),
    endDate: formatDateOnly(row.endDate),
    status: row.status,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    carriedOverCount: row.carriedOverCount,
    progress,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** End-before-start, or longer than a sprint has any business being. */
function assertDates(start: Date | null, end: Date | null): void {
  if (start && end) {
    if (end.getTime() < start.getTime()) {
      throw new PmPlanningError(PM_PLANNING_ERRORS.INVALID_DATES, { reason: "end_before_start" });
    }
    if (daysInclusive(start, end) > MAX_CYCLE_DAYS) {
      throw new PmPlanningError(PM_PLANNING_ERRORS.INVALID_DATES, {
        reason: "too_long",
        maxDays: MAX_CYCLE_DAYS,
      });
    }
  }
}

/**
 * Progress for a set of cycles in one query.
 *
 * Household-scale on purpose, like `listProjects`: this reads the attached
 * rows and folds them in memory. It is one round trip however many cycles are
 * listed, which is the property that matters here (no N+1).
 */
async function progressByCycle(
  db: Db,
  cycleIds: string[],
): Promise<Map<string, ApiPlanningProgress>> {
  const out = new Map<string, ApiPlanningProgress>();
  for (const id of cycleIds) out.set(id, emptyProgress());
  if (cycleIds.length === 0) return out;

  const rows = await db.pmWorkItem.findMany({
    where: { cycleId: { in: cycleIds }, isArchived: false },
    select: { cycleId: true, estimate: true, state: { select: { group: true } } },
  });
  const grouped = new Map<string, Array<{ estimate: number | null; state: { group: PmStateGroup } | null }>>();
  for (const r of rows) {
    if (!r.cycleId) continue;
    const list = grouped.get(r.cycleId) ?? [];
    list.push({ estimate: r.estimate, state: r.state });
    grouped.set(r.cycleId, list);
  }
  for (const [cycleId, list] of grouped) out.set(cycleId, summarizeProgress(list));
  return out;
}

async function loadCycleRow(db: Db, id: string): Promise<CycleRow> {
  const row = await db.pmCycle.findUnique({ where: { id }, include: { project: { select: { kind: true } } } });
  if (!row || isServiceDesk(row.project)) throw new Error(PM_PLANNING_ERRORS.CYCLE_NOT_FOUND);
  return row;
}

async function assertProject(db: Db, projectId: string): Promise<void> {
  const project = await db.pmProject.findUnique({ where: { id: projectId }, select: { id: true, kind: true } });
  if (!project || isServiceDesk(project)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Active first, then upcoming by start date (undated last), then completed
 *  newest first — the order the cycles view shows them in. */
function listRank(a: CycleRow, b: CycleRow): number {
  const rank = (c: CycleRow) => (c.status === "active" ? 0 : c.status === "draft" ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const time = (d: Date | null, missing: number) => (d ? d.getTime() : missing);
  if (a.status === "completed") {
    // newest end date first; an undated completed cycle sinks to the bottom
    const diff = time(b.endDate, -Infinity) - time(a.endDate, -Infinity);
    if (diff !== 0 && Number.isFinite(diff)) return diff;
    return b.createdAt.getTime() - a.createdAt.getTime();
  }
  const diff = time(a.startDate, Infinity) - time(b.startDate, Infinity);
  if (diff !== 0 && Number.isFinite(diff)) return diff;
  if (a.startDate && !b.startDate) return -1;
  if (!a.startDate && b.startDate) return 1;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

export async function listCycles(prisma: PrismaClient, projectId: string): Promise<ApiCycle[]> {
  await assertProject(prisma, projectId);
  const rows = await prisma.pmCycle.findMany({ where: { projectId } });
  const progress = await progressByCycle(
    prisma,
    rows.map((r) => r.id),
  );
  // `progressByCycle` pre-fills an entry for every id it is given, so a miss
  // here would be a bug worth a crash, not a zero worth hiding.
  return [...rows].sort(listRank).map((r) => mapCycle(r, progress.get(r.id)!));
}

export async function getCycle(prisma: PrismaClient, cycleId: string): Promise<ApiCycle> {
  const row = await loadCycleRow(prisma, cycleId);
  const progress = await progressByCycle(prisma, [row.id]);
  return mapCycle(row, progress.get(row.id)!);
}

/** The cycle's own work items, with the exact total (see `listWorkItemsWhere`). */
export async function listCycleWorkItems(
  prisma: PrismaClient,
  cycleId: string,
  opts: { perPage?: number; page?: number },
): Promise<{ work_items: ApiWorkItem[]; total: number }> {
  const cycle = await loadCycleRow(prisma, cycleId);
  const { items, total } = await listWorkItemsWhere(prisma, cycle.projectId, { cycleId }, opts);
  return { work_items: items, total };
}

/** The planning backlog: the project's UNFINISHED work that is in no cycle. */
export async function listBacklog(
  prisma: PrismaClient,
  projectId: string,
  opts: { perPage?: number; page?: number },
): Promise<{ work_items: ApiWorkItem[]; total: number }> {
  const { items, total } = await listWorkItemsWhere(
    prisma,
    projectId,
    { cycleId: null, isCompleted: false },
    opts,
  );
  return { work_items: items, total };
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createCycle(
  prisma: PrismaClient,
  projectId: string,
  input: { name: string; description?: string | null; startDate?: Date | null; endDate?: Date | null },
): Promise<ApiCycle> {
  await assertProject(prisma, projectId);
  const startDate = input.startDate ?? null;
  const endDate = input.endDate ?? null;
  assertDates(startDate, endDate);
  const row = await prisma.pmCycle.create({
    data: {
      projectId,
      name: input.name,
      description: input.description ?? null,
      startDate,
      endDate,
    },
  });
  return mapCycle(row, emptyProgress());
}

export async function updateCycle(
  prisma: PrismaClient,
  cycleId: string,
  fields: CycleFields,
): Promise<ApiCycle> {
  const existing = await loadCycleRow(prisma, cycleId);

  const data: Prisma.PmCycleUpdateManyMutationInput = {};
  if (fields.name !== undefined) data.name = fields.name;
  if (fields.description !== undefined) data.description = fields.description;
  if (fields.startDate !== undefined) data.startDate = fields.startDate;
  if (fields.endDate !== undefined) data.endDate = fields.endDate;

  // Nothing to change: answer the cycle as it is. The write below is an
  // `updateMany`, and Prisma issues no UPDATE for an empty `data` and reports
  // `count: 0` — the same figure as "lost the race", so `PATCH {}` on an
  // untouched cycle used to answer 409 concurrent_mutation (WS-5 review S3).
  // `updateModule` is a no-op for `{}` as well; the two now agree. This also
  // runs before the date rules so an empty patch cannot be refused on the
  // strength of data it does not touch.
  if (Object.keys(data).length === 0) return getCycle(prisma, cycleId);

  const touchesDates = fields.startDate !== undefined || fields.endDate !== undefined;

  // A completed cycle's dates are history: the burndown and every "which sprint
  // was that" question read them. Its name and description stay editable.
  if (existing.status === "completed" && touchesDates) {
    throw new Error(PM_PLANNING_ERRORS.CYCLE_COMPLETED);
  }

  const startDate = fields.startDate !== undefined ? fields.startDate : existing.startDate;
  const endDate = fields.endDate !== undefined ? fields.endDate : existing.endDate;
  // An active cycle is being charted: it cannot lose either end.
  if (existing.status === "active" && (!startDate || !endDate)) {
    throw new Error(PM_PLANNING_ERRORS.CYCLE_DATES_REQUIRED);
  }
  assertDates(startDate, endDate);

  // The rules above were decided on the `status` just read; the write is
  // conditioned on it still being that status. Otherwise a cycle that was started
  // or completed in between would take a date change its new status forbids
  // (a read-check-then-write on a status column — the TOCTOU the review
  // checklist's P1 describes). A loser applied nothing and is told to retry.
  const written = await prisma.pmCycle.updateMany({
    where: { id: cycleId, status: existing.status },
    data,
  });
  if (written.count !== 1) {
    const still = await prisma.pmCycle.findUnique({ where: { id: cycleId }, select: { id: true } });
    throw new Error(still ? PM_ERRORS.CONCURRENT_MUTATION : PM_PLANNING_ERRORS.CYCLE_NOT_FOUND);
  }
  return getCycle(prisma, cycleId);
}

/**
 * Delete a cycle. Its items are NOT deleted — `PmWorkItem.cycleId` is ON DELETE
 * SET NULL — but that detach is silent at the database, so this audits it first:
 * one `cycle_removed` row per attached item, in the same transaction, the
 * discipline WARP-885 set for `parentId`. The cycle row is claimed with a
 * compare-and-set up front so a racing attach either lands before this reads
 * the member list (and is audited with the rest) or finds the cycle gone.
 */
export async function deleteCycle(
  prisma: PrismaClient,
  actorId: string | null,
  cycleId: string,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await loadCycleRow(tx, cycleId);
      const claimed = await tx.pmCycle.updateMany({
        where: { id: cycleId },
        data: { updatedAt: new Date() },
      });
      if (claimed.count !== 1) throw new Error(PM_PLANNING_ERRORS.CYCLE_NOT_FOUND);

      const members = await tx.pmWorkItem.findMany({
        where: { cycleId },
        select: { id: true },
      });
      if (members.length > 0) {
        await tx.pmActivity.createMany({
          data: members.map((m) => ({
            workItemId: m.id,
            actorId,
            verb: "cycle_removed" as const,
            field: "cycle",
            oldValue: cycleId,
            newValue: null,
          })),
        });
      }
      await tx.pmCycle.delete({ where: { id: cycleId } });
    });
  } catch (err) {
    if (isPrismaCode(err, "P2025")) throw new Error(PM_PLANNING_ERRORS.CYCLE_NOT_FOUND);
    throw err;
  }
}

/**
 * draft → active. The pre-check exists to NAME the cycle in the way; the
 * compare-and-set and the unique index are what actually decide, so two starts
 * that both pass the pre-check still produce exactly one winner.
 */
export async function startCycle(prisma: PrismaClient, cycleId: string): Promise<ApiCycle> {
  const cycle = await loadCycleRow(prisma, cycleId);
  if (cycle.status !== "draft") throw new Error(PM_PLANNING_ERRORS.CYCLE_NOT_DRAFT);
  if (!cycle.startDate || !cycle.endDate) throw new Error(PM_PLANNING_ERRORS.CYCLE_DATES_REQUIRED);

  const inTheWay = await prisma.pmCycle.findFirst({
    where: { projectId: cycle.projectId, status: "active", id: { not: cycleId } },
    select: { id: true, name: true },
  });
  if (inTheWay) {
    throw new PmPlanningError(PM_PLANNING_ERRORS.CYCLE_ALREADY_ACTIVE, {
      activeCycleId: inTheWay.id,
      activeCycleName: inTheWay.name,
    });
  }

  let claimed: { count: number };
  try {
    claimed = await prisma.pmCycle.updateMany({
      where: { id: cycleId, status: "draft" },
      data: { status: "active" },
    });
  } catch (err) {
    // Lost the race to the partial unique index.
    if (isPrismaCode(err, "P2002")) throw new Error(PM_PLANNING_ERRORS.CYCLE_ALREADY_ACTIVE);
    throw err;
  }
  if (claimed.count !== 1) {
    // Vanished or was started under us between the read and the claim.
    const now = await prisma.pmCycle.findUnique({ where: { id: cycleId }, select: { status: true } });
    throw new Error(now ? PM_PLANNING_ERRORS.CYCLE_NOT_DRAFT : PM_PLANNING_ERRORS.CYCLE_NOT_FOUND);
  }
  return getCycle(prisma, cycleId);
}

/**
 * active → completed, moving every unfinished item out in the same transaction.
 *
 * `moveIncompleteTo` is a cycle id or `null` (the backlog). "Unfinished" is
 * `isCompleted = false` — NOT "not archived": hidden is not finished, and an
 * archived open item left behind would be exactly the stranded work this exists
 * to prevent. Finished items (done or cancelled) stay, which is what makes a
 * completed cycle a record of what it delivered.
 *
 * One activity row per moved item. A move into another cycle is a single
 * `cycle_added` row {this → target}, a move to the backlog a single
 * `cycle_removed` row {this → null}.
 */
export async function completeCycle(
  prisma: PrismaClient,
  actorId: string | null,
  cycleId: string,
  input: { moveIncompleteTo: string | null },
): Promise<{ cycle: ApiCycle; moved: { count: number; to: string | null } }> {
  const target = input.moveIncompleteTo;
  let movedCount = 0;
  try {
    movedCount = await prisma.$transaction(async (tx) => {
      const cycle = await loadCycleRow(tx, cycleId);
      if (cycle.status !== "active") throw new Error(PM_PLANNING_ERRORS.CYCLE_NOT_ACTIVE);
      if (target === cycleId) throw new Error(PM_PLANNING_ERRORS.INVALID_CYCLE);

      // The claim. First write of the transaction, on purpose — see the header.
      const claimed = await tx.pmCycle.updateMany({
        where: { id: cycleId, status: "active" },
        data: { status: "completed", completedAt: new Date() },
      });
      if (claimed.count !== 1) throw new Error(PM_PLANNING_ERRORS.CYCLE_NOT_ACTIVE);

      if (target !== null) await lockAttachableCycle(tx, target, cycle.projectId);

      const unfinished = await tx.pmWorkItem.findMany({
        where: { cycleId, isCompleted: false },
        select: { id: true, isArchived: true },
      });
      if (unfinished.length > 0) {
        await tx.pmWorkItem.updateMany({
          where: { id: { in: unfinished.map((u) => u.id) }, cycleId, isCompleted: false },
          data: { cycleId: target },
        });
        await tx.pmActivity.createMany({
          data: unfinished.map((u) => ({
            workItemId: u.id,
            actorId,
            verb: target === null ? ("cycle_removed" as const) : ("cycle_added" as const),
            field: "cycle",
            oldValue: cycleId,
            newValue: target,
          })),
        });
      }
      await tx.pmCycle.update({
        where: { id: cycleId },
        // The cycle card's visible progress excludes archived items, so its
        // denominator must count only visible work carried forward. All
        // unfinished items (including archived ones) are still moved above.
        data: { carriedOverCount: unfinished.filter((item) => !item.isArchived).length },
      });
      return unfinished.length;
    }, SERIALIZABLE_TX);
  } catch (err) {
    // The SERIALIZABLE loser: something changed an item (or the cycle) under
    // us. Nothing was applied; the route answers 409 and the client retries.
    if (isPrismaCode(err, "P2034")) throw new Error(PM_ERRORS.CONCURRENT_MUTATION);
    if (isPrismaCode(err, "P2025")) throw new Error(PM_PLANNING_ERRORS.CYCLE_NOT_FOUND);
    throw err;
  }
  return { cycle: await getCycle(prisma, cycleId), moved: { count: movedCount, to: target } };
}

// ── Burndown ─────────────────────────────────────────────────────────────────

function isTerminal(group: PmStateGroup | null | undefined): boolean {
  return group === "completed" || group === "cancelled";
}

/** The UTC midnight a cycle chart STARTS and the number of days it spans, or
 *  null when the cycle has no dates to chart. A completed cycle's chart stops
 *  the day it was completed if that was before its planned end. */
function chartWindow(cycle: CycleRow): { first: string; count: number } | null {
  if (!cycle.startDate || !cycle.endDate) return null;
  let last = cycle.endDate;
  if (cycle.status === "completed" && cycle.completedAt) {
    const completedDay = new Date(
      Date.UTC(
        cycle.completedAt.getUTCFullYear(),
        cycle.completedAt.getUTCMonth(),
        cycle.completedAt.getUTCDate(),
      ),
    );
    if (completedDay.getTime() < last.getTime()) last = completedDay;
    if (last.getTime() < cycle.startDate.getTime()) last = cycle.startDate;
  }
  const count = Math.min(daysInclusive(cycle.startDate, last), MAX_CYCLE_DAYS);
  return { first: formatDateOnly(cycle.startDate)!, count };
}

/**
 * The burndown of one cycle, rebuilt from `PmActivity` (see pm-burndown.ts for
 * the method and its one deliberate bias towards the live rows).
 *
 * Several reads compose one answer, so they share one snapshot (REPEATABLE
 * READ — `lib/prisma-tx.ts` explains why not SERIALIZABLE for a read-only
 * transaction). `now` is injectable so a test owns the clock.
 *
 * Cost note, stated rather than discovered: the membership events are found by
 * `verb` + `oldValue` / `newValue`, and nothing indexes those, so this scans
 * `PmActivity`. That is milliseconds at household scale and it is a cycle-detail
 * read, not a poll; if a box ever shows millions of activity rows, a pair of
 * partial indexes on the two cycle verbs is the fix.
 */
export async function getCycleBurndown(
  prisma: PrismaClient,
  cycleId: string,
  opts: { now?: Date } = {},
): Promise<ApiBurndown> {
  const now = opts.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const cycle = await loadCycleRow(tx, cycleId);
    const base = {
      cycleId: cycle.id,
      status: cycle.status,
      startDate: formatDateOnly(cycle.startDate),
      endDate: formatDateOnly(cycle.endDate),
    };
    const window = chartWindow(cycle);
    if (!window) return { ...base, through: null, hasEstimates: false, days: [] };

    const states = await tx.pmState.findMany({
      where: { projectId: cycle.projectId },
      select: { id: true, group: true },
    });
    const groupOf = new Map(states.map((s) => [s.id, s.group]));

    // Every item that is, or ever was, in this cycle.
    const membershipRows = await tx.pmActivity.findMany({
      where: {
        verb: { in: ["cycle_added", "cycle_removed"] },
        OR: [{ oldValue: cycleId }, { newValue: cycleId }],
      },
      orderBy: { createdAt: "asc" },
      select: { workItemId: true, oldValue: true, newValue: true, createdAt: true },
    });
    const attached = await tx.pmWorkItem.findMany({
      where: { cycleId, isArchived: false },
      select: { id: true },
    });
    const itemIds = [...new Set([...membershipRows.map((r) => r.workItemId), ...attached.map((a) => a.id)])];
    if (itemIds.length === 0) {
      const days = reconstructBurndown({
        days: utcDayBoundaries(window.first, window.count),
        items: [],
        events: [],
        now,
      });
      return { ...base, through: lastActualDate(days), hasEstimates: false, days };
    }

    const itemRows = await tx.pmWorkItem.findMany({
      where: { id: { in: itemIds }, isArchived: false },
      select: { id: true, cycleId: true, isCompleted: true, estimate: true },
    });
    const live = new Set(itemRows.map((i) => i.id));
    const stateRows = await tx.pmActivity.findMany({
      where: { workItemId: { in: itemIds }, verb: "state_changed" },
      orderBy: { createdAt: "asc" },
      select: { workItemId: true, oldValue: true, newValue: true, createdAt: true },
    });

    const items: BurndownItem[] = itemRows.map((i) => ({
      id: i.id,
      memberNow: i.cycleId === cycleId,
      terminalNow: i.isCompleted,
      weight: i.estimate ?? 0,
    }));

    const events: BurndownEvent[] = [];
    for (const r of membershipRows) {
      if (!live.has(r.workItemId)) continue;
      const leaves = r.oldValue === cycleId;
      const joins = r.newValue === cycleId;
      if (leaves === joins) continue; // names this cycle on neither side (or both): not a membership change
      events.push({ kind: "membership", itemId: r.workItemId, at: r.createdAt, wasMember: leaves });
    }
    for (const r of stateRows) {
      if (!live.has(r.workItemId)) continue;
      // A state id that is no longer in the project (deleted) or an item with
      // no state reads as OPEN: nothing better is knowable, and open is the
      // reading that never overstates progress.
      const was = isTerminal(r.oldValue ? groupOf.get(r.oldValue) : null);
      const became = isTerminal(r.newValue ? groupOf.get(r.newValue) : null);
      if (was === became) continue; // moved between two open (or two closed) states
      events.push({ kind: "terminal", itemId: r.workItemId, at: r.createdAt, wasTerminal: was });
    }

    const days = reconstructBurndown({
      days: utcDayBoundaries(window.first, window.count),
      items,
      events,
      now,
    });
    return {
      ...base,
      through: lastActualDate(days),
      hasEstimates: items.some((i) => i.weight > 0),
      days,
    };
  }, REPEATABLE_READ_TX);
}

function lastActualDate(days: BurndownPoint[]): string | null {
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].scope !== null) return days[i].date;
  }
  return null;
}
