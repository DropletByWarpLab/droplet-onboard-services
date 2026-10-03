/**
 * WARP-3522 — the page cursor of `POST /api/pm/work-items/query`.
 *
 * OFFSET-based, deliberately. The query API serves sorts a keyset cannot:
 * `state` and `key` order by a joined row's column, `priority` by an enum's
 * declared order, and a nullable `dueDate` needs NULLS LAST on both ends — each
 * of those makes "the rows after this one" a different predicate. WS-6b's table
 * sorts by every one of them. An offset is one mechanism that works for all, at
 * a cost that is real but sits far from this product's scale (a household box
 * holds hundreds to low thousands of items, a business a few tens of
 * thousands): Postgres walks `skip` rows of an already-ordered index, in
 * milliseconds, at 500 rows a page.
 *
 * What an offset cannot do is hold still while rows are inserted ahead of it, so
 * a page boundary can repeat or skip one row if the board changes between two
 * fetches. Every consumer revalidates on a poll and de-duplicates by id, so that
 * heals itself on the next tick. If a view ever needs strict no-skip paging at
 * depth, the cursor's SHAPE can change under the same opaque string: nothing
 * outside this file reads it.
 *
 * The cursor carries the offset and a fingerprint of the query it belongs to.
 * It is NOT signed: it grants nothing, and a forged offset only moves a caller
 * around their own result set. The fingerprint exists to catch the honest
 * mistake — a client that changed its filter and kept the old cursor — as a 400
 * rather than as a silently wrong page.
 */
import { createHash } from "node:crypto";
import { serializePmFilter, type PmFilter, type PmSortSpec } from "@droplet/shared-types";
import { PM_QUERY_ERRORS } from "./errors.js";

/** Rows a cursor may skip. A guard against absurd values, not a product limit. */
const MAX_OFFSET = 10_000_000;
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

export interface QueryIdentity {
  /** What the query ranges over: `project:<id>` or `workspace:<slug>`. */
  scope: string;
  filter: PmFilter;
  sort: readonly PmSortSpec[];
  tz: string;
}

/** 64 bits of SHA-256 over everything that changes WHICH rows come back and in
 *  what order. The filter is hashed in its canonical form, so `and[and[x]]` and
 *  `x` are one query. */
export function queryFingerprint(q: QueryIdentity): string {
  const canonical = JSON.stringify([q.scope, serializePmFilter(q.filter), q.sort, q.tz]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function encodeCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ o: offset, f: fingerprint })).toString("base64url");
}

/** The offset a cursor stands for, or `invalid_cursor`. */
export function decodeCursor(cursor: string, fingerprint: string): number {
  const bad = (): never => {
    throw new Error(PM_QUERY_ERRORS.INVALID_CURSOR);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return bad();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return bad();
  const { o, f } = parsed as { o?: unknown; f?: unknown };
  if (typeof o !== "number" || !Number.isInteger(o) || o < 0 || o > MAX_OFFSET) return bad();
  if (typeof f !== "string" || !FINGERPRINT_RE.test(f) || f !== fingerprint) return bad();
  return o;
}
