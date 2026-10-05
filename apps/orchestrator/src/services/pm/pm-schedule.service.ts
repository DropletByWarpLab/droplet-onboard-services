/**
 * WARP-3523 (ADR-069 WS-7) — the two reads behind the Timeline (Gantt) and
 * My Work views of /projects.
 *
 *   getProjectTimeline  one project, one date window: the work items whose
 *                       schedule overlaps it, the BLOCKS edges between them and
 *                       the module target dates inside it — in a fixed number of
 *                       queries, never one per item.
 *   getMyWork           the signed-in user's cross-project lists (assigned,
 *                       created, overdue, due this week), grouped by project.
 *
 * Both return the SAME `ApiWorkItem` the board gets (`mapWorkItem`), so
 * department inheritance, state, labels and counts cannot drift between views.
 *
 * DATES. `dueDate` / `startDate` are CALENDAR DATES stored as `DateTime` at
 * 00:00:00Z. Every date-only value here becomes a `Date` only as
 * `new Date("YYYY-MM-DDT00:00:00.000Z")`, and windows compare by UTC calendar
 * day (`>= from` and `< to + 1 day`), so a stray time-of-day on a legacy row
 * still lands on the right day and no server time zone is ever consulted.
 * "Today" is the VIEWER's day, sent by the dashboard; the server never decides it
 * for a viewer who supplied one.
 *
 * Errors are plain `Error(code)` like pm.service.ts; the route maps them.
 */

import type { Prisma, PmModuleStatus, PrismaClient } from "@prisma/client";
import { DEPARTMENT_SELECT } from "./pm-department.js";
import { PM_ERRORS, WORK_ITEM_INCLUDE, isServiceDesk, mapWorkItem, type ApiWorkItem } from "./pm.service.js";

// ── Limits ────────────────────────────────────────────────────────────────────
/** A year-quarter view of three years is the widest window the Timeline asks for. */
export const TIMELINE_MAX_RANGE_DAYS = 1100;
export const TIMELINE_ITEM_LIMIT = 2000;
export const TIMELINE_RELATION_LIMIT = 5000;
export const MY_WORK_DEFAULT_LIMIT = 200;
export const MY_WORK_MAX_LIMIT = 500;
/** No list is a million rows deep; past this an `offset` is a typo or an attack, and a 400 beats a driver error. */
export const MY_WORK_MAX_OFFSET = 1_000_000;
/**
 * The years a date parameter may name. `YYYY` alone admits 0000-9999, and a
 * date past 9999 (`addDaysUtc` of `9999-12-31` is `+010000-01-01`) cannot be
 * stored or converted at all — that was a 500 from a query string. 1900-2200 is
 * the span a work tracker can mean.
 */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2200;

export const MY_WORK_SECTIONS = ["assigned", "created", "overdue", "due_this_week"] as const;
export type MyWorkSection = (typeof MY_WORK_SECTIONS)[number];

// ── Date-only helpers (UTC, no local time anywhere) ───────────────────────────

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date (`2026-02-30` is not one) in a year a tracker can mean. */
export function isRealDateOnly(value: string): boolean {
  const m = DATE_ONLY_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const last = new Date(0);
  last.setUTCFullYear(year, month, 0); // day 0 of the NEXT month = last day of this one
  return day <= last.getUTCDate();
}

/** UTC midnight of a calendar date — the value `dueDate` / `startDate` are stored at. */
export function utcMidnight(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}

export function addDaysUtc(dateOnly: string, days: number): string {
  const d = utcMidnight(dateOnly);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDaysUtc(from: string, to: string): number {
  return Math.round((utcMidnight(to).getTime() - utcMidnight(from).getTime()) / 86_400_000);
}

/** The server's current UTC date — the fallback when a caller sends no `today`. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ── Timeline ──────────────────────────────────────────────────────────────────

export interface ApiTimelineRelation {
  id: string;
  kind: "BLOCKS";
  /** `fromId` blocks `toId`. */
  fromId: string;
  toId: string;
}

export interface ApiTimelineMilestone {
  id: string;
  name: string;
  status: PmModuleStatus;
  /** `YYYY-MM-DD` */
  targetDate: string;
}

export interface ApiTimeline {
  from: string;
  to: string;
  items: ApiWorkItem[];
  relations: ApiTimelineRelation[];
  milestones: ApiTimelineMilestone[];
  /** Open or not, non-archived items with no date at all — not drawable, but not hidden from the count. */
  unscheduledCount: number;
  /** A cap was hit: the response is a prefix of the truth. */
  truncated: boolean;
}

