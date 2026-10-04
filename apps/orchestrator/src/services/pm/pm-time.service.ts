/**
 * WARP-3526 (ADR-069 WS-10) — time tracking: worklogs, the one running timer a
 * person may have, weekly timesheets and time reports.
 *
 * Lives beside pm.service.ts rather than inside it, for the reason
 * pm-relations.service.ts gives: this module opens its own transactions with an
 * explicit isolation level, and several slices edit pm.service.ts at once. It
 * borrows only the error vocabulary, the Prisma-code predicate and the one
 * activity writer from it.
 *
 * ── the model ──────────────────────────────────────────────────────────────
 *
 * A `PmWorklog` is a span of work somebody SPENT on an item: who, when it
 * began, how many minutes (1..1440), a note. A `PmTimer` is the clock a person
 * has running; its primary key is `userId`, so one running timer per person is
 * the database's rule, not this module's. Stopping a timer deletes the row and
 * writes a worklog in the same transaction, so time is never in both places or
 * in neither.
 *
 * ── "starting a second timer stops the first" ──────────────────────────────
 *
 * `startTimer` is read-then-decide-then-write: look at the person's running
 * timer, stop it if there is one, insert the new one. Two requests from the same
 * person at once — a double click, two tabs — would both read "no timer" and
 * both insert, and the primary key would turn the loser into a 500. So every
 * timer write first takes a transaction-scoped advisory lock keyed on the
 * person. The second request waits, then reads what the first committed, and
 * does the right thing: starting the item already running is a no-op, starting
 * another stops the first and writes exactly one worklog. READ COMMITTED
 * (explicit, `READ_COMMITTED_TX`) is what makes that work — each statement after
 * the lock takes a fresh snapshot — and is why this is NOT a SERIALIZABLE
 * transaction: under SSI the loser of a double click would be a spurious 409
 * for a request that should simply succeed. (`activity.service.ts` documents why
 * `SELECT ... FOR UPDATE` cannot do this job: it locks nothing when no row
 * exists yet, and EvalPlanQual does not re-scan.)
 *
 * The primary key stays as the backstop: a P2002 here means a writer that did
 * not take the lock, and is answered 409 CONCURRENT_MUTATION rather than 500.
 *
 * ── who may do what ────────────────────────────────────────────────────────
 *
 * Entries are the writer's own; an owner or admin may log, correct or remove
 * anyone's (`TimeActor.canManageAll`). The route layer admits the write roles
 * only and NOT the MCP service principal: an entry needs a person who spent the
 * time, and the assistant has none. Reads are household-shared like the rest of
 * PM. An external guest reaches none of it — the `projects` tier floor answers
 * 404 for the whole of `/api/pm` before a route runs.
 *
 * Errors are plain `Error(code)` with stable string codes, as pm.service.ts does.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { READ_COMMITTED_TX } from "../../lib/prisma-tx.js";
import { PM_ERRORS, isPrismaCode, writeActivity } from "./pm.service.js";
import {
  FUTURE_START_SKEW_MS,
  WORKLOG_MAX_MINUTES,
  WORKLOG_MIN_MINUTES,
  dayIndex,
  groupKey,
  resolveRange,
  resolveWeek,
  resolveZone,
  timerMinutes,
  type ReportGroupBy,
} from "./pm-time.js";

export const PM_TIME_ERRORS = {
  WORKLOG_NOT_FOUND: "worklog_not_found",
  TIMER_NOT_FOUND: "timer_not_found",
  /** Somebody else's entry, and the caller is not an owner or admin. */
  WORKLOG_FORBIDDEN: "worklog_forbidden",
  /** The item (or its project) is archived: no new time, no new timer. */
  WORK_ITEM_ARCHIVED: "work_item_archived",
  STARTED_AT_IN_FUTURE: "started_at_in_future",
  INVALID_MINUTES: "invalid_minutes",
  /** An owner or admin logged time for a person who is not in the directory. */
  USER_NOT_FOUND: "user_not_found",
} as const;

