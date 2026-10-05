/**
 * WARP-3533 — the work items an ICS feed carries, and how they become events.
 *
 * Two feeds (ADR-069 §9, the existing CalendarFeedToken mechanism):
 *   - "my work" — items assigned to the person that have a due date;
 *   - a project — that project's items that have a due date.
 *
 * ONE all-day VEVENT per item. `dueDate` is a calendar date stored at
 * 00:00:00Z (WS-1's rule), so the event's day is the UTC day of `dueDate` and
 * nothing else: a viewer's timezone never moves it. The event says what it is
 * (`KEY-123 name`), links to the item, and is `STATUS:COMPLETED` when the item
 * is done (the explicit `isCompleted` column, WARP-884) and `STATUS:CANCELLED`
 * when its state is a cancelled one — never derived from `completedAt`.
 *
 * Identity, once, because it is the easy place to be wrong: PM assignees are
 * `User.id`, while `CalendarEvent.userId` is a USERNAME. The caller of this
 * module hands over the `User.id` of the person the feed token resolved to
 * (never the username from the URL), and the assignee filter below is on that.
 *
 * The window is the calendar feed's: items due from 30 days ago to a year out,
 * at most 500, in due-date order. Archived items and items of an archived
 * project are not on a calendar.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { IcsStatus, SerializeInput } from "../ics.js";

export const PM_FEED_PAST_MS = 30 * 24 * 60 * 60 * 1000;
export const PM_FEED_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;
export const PM_FEED_MAX_EVENTS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which projects a feed may read. Archived ones never. A SERVICE_DESK project
 * holds customer conversations and must never reach a work feed: the filter
 * belongs HERE, in the one place both feeds take their projects from. Keep it
 * on the item query too, so a kind change between project validation and item
 * retrieval cannot expose ticket content.
 */
const FEED_PROJECT_WHERE = { isArchived: false, kind: "PROJECT" } satisfies Prisma.PmProjectWhereInput;

const FEED_SELECT = {
  id: true,
  sequenceId: true,
  name: true,
  dueDate: true,
  updatedAt: true,
  isCompleted: true,
  priority: true,
  state: { select: { name: true, group: true } },
  project: { select: { id: true, identifier: true, name: true } },
} satisfies Prisma.PmWorkItemSelect;

export type PmFeedItem = Prisma.PmWorkItemGetPayload<{ select: typeof FEED_SELECT }>;

function feedWhere(now: Date): Prisma.PmWorkItemWhereInput {
  return {
    isArchived: false,
    dueDate: {
      gte: new Date(now.getTime() - PM_FEED_PAST_MS),
      lte: new Date(now.getTime() + PM_FEED_FUTURE_MS),
    },
    project: FEED_PROJECT_WHERE,
  };
}

/** Items assigned to `userId` (a `User.id`) that have a due date in the window. */
export function listMyWorkFeedItems(prisma: PrismaClient, userId: string, now = new Date()): Promise<PmFeedItem[]> {
  return prisma.pmWorkItem.findMany({
    where: { ...feedWhere(now), assignees: { some: { userId } } },
    select: FEED_SELECT,
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    take: PM_FEED_MAX_EVENTS,
  });
}

/** The project feed's project, or null when it is gone or archived. */
export function findFeedProject(prisma: PrismaClient, projectId: string) {
  return prisma.pmProject.findFirst({
    where: { id: projectId, ...FEED_PROJECT_WHERE },
    select: { id: true, name: true, identifier: true },
  });
}

/** The projects a person may keep a feed link for, in board order (the Developer page lists them). */
export function listFeedProjects(prisma: PrismaClient, limit = 200) {
  return prisma.pmProject.findMany({
    where: FEED_PROJECT_WHERE,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, identifier: true },
    take: limit,
  });
}

/** Items of `projectId` that have a due date in the window. */
export function listProjectFeedItems(prisma: PrismaClient, projectId: string, now = new Date()): Promise<PmFeedItem[]> {
  return prisma.pmWorkItem.findMany({
    where: { ...feedWhere(now), projectId },
    select: FEED_SELECT,
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    take: PM_FEED_MAX_EVENTS,
  });
}

/** The status an item's event carries; `undefined` for open work. */
export function feedStatus(item: Pick<PmFeedItem, "isCompleted" | "state">): IcsStatus | undefined {
  if (item.isCompleted) return "COMPLETED";
  if (item.state?.group === "cancelled") return "CANCELLED";
  return undefined;
}

/** The dashboard deep link for an item (WS-6 reads `p` and `item`). `origin` is a host-validated origin. */
export function itemLink(origin: string, identifier: string, key: string): string {
  return `${origin}/projects?p=${encodeURIComponent(identifier)}&item=${encodeURIComponent(key)}`;
}

/** UTC midnight of the calendar day `date` falls on. */
function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** One all-day event per item. `origin` is the host-validated origin links are built on. */
export function toIcsEvents(items: readonly PmFeedItem[], origin: string): SerializeInput[] {
  const events: SerializeInput[] = [];
  for (const item of items) {
    // The query has `dueDate` in a range, so it is never null here; the guard
    // is the type's, not a case that can happen.
    if (!item.dueDate) continue;
    const key = `${item.project.identifier}-${item.sequenceId}`;
    const day = utcDay(item.dueDate);
    events.push({
      uid: `pm-${item.id}@droplet`,
      summary: `${key} ${item.name}`,
      description: [
        `Project: ${item.project.name}`,
        `State: ${item.state?.name ?? "No state"}`,
        `Priority: ${item.priority}`,
      ].join("\n"),
      // serializeIcs's `meetingUrl` is the RFC 5545 URL property.
      meetingUrl: itemLink(origin, item.project.identifier, key),
      status: feedStatus(item),
      startsAt: day,
      endsAt: new Date(day.getTime() + DAY_MS),
      allDay: true,
      updatedAt: item.updatedAt,
    });
  }
  return events;
}