export async function getProjectTimeline(
  prisma: PrismaClient,
  projectId: string,
  range: { from: string; to: string },
  limits: { itemLimit?: number; relationLimit?: number } = {},
): Promise<ApiTimeline> {
  const itemLimit = limits.itemLimit ?? TIMELINE_ITEM_LIMIT;
  const relationLimit = limits.relationLimit ?? TIMELINE_RELATION_LIMIT;

  // Same project read as `listWorkItems`: mapWorkItem needs the project's
  // department to resolve each item's inherited one.
  const project = await prisma.pmProject.findUnique({
    where: { id: projectId },
    include: { department: { select: DEPARTMENT_SELECT } },
  });
  if (!project || isServiceDesk(project)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);

  const fromAt = utcMidnight(range.from);
  // Exclusive upper bound = midnight AFTER the `to` day, so a row carrying a
  // late time-of-day on `to` is still inside the window.
  const endBefore = utcMidnight(addDaysUtc(range.to, 1));
  const inWindow = { gte: fromAt, lt: endBefore };

  const itemWhere: Prisma.PmWorkItemWhereInput = {
    projectId,
    isArchived: false,
    OR: [
      // Both dates: the span between them overlaps the window. Written once per
      // orientation so inverted data (start after due, which the API does not
      // forbid) is treated as the span between the two dates rather than lost.
      { startDate: { lt: endBefore }, dueDate: { gte: fromAt } },
      { dueDate: { lt: endBefore }, startDate: { gte: fromAt } },
      // Exactly one date, inside the window.
      { startDate: null, dueDate: inWindow },
      { dueDate: null, startDate: inWindow },
    ],
  };

  const [rows, modules, unscheduledCount] = await Promise.all([
    prisma.pmWorkItem.findMany({
      where: itemWhere,
      include: WORK_ITEM_INCLUDE,
      orderBy: [{ sortOrder: "asc" }, { sequenceId: "asc" }],
      take: itemLimit + 1,
    }),
    prisma.pmModule.findMany({
      where: { projectId, targetDate: inWindow },
      select: { id: true, name: true, status: true, targetDate: true },
      orderBy: [{ targetDate: "asc" }, { name: "asc" }],
    }),
    prisma.pmWorkItem.count({
      where: { projectId, isArchived: false, startDate: null, dueDate: null },
    }),
  ]);

  const itemsTruncated = rows.length > itemLimit;
  const kept = itemsTruncated ? rows.slice(0, itemLimit) : rows;

  // One query for every edge between the returned items. An edge to an item that
  // is out of the window (or in another project) cannot be drawn, so it is not sent.
  let relations: ApiTimelineRelation[] = [];
  let relationsTruncated = false;
  if (kept.length > 0) {
    const ids = kept.map((r) => r.id);
    const edges = await prisma.pmWorkItemRelation.findMany({
      where: { kind: "BLOCKS", fromId: { in: ids }, toId: { in: ids } },
      select: { id: true, fromId: true, toId: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: relationLimit + 1,
    });
    relationsTruncated = edges.length > relationLimit;
    relations = (relationsTruncated ? edges.slice(0, relationLimit) : edges).map((e) => ({
      id: e.id,
      kind: "BLOCKS",
      fromId: e.fromId,
      toId: e.toId,
    }));
  }

  return {
    from: range.from,
    to: range.to,
    items: kept.map((r) => mapWorkItem(r, project.identifier, project.department)),
    relations,
    milestones: modules.map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      // `targetDate` is non-null here: the window filter above excludes NULL.
      targetDate: (m.targetDate as Date).toISOString().slice(0, 10),
    })),
    unscheduledCount,
    truncated: itemsTruncated || relationsTruncated,
  };
}

// ── My Work ───────────────────────────────────────────────────────────────────

export interface ApiMyWorkProject {
  id: string;
  name: string;
  identifier: string;
  icon: string | null;
  color: string | null;
}

export interface ApiMyWorkCounts {
  assigned: number;
  created: number;
  overdue: number;
  dueThisWeek: number;
}