/** The caller, as far as time tracking cares. */
export interface TimeActor {
  /** `User.id` — never the MCP service principal; the route refuses that. */
  id: string;
  /** Owner or admin: may log, correct and remove anybody's entries. */
  canManageAll: boolean;
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

export interface ApiWorklog {
  id: string;
  workItemId: string;
  /** The person who spent the time. */
  userId: string;
  startedAt: string;
  minutes: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** Enough of a work item to label time against it, without a second request. */
export interface ApiTimeItemRef {
  id: string;
  /** The human key, e.g. INBOX-42. */
  key: string;
  name: string;
  projectId: string;
  /** The item, or the project it is in, is archived. */
  archived: boolean;
}

export interface ApiTimer {
  userId: string;
  workItemId: string;
  startedAt: string;
  workItem: ApiTimeItemRef;
}

export interface ApiWorklogList {
  /** Newest first; at most `WORKLOG_LIST_LIMIT`. */
  worklogs: ApiWorklog[];
  /** Over EVERY entry on the item, not just the ones listed. */
  totalMinutes: number;
  totalEntries: number;
}

export interface ApiTimesheetEntry extends ApiWorklog {
  workItem: ApiTimeItemRef;
}

export interface ApiTimesheet {
  userId: string;
  tz: string;
  /** The Monday that opens the week, `YYYY-MM-DD` in `tz`. */
  weekStart: string;
  /** Seven local dates, Monday to Sunday. */
  days: string[];
  rows: Array<{
    workItem: ApiTimeItemRef;
    /** Minutes per day, aligned with `days`. */
    minutes: number[];
    totalMinutes: number;
  }>;
  dayTotals: number[];
  totalMinutes: number;
  /** The week's entries, newest first. */
  entries: ApiTimesheetEntry[];
}

export interface ApiTimeReportRow {
  /** User.id, work-item id or local date, by `groupBy`. */
  key: string;
  /** A person's display name, a work item's title, or the date. */
  label: string;
  /** The human key of a work item (`groupBy=item`), else null. */
  itemKey: string | null;
  minutes: number;
  entries: number;
}

export interface ApiTimeReport {
  groupBy: ReportGroupBy;
  /** Inclusive local dates, as asked. */
  from: string;
  to: string;
  tz: string;
  projectId: string | null;
  rows: ApiTimeReportRow[];
  total: { minutes: number; entries: number };
}

/** How many entries one item's list returns; the totals are over all of them. */
export const WORKLOG_LIST_LIMIT = 200;
/** Worklogs read per page while a report is summed — bounds memory, not the answer. */
const REPORT_BATCH = 2000;

// ── Row shapes + mappers ────────────────────────────────────────────────────

const ITEM_REF_SELECT = {
  id: true,
  name: true,
  sequenceId: true,
  projectId: true,
  isArchived: true,
  project: { select: { identifier: true, isArchived: true } },
} satisfies Prisma.PmWorkItemSelect;

type ItemRefRow = Prisma.PmWorkItemGetPayload<{ select: typeof ITEM_REF_SELECT }>;
type WorklogRow = Prisma.PmWorklogGetPayload<object>;
type TimerRow = Prisma.PmTimerGetPayload<object>;

function mapItemRef(row: ItemRefRow): ApiTimeItemRef {
  return {
    id: row.id,
    key: `${row.project.identifier}-${row.sequenceId}`,
    name: row.name,
    projectId: row.projectId,
    archived: row.isArchived || row.project.isArchived,
  };
}

function mapWorklog(row: WorklogRow): ApiWorklog {
  return {
    id: row.id,
    workItemId: row.workItemId,
    userId: row.userId,
    startedAt: row.startedAt.toISOString(),
    minutes: row.minutes,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapTimer(row: TimerRow, item: ItemRefRow): ApiTimer {
  return {
    userId: row.userId,
    workItemId: row.workItemId,
    startedAt: row.startedAt.toISOString(),
    workItem: mapItemRef(item),
  };
}

// ── Guards ──────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

function assertMinutes(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < WORKLOG_MIN_MINUTES || minutes > WORKLOG_MAX_MINUTES) {
    throw new Error(PM_TIME_ERRORS.INVALID_MINUTES);
  }
}

/** Logged time is time already spent: a start more than a few minutes ahead of
 *  the box's clock is refused, so a report never counts hours nobody worked. */
function assertNotFuture(startedAt: Date, now: Date): void {
  if (startedAt.getTime() > now.getTime() + FUTURE_START_SKEW_MS) {
    throw new Error(PM_TIME_ERRORS.STARTED_AT_IN_FUTURE);
  }
}

/** An entry is its writer's to change; an owner or admin may change anybody's.
 *  `userId` is immutable, so this read-then-write cannot be raced into a
 *  different answer between the check and the write. */
function assertMayChange(actor: TimeActor, entryUserId: string): void {
  if (entryUserId !== actor.id && !actor.canManageAll) {
    throw new Error(PM_TIME_ERRORS.WORKLOG_FORBIDDEN);
  }
}

/** The item exists and neither it nor its project is archived. */
async function loadTrackableItem(db: Db, workItemId: string): Promise<ItemRefRow> {
  const row = await db.pmWorkItem.findUnique({ where: { id: workItemId }, select: ITEM_REF_SELECT });
  if (!row) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  if (row.isArchived || row.project.isArchived) throw new Error(PM_TIME_ERRORS.WORK_ITEM_ARCHIVED);
  return row;
}

/** Ids per `IN (...)` lookup — far under the driver's bind-parameter ceiling. */
const ID_LOOKUP_CHUNK = 1000;

/** Item refs for a set of ids: one query per thousand ids, never one per id. */
async function loadItemRefs(db: Db, ids: readonly string[]): Promise<Map<string, ApiTimeItemRef>> {
  const out = new Map<string, ApiTimeItemRef>();
  for (let i = 0; i < ids.length; i += ID_LOOKUP_CHUNK) {
    const rows = await db.pmWorkItem.findMany({
      where: { id: { in: ids.slice(i, i + ID_LOOKUP_CHUNK) } },
      select: ITEM_REF_SELECT,
    });
    for (const r of rows) out.set(r.id, mapItemRef(r));
  }
  return out;
}

// ── Worklogs ────────────────────────────────────────────────────────────────

export async function listWorklogs(prisma: PrismaClient, workItemId: string): Promise<ApiWorklogList> {
  const item = await prisma.pmWorkItem.findUnique({ where: { id: workItemId }, select: { id: true } });
  if (!item) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  const [rows, sum] = await Promise.all([
    prisma.pmWorklog.findMany({
      where: { workItemId },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: WORKLOG_LIST_LIMIT,
    }),
    prisma.pmWorklog.aggregate({
      where: { workItemId },
      _sum: { minutes: true },
      _count: { _all: true },
    }),
  ]);
  return {
    worklogs: rows.map(mapWorklog),
    totalMinutes: sum._sum.minutes ?? 0,
    totalEntries: sum._count._all,
  };
}

export interface WorklogInput {
  minutes: number;
  /** When the work began. Defaults to now. */
  startedAt?: Date;
  note?: string;
  /** Log on behalf of another person — owner or admin only. */
  userId?: string;
}

export async function createWorklog(
  prisma: PrismaClient,
  actor: TimeActor,
  workItemId: string,
  input: WorklogInput,
  now: Date = new Date(),
): Promise<ApiWorklog> {
  assertMinutes(input.minutes);
  const userId = input.userId ?? actor.id;
  assertMayChange(actor, userId);
  const startedAt = input.startedAt ?? now;
  assertNotFuture(startedAt, now);
  if (userId !== actor.id) {
    const person = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!person) throw new Error(PM_TIME_ERRORS.USER_NOT_FOUND);
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await loadTrackableItem(tx, workItemId);
      const row = await tx.pmWorklog.create({
        data: { workItemId, userId, startedAt, minutes: input.minutes, note: input.note ?? "" },
      });
      await writeActivity(tx, {
        workItemId,
        actorId: actor.id,
        verb: "time_logged",
        field: "worklog",
        newValue: String(row.minutes),
      });
      return mapWorklog(row);
    }, READ_COMMITTED_TX);
  } catch (err) {
    // The item was deleted between the read above and this insert.
    if (isPrismaCode(err, "P2003")) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
    throw err;
  }
}

