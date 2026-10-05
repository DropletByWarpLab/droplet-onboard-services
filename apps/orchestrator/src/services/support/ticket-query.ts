/**
 * Service desk (ADR-069) — the pure half of reading tickets: which rows a queue
 * means, how a list is paged, and how a ticket key is parsed. No I/O, so the
 * predicates are asserted as objects in the DB-less lane and proven against a
 * real Postgres in support-desk.pg.test.ts.
 *
 * Every predicate reads EXPLICIT columns — `PmState.group`, `PmState.slaClock`,
 * the assignee set, `PmTicket.solvedAt` — never a state's NAME. ADR-069 §5: a
 * desk can rename "Pending" without breaking a queue or an SLA.
 */
import type { Prisma } from "@prisma/client";
import {
  SOLVED_RECENT_DAYS,
  type SupportQueue,
  type TicketListQuery,
} from "./support.types.js";

/** States a ticket can still be worked from. */
export const OPEN_GROUPS = ["backlog", "unstarted", "started"] as const;
/** States that end the work (PM's `isCompleted` is exactly these two groups). */
export const TERMINAL_GROUPS = ["completed", "cancelled"] as const;

export function isTerminalGroup(group: string | null | undefined): boolean {
  return group === "completed" || group === "cancelled";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The rows a named queue contains, within whatever base filter it is ANDed to. */
export function queueWhere(
  queue: SupportQueue,
  viewerId: string,
  now: Date,
): Prisma.PmWorkItemWhereInput {
  switch (queue) {
    case "all":
      return {};
    case "open":
      return { state: { group: { in: [...OPEN_GROUPS] }, slaClock: "RUNNING" } };
    case "pending":
      return { state: { group: { in: [...OPEN_GROUPS] }, slaClock: "PAUSED" } };
    case "unassigned":
      return { state: { group: { in: [...OPEN_GROUPS] } }, assignees: { none: {} } };
    case "mine":
      return {
        state: { group: { in: [...OPEN_GROUPS] } },
        assignees: { some: { userId: viewerId } },
      };
    case "solved_recent":
      return {
        state: { group: { in: [...TERMINAL_GROUPS] } },
        ticket: { is: { solvedAt: { gte: new Date(now.getTime() - SOLVED_RECENT_DAYS * DAY_MS) } } },
      };
  }
}

/** A work item that is a live ticket: in a non-archived desk (or the one asked
 *  for), not archived itself, and carrying its PmTicket row. A project work item
 *  can satisfy none of this, which is what keeps /api/support off project rows. */
export function ticketBaseWhere(deskId?: string): Prisma.PmWorkItemWhereInput {
  return {
    isArchived: false,
    ticket: { isNot: null },
    project: {
      kind: "SERVICE_DESK",
      isArchived: false,
      ...(deskId ? { id: deskId } : {}),
    },
  };
}

const KEY_RE = /^([A-Za-z0-9]{1,10})-(\d+)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(ref: string): boolean {
  return UUID_RE.test(ref);
}

/** `SUP-12` -> { identifier: "SUP", sequenceId: 12 }; anything else -> null. */
export function parseTicketKey(ref: string): { identifier: string; sequenceId: number } | null {
  const m = KEY_RE.exec(ref.trim());
  if (!m) return null;
  const sequenceId = Number(m[2]);
  if (!Number.isSafeInteger(sequenceId) || sequenceId < 1) return null;
  return { identifier: m[1]!.toUpperCase(), sequenceId };
}

/** Free text over the subject, the request, the requester's snapshot name and
 *  address, and — when the text is itself a key — that exact ticket. */
export function searchWhere(q: string): Prisma.PmWorkItemWhereInput {
  const needle = q.trim();
  const key = parseTicketKey(needle);
  return {
    OR: [
      { name: { contains: needle, mode: "insensitive" } },
      { descriptionHtml: { contains: needle, mode: "insensitive" } },
      { ticket: { is: { requesterName: { contains: needle, mode: "insensitive" } } } },
      { ticket: { is: { requesterEmail: { contains: needle, mode: "insensitive" } } } },
      ...(key
        ? [
            {
              sequenceId: key.sequenceId,
              project: { identifier: { equals: key.identifier, mode: "insensitive" as const } },
            },
          ]
        : []),
    ],
  };
}

// ── Paging ───────────────────────────────────────────────────────────────────

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/** A malformed cursor is refused, not treated as the first page: a client that
 *  sends garbage should be told, not silently shown page one forever. */
export const INVALID_CURSOR = "invalid_cursor";

export function encodeCursor(row: { updatedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ u: row.updatedAt.toISOString(), i: row.id })).toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string): { updatedAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      u?: unknown;
      i?: unknown;
    };
    if (typeof parsed.u !== "string" || typeof parsed.i !== "string" || parsed.i.length === 0) {
      throw new Error(INVALID_CURSOR);
    }
    const updatedAt = new Date(parsed.u);
    if (Number.isNaN(updatedAt.getTime())) throw new Error(INVALID_CURSOR);
    return { updatedAt, id: parsed.i };
  } catch {
    throw new Error(INVALID_CURSOR);
  }
}

/** Rows strictly after the cursor in (updatedAt desc, id desc) order. */
export function afterCursor(cursor: { updatedAt: Date; id: string }): Prisma.PmWorkItemWhereInput {
  return {
    OR: [
      { updatedAt: { lt: cursor.updatedAt } },
      { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
    ],
  };
}

export const LIST_ORDER: Prisma.PmWorkItemOrderByWithRelationInput[] = [
  { updatedAt: "desc" },
  { id: "desc" },
];

/** The full filter for a list request, WITHOUT the cursor (the count uses it
 *  as is; the page ANDs `afterCursor` on top). */
export function listWhere(
  query: TicketListQuery,
  viewerId: string,
  now: Date,
): Prisma.PmWorkItemWhereInput {
  const parts: Prisma.PmWorkItemWhereInput[] = [
    ticketBaseWhere(query.deskId),
    queueWhere(query.queue ?? "open", viewerId, now),
  ];
  if (query.stateId) parts.push({ stateId: query.stateId });
  if (query.priority) parts.push({ priority: query.priority });
  if (query.assigneeId) parts.push({ assignees: { some: { userId: query.assigneeId } } });
  if (query.q && query.q.trim().length > 0) parts.push(searchWhere(query.q));
  return { AND: parts };
}