export interface ApiMyWork {
  section: MyWorkSection;
  today: string;
  items: ApiWorkItem[];
  /** The projects `items` belong to, in first-appearance order. */
  projects: ApiMyWorkProject[];
  total: number;
  counts: ApiMyWorkCounts;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

/** Same notion of "open" as `getSummary`: no state yet, or a state that is not finished. */
const OPEN_ITEM: Prisma.PmWorkItemWhereInput = {
  OR: [{ stateId: null }, { state: { group: { in: ["backlog", "unstarted", "started"] } } }],
};

const MY_WORK_PROJECT_SELECT = {
  id: true,
  name: true,
  identifier: true,
  icon: true,
  color: true,
  department: { select: DEPARTMENT_SELECT },
} satisfies Prisma.PmProjectSelect;

/**
 * The where clause for one section. ONE function feeds both the list and its
 * count, so a section's number can never disagree with the rows it shows.
 */
function myWorkWhere(
  section: MyWorkSection,
  userId: string,
  today: string,
): Prisma.PmWorkItemWhereInput {
  const base: Prisma.PmWorkItemWhereInput = {
    isArchived: false,
    project: { isArchived: false, kind: "PROJECT" },
  };
  const mine: Prisma.PmWorkItemWhereInput = { assignees: { some: { userId } } };
  const todayStart = utcMidnight(today);
  switch (section) {
    case "assigned":
      return { AND: [base, OPEN_ITEM, mine] };
    case "created":
      return { AND: [base, OPEN_ITEM, { createdById: userId }] };
    case "overdue":
      // Strictly before today's calendar day: an item due today is not overdue yet.
      return { AND: [base, OPEN_ITEM, mine, { dueDate: { lt: todayStart } }] };
    case "due_this_week":
      // Today through today + 6, inclusive — a rolling 7-day window.
      return {
        AND: [base, OPEN_ITEM, mine, { dueDate: { gte: todayStart, lt: utcMidnight(addDaysUtc(today, 7)) } }],
      };
  }
}

function myWorkOrder(section: MyWorkSection): Prisma.PmWorkItemOrderByWithRelationInput[] {
  // Items of one project are contiguous ("grouped by project"), projects in
  // their own board order. `id` last so paging is stable under ties.
  const byProject: Prisma.PmWorkItemOrderByWithRelationInput[] = [
    { project: { sortOrder: "asc" } },
    { project: { createdAt: "asc" } },
    { projectId: "asc" },
  ];
  // Postgres sorts an enum by declaration order: urgent < high < medium < low < none.
  const within: Prisma.PmWorkItemOrderByWithRelationInput[] =
    section === "overdue" || section === "due_this_week"
      ? [{ dueDate: "asc" }, { priority: "asc" }, { sequenceId: "asc" }]
      : [{ priority: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }, { sequenceId: "asc" }];
  return [...byProject, ...within, { id: "asc" }];
}

export async function getMyWork(
  prisma: PrismaClient,
  userId: string,
  opts: { section: MyWorkSection; today: string; limit?: number; offset?: number },
): Promise<ApiMyWork> {
  const limit = Math.max(1, Math.min(MY_WORK_MAX_LIMIT, opts.limit ?? MY_WORK_DEFAULT_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);
  const { section, today } = opts;

  const [rows, assigned, created, overdue, dueThisWeek] = await Promise.all([
    prisma.pmWorkItem.findMany({
      where: myWorkWhere(section, userId, today),
      // Spans projects, so the project is joined once per row (the same rule
      // `listAssignedWorkItems` follows) — never fetched per item.
      include: { ...WORK_ITEM_INCLUDE, project: { select: MY_WORK_PROJECT_SELECT } },
      orderBy: myWorkOrder(section),
      skip: offset,
      take: limit,
    }),
    prisma.pmWorkItem.count({ where: myWorkWhere("assigned", userId, today) }),
    prisma.pmWorkItem.count({ where: myWorkWhere("created", userId, today) }),
    prisma.pmWorkItem.count({ where: myWorkWhere("overdue", userId, today) }),
    prisma.pmWorkItem.count({ where: myWorkWhere("due_this_week", userId, today) }),
  ]);

  const counts: ApiMyWorkCounts = { assigned, created, overdue, dueThisWeek };
  const total = { assigned, created, overdue, due_this_week: dueThisWeek }[section];

  const projects = new Map<string, ApiMyWorkProject>();
  for (const r of rows) {
    if (projects.has(r.project.id)) continue;
    projects.set(r.project.id, {
      id: r.project.id,
      name: r.project.name,
      identifier: r.project.identifier,
      icon: r.project.icon,
      color: r.project.color,
    });
  }

  const end = offset + rows.length;
  return {
    section,
    today,
    items: rows.map((r) => mapWorkItem(r, r.project.identifier, r.project.department)),
    projects: [...projects.values()],
    total,
    counts,
    limit,
    offset,
    // An empty page never advertises another one: a row deleted between the
    // count and the read must not send a client round and round the same offset.
    nextOffset: rows.length > 0 && end < total ? end : null,
  };
}