export interface WorklogPatch {
  minutes?: number;
  startedAt?: Date;
  /** `""` clears the note. */
  note?: string;
}

export async function updateWorklog(
  prisma: PrismaClient,
  actor: TimeActor,
  id: string,
  patch: WorklogPatch,
  now: Date = new Date(),
): Promise<ApiWorklog> {
  if (patch.minutes !== undefined) assertMinutes(patch.minutes);
  if (patch.startedAt !== undefined) assertNotFuture(patch.startedAt, now);
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.pmWorklog.findUnique({ where: { id } });
      if (!existing) throw new Error(PM_TIME_ERRORS.WORKLOG_NOT_FOUND);
      assertMayChange(actor, existing.userId);

      const changed =
        (patch.minutes !== undefined && patch.minutes !== existing.minutes) ||
        (patch.startedAt !== undefined && patch.startedAt.getTime() !== existing.startedAt.getTime()) ||
        (patch.note !== undefined && patch.note !== existing.note);
      // A save that changes nothing writes nothing — no row, no activity.
      if (!changed) return mapWorklog(existing);

      // `undefined` is "leave it", which is what PATCH means; clearing a note is
      // `""`, an ordinary value, so no field here depends on `?? undefined`.
      const row = await tx.pmWorklog.update({
        where: { id },
        data: { minutes: patch.minutes, startedAt: patch.startedAt, note: patch.note },
      });
      await writeActivity(tx, {
        workItemId: row.workItemId,
        actorId: actor.id,
        verb: "time_log_updated",
        field: "worklog",
        oldValue: String(existing.minutes),
        newValue: String(row.minutes),
      });
      return mapWorklog(row);
    }, READ_COMMITTED_TX);
  } catch (err) {
    if (isPrismaCode(err, "P2025")) throw new Error(PM_TIME_ERRORS.WORKLOG_NOT_FOUND);
    throw err;
  }
}

