/**
 * WARP-3371 — keyset paging for the PM lists.
 *
 * A list used to be `take: perPage` with the ceiling (100, max 200) as the only
 * answer to "how many are there": a project with 250 items served 100 and said
 * nothing, so the board silently stopped. Every PM list now returns a PAGE —
 * the rows, a `nextCursor` (null on the last page) and an exact `total` — and a
 * caller that wants everything follows the cursor until it is null.
 *
 * ── why a keyset cursor and not `skip` ─────────────────────────────────────
 *
 * `skip: n` re-counts the first n rows on every page and, worse, is wrong the
 * moment the set moves: a row deleted between two pages shifts every later row
 * up by one and the next page silently skips one. A keyset cursor names the
 * LAST ROW SEEN by its sort key plus its id, so the next page is "everything
 * after that key" — a deleted row changes nothing, and Prisma's own
 * `cursor: { id }` (which needs the cursor row to still exist) is avoided for
 * the same reason: delete the row the cursor points at and it returns nothing.
 *
 * The cursor is opaque to clients (base64url JSON), and carries the NAME of the
 * ordering it was minted for, so a comment cursor handed to the work-item list
 * is a 400 `invalid_cursor` instead of a nonsense page.
 *
 * Ordering is always `(sort key, id)`: the id is unique and immutable, so two
 * rows can never tie and the order is stable across pages and across calls.
 */

import { z } from "zod";

/** Rows per page when the caller does not say. */
export const PM_PAGE_DEFAULT = 100;
/** The most a caller may ask for in one page. */
export const PM_PAGE_MAX = 500;

/** The one stable code a bad cursor surfaces as — the route answers 400. */
export const INVALID_CURSOR = "invalid_cursor";

/** What the sort key of an ordering is. `date` keys travel as ISO strings. */
export type CursorKeyKind = "number" | "date";

/** One ordering a PM list can page through. */
export interface PmPageOrder {
  /** Baked into the cursor so one list's cursor is refused by another. */
  readonly name: string;
  readonly kind: CursorKeyKind;
}

/** A project's board: `sortOrder`, then `id`, ascending. */
export const ORDER_BOARD: PmPageOrder = { name: "board", kind: "number" };
/** Archived items: archive instant descending, legacy missing instants last. */
export const ORDER_ARCHIVED: PmPageOrder = { name: "archived", kind: "number" };
/** Workspace search: newest change first. */
export const ORDER_SEARCH: PmPageOrder = { name: "search", kind: "date" };
/** The caller's own assignments: newest change first. */
export const ORDER_ASSIGNED: PmPageOrder = { name: "assigned", kind: "date" };
/** A work item's comments: oldest to newest. */
export const ORDER_COMMENTS: PmPageOrder = { name: "comments", kind: "date" };
/** A work item's activity feed: oldest to newest. */
export const ORDER_ACTIVITY: PmPageOrder = { name: "activity", kind: "date" };

/** One page of a PM list. */
export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
  /** Exact size of the whole filtered set — never the size of this page. */
  total: number;
}

/** The decoded position of the last row a caller has seen. */
export interface CursorPosition {
  key: number | Date;
  id: string;
}

// An id is a UUID today; the bound only has to keep a hostile cursor from
// becoming a megabyte query parameter.
const MAX_ID_LENGTH = 128;

const cursorPayload = z.object({
  v: z.literal(1),
  o: z.string(),
  k: z.union([z.number(), z.string()]),
  i: z.string().min(1).max(MAX_ID_LENGTH),
});

/** Opaque cursor for "everything after this row" under `order`. */
export function encodeCursor(order: PmPageOrder, key: number | Date, id: string): string {
  const k = key instanceof Date ? key.toISOString() : key;
  return Buffer.from(JSON.stringify({ v: 1, o: order.name, k, i: id }), "utf8").toString("base64url");
}

/**
 * The position a cursor names. Throws `Error("invalid_cursor")` for anything
 * that is not exactly what `encodeCursor` mints for THIS ordering — wrong
 * ordering, wrong key type, a date that is not an ISO instant, a non-finite
 * number, malformed JSON — so the route can answer 400 rather than let a
 * garbage value reach the query.
 */
export function decodeCursor(order: PmPageOrder, cursor: string): CursorPosition {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error(INVALID_CURSOR);
  }
  const parsed = cursorPayload.safeParse(raw);
  if (!parsed.success || parsed.data.o !== order.name) throw new Error(INVALID_CURSOR);
  const { k, i } = parsed.data;
  if (order.kind === "number") {
    if (typeof k !== "number" || !Number.isFinite(k)) throw new Error(INVALID_CURSOR);
    return { key: k, id: i };
  }
  if (typeof k !== "string") throw new Error(INVALID_CURSOR);
  const at = new Date(k);
  // `toISOString()` round-trips only a canonical ISO instant, which is all
  // `encodeCursor` ever writes — "2026-10-03" or "next tuesday" are refused.
  if (Number.isNaN(at.getTime()) || at.toISOString() !== k) throw new Error(INVALID_CURSOR);
  return { key: at, id: i };
}

/**
 * The `where` fragment for "strictly after `after`" in an ordering of
 * `(field, id)`, ascending or descending. AND it with the list's own filters.
 *
 * `field` is the sort column; the tiebreak is always `id`, in the same
 * direction, so the fragment and the `orderBy` it pairs with can never
 * disagree about which rows come next.
 */
export function keysetAfter(
  field: string,
  direction: "asc" | "desc",
  after: CursorPosition,
): { OR: Array<Record<string, unknown>> } {
  const op = direction === "asc" ? "gt" : "lt";
  return {
    OR: [{ [field]: { [op]: after.key } }, { [field]: after.key, id: { [op]: after.id } }],
  };
}

/** Clamp a caller's page size into `1..PM_PAGE_MAX`, defaulting when absent. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return PM_PAGE_DEFAULT;
  return Math.max(1, Math.min(PM_PAGE_MAX, Math.floor(limit)));
}

/**
 * Turn the `limit + 1` rows a page query fetched into the page: the extra row
 * is only the proof that more exist (and is dropped), and the cursor points at
 * the last row that IS returned.
 */
export function sliceToPage<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (last: T) => string,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: [...rows], nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: cursorOf(items[items.length - 1]) };
}