export async function deleteWorklog(prisma: PrismaClient, actor: TimeActor, id: string): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.pmWorklog.findUnique({ where: { id } });
      if (!existing) throw new Error(PM_TIME_ERRORS.WORKLOG_NOT_FOUND);
      assertMayChange(actor, existing.userId);
      await tx.pmWorklog.delete({ where: { id } });
      await writeActivity(tx, {
        workItemId: existing.workItemId,
        actorId: actor.id,
        verb: "time_log_removed",
        field: "worklog",
        oldValue: String(existing.minutes),
      });
    }, READ_COMMITTED_TX);
  } catch (err) {
    if (isPrismaCode(err, "P2025")) throw new Error(PM_TIME_ERRORS.WORKLOG_NOT_FOUND);
    throw err;
  }
}

// ── Timer ───────────────────────────────────────────────────────────────────

/**
 * Serialise every timer write for one person for the rest of the transaction.
 * The wrapper turns the `void` result into a boolean column Prisma can read
 * (the same workaround activity.service.ts documents); the value is ignored.
 */
async function lockTimerOf(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT (pg_advisory_xact_lock(hashtext(${`droplet:pm-timer:${userId}`})) IS NULL) AS locked`;
}

/** Stop a running timer: write its worklog, delete it, record the time. Runs
 *  inside the caller's transaction, under that person's lock. */
async function stopRunningTimer(
  tx: Tx,
  running: TimerRow,
  now: Date,
): Promise<{ worklog: ApiWorklog; capped: boolean }> {
  const { minutes, capped } = timerMinutes(running.startedAt, now);
  const row = await tx.pmWorklog.create({
    data: {
      workItemId: running.workItemId,
      userId: running.userId,
      startedAt: running.startedAt,
      minutes,
      note: "",
    },
  });
  await tx.pmTimer.delete({ where: { userId: running.userId } });
  await writeActivity(tx, {
    workItemId: running.workItemId,
    // The person whose clock it was: stopping a timer is them logging their time.
    actorId: running.userId,
    verb: "time_logged",
    field: "worklog",
    newValue: String(minutes),
  });
  return { worklog: mapWorklog(row), capped };
}

/** The caller's running timer, with the item it is on, or null. */
export async function getTimer(prisma: PrismaClient, userId: string): Promise<ApiTimer | null> {
  const row = await prisma.pmTimer.findUnique({
    where: { userId },
    include: { workItem: { select: ITEM_REF_SELECT } },
  });
  return row ? mapTimer(row, row.workItem) : null;
}

/**
 * Start the caller's timer on `workItemId`.
 *
 * Already running on that item → nothing changes and nothing is written. Running
 * on another → that one is stopped first, in the same transaction, and its
 * worklog is returned as `stopped`. Either way the person ends with exactly one
 * running timer. Nothing is stopped if the new item is refused (missing or
 * archived): the check comes first, so a refused start leaves the old timer
 * running.
 */
export async function startTimer(
  prisma: PrismaClient,
  userId: string,
  workItemId: string,
  now: Date = new Date(),
): Promise<{ timer: ApiTimer; stopped: ApiWorklog | null }> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimerOf(tx, userId);
      const item = await loadTrackableItem(tx, workItemId);
      const running = await tx.pmTimer.findUnique({ where: { userId } });
      if (running && running.workItemId === workItemId) {
        return { timer: mapTimer(running, item), stopped: null };
      }
      const stopped = running ? (await stopRunningTimer(tx, running, now)).worklog : null;
      const timer = await tx.pmTimer.create({ data: { userId, workItemId, startedAt: now } });
      return { timer: mapTimer(timer, item), stopped };
    }, READ_COMMITTED_TX);
  } catch (err) {
    // A writer that skipped the lock hit the primary key: nothing was applied.
    if (isPrismaCode(err, "P2002")) throw new Error(PM_ERRORS.CONCURRENT_MUTATION);
    // The item was deleted between the read and the insert.
    if (isPrismaCode(err, "P2003")) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
    throw err;
  }
}

/** Stop the caller's timer and log the time it ran. */
export async function stopTimer(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<{ worklog: ApiWorklog; capped: boolean }> {
  return prisma.$transaction(async (tx) => {
    await lockTimerOf(tx, userId);
    const running = await tx.pmTimer.findUnique({ where: { userId } });
    if (!running) throw new Error(PM_TIME_ERRORS.TIMER_NOT_FOUND);
    return stopRunningTimer(tx, running, now);
  }, READ_COMMITTED_TX);
}

// ── Timesheet ───────────────────────────────────────────────────────────────

const byItemKey = (a: ApiTimeItemRef, b: ApiTimeItemRef): number =>
  a.key.localeCompare(b.key, "en", { numeric: true });

/**
 * One person's week: a row per work item they logged against, a column per
 * local day Monday to Sunday, and the week's entries for editing. Weeks start on
 * Monday in `tz` (default UTC); an entry sits in the day it started on.
 */
export async function getTimesheet(
  prisma: PrismaClient,
  opts: { userId: string; weekStart?: string; tz?: string },
  now: Date = new Date(),
): Promise<ApiTimesheet> {
  const tz = resolveZone(opts.tz);
  const week = resolveWeek(opts.weekStart, tz, now);
  const entries = await prisma.pmWorklog.findMany({
    where: { userId: opts.userId, startedAt: { gte: week.from, lt: week.to } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
  });
  const items = await loadItemRefs(prisma, [...new Set(entries.map((e) => e.workItemId))]);

  const grid = new Map<string, number[]>();
  const dayTotals: number[] = week.days.map(() => 0);
  const withItem: ApiTimesheetEntry[] = [];
  for (const e of entries) {
    const item = items.get(e.workItemId);
    // The cascade means an entry always has its item; a missing one would be a
    // read racing a delete, and is simply not on a sheet that is gone.
    if (!item) continue;
    const col = dayIndex(week.days, e.startedAt, tz);
    if (col < 0) continue;
    const cells = grid.get(e.workItemId) ?? week.days.map(() => 0);
    cells[col] += e.minutes;
    grid.set(e.workItemId, cells);
    dayTotals[col] += e.minutes;
    withItem.push({ ...mapWorklog(e), workItem: item });
  }

  const rows = [...grid.entries()]
    .map(([workItemId, minutes]) => ({
      workItem: items.get(workItemId)!,
      minutes,
      totalMinutes: minutes.reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => byItemKey(a.workItem, b.workItem));

  return {
    userId: opts.userId,
    tz,
    weekStart: week.weekStart,
    days: week.days,
    rows,
    dayTotals,
    totalMinutes: dayTotals.reduce((a, b) => a + b, 0),
    entries: withItem,
  };
}

// ── Report ──────────────────────────────────────────────────────────────────

/**
 * Time over an inclusive local date range, grouped by person, work item or day.
 *
 * The totals are summed from the worklogs themselves, a page at a time (a keyset
 * on `id`, so a page boundary can neither repeat nor skip an entry), and every
 * group's minutes are added to the grand total as the entries arrive — so the
 * report's total is, by construction, the sum of the worklogs it covers, which
 * pm-time.pg.test.ts checks against a direct SUM. Labels (names, keys) are
 * resolved afterwards in one batched query per kind.
 */
export async function getTimeReport(
  prisma: PrismaClient,
  opts: { projectId?: string; from: string; to: string; groupBy?: ReportGroupBy; tz?: string },
): Promise<ApiTimeReport> {
  const tz = resolveZone(opts.tz);
  const range = resolveRange(opts.from, opts.to, tz);
  const groupBy = opts.groupBy ?? "user";
  if (opts.projectId !== undefined) {
    const project = await prisma.pmProject.findUnique({
      where: { id: opts.projectId },
      select: { id: true },
    });
    if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
  }

  const where: Prisma.PmWorklogWhereInput = {
    startedAt: { gte: range.from, lt: range.to },
    ...(opts.projectId !== undefined ? { workItem: { projectId: opts.projectId } } : {}),
  };
  const groups = new Map<string, { minutes: number; entries: number }>();
  const total = { minutes: 0, entries: 0 };
  let afterId: string | undefined;
  for (;;) {
    const page = await prisma.pmWorklog.findMany({
      where: afterId === undefined ? where : { AND: [where, { id: { gt: afterId } }] },
      select: { id: true, workItemId: true, userId: true, startedAt: true, minutes: true },
      orderBy: { id: "asc" },
      take: REPORT_BATCH,
    });
    for (const r of page) {
      const key = groupKey(r, groupBy, tz);
      const g = groups.get(key) ?? { minutes: 0, entries: 0 };
      g.minutes += r.minutes;
      g.entries += 1;
      groups.set(key, g);
      total.minutes += r.minutes;
      total.entries += 1;
    }
    if (page.length < REPORT_BATCH) break;
    afterId = page[page.length - 1].id;
  }

  const keys = [...groups.keys()];
  const labelOf = new Map<string, { label: string; itemKey: string | null }>();
  if (groupBy === "user" && keys.length > 0) {
    const people = await prisma.user.findMany({
      where: { id: { in: keys } },
      select: { id: true, displayName: true },
    });
    for (const p of people) labelOf.set(p.id, { label: p.displayName, itemKey: null });
  } else if (groupBy === "item") {
    for (const [id, ref] of await loadItemRefs(prisma, keys)) {
      labelOf.set(id, { label: ref.name, itemKey: ref.key });
    }
  }

  const rows: ApiTimeReportRow[] = keys.map((key) => {
    const g = groups.get(key)!;
    // A day is its own label; a person or item that has left the directory keeps
    // its id, which is traceable, rather than a guessed name.
    const named = labelOf.get(key);
    return {
      key,
      label: named?.label ?? key,
      itemKey: named?.itemKey ?? null,
      minutes: g.minutes,
      entries: g.entries,
    };
  });
  rows.sort((a, b) =>
    groupBy === "day"
      ? a.key.localeCompare(b.key)
      : b.minutes - a.minutes ||
        (a.itemKey ?? a.label).localeCompare(b.itemKey ?? b.label, "en", { numeric: true }) ||
        a.key.localeCompare(b.key),
  );

  return {
    groupBy,
    from: range.fromYmd,
    to: range.toYmd,
    tz,
    projectId: opts.projectId ?? null,
    rows,
    total,
  };
}
