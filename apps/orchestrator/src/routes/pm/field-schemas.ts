/**
 * WARP-3520 — the zod pieces the work-item routes share for the fields this
 * slice adds: the item's KIND, its estimate, and calendar-date inputs.
 *
 * Their own file rather than more lines in native.ts: the create and patch
 * schemas both need the same four definitions, and several concurrent changes
 * edit native.ts.
 *
 * `z.enum` here is a ROUTE validator, not a tool schema — WARP-1839's ban on
 * `enum` applies to the JSON Schema an LLM tool advertises, and nothing in this
 * file is serialized into `tools[]` (native.ts's PRIORITY / STATE_GROUP are the
 * same shape for the same reason).
 */

import { z } from "zod";
import { WORK_ITEM_TYPES } from "../../services/pm/pm.service.js";

/** The six `PmWorkItemType` values. The list is the service's, so the route,
 *  the service and the Prisma enum cannot drift apart (pm.service.ts asserts the
 *  list covers the generated enum at compile time). */
export const WORK_ITEM_TYPE = z.enum(WORK_ITEM_TYPES);

/** Story points: finite, 0..1000 — the same bounds as the database CHECK
 *  `PmWorkItem_estimate_range`, so a rejection here is a 400 with a field
 *  message instead of a raw constraint error from Postgres. */
export const ESTIMATE = z.number().finite().min(0).max(1000);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A string that matches the shape AND names a day that exists: a round trip
 *  through Date rejects `2026-02-30`, which `new Date` would otherwise roll into
 *  March. */
function isRealCalendarDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const DATETIME = z.string().datetime();

/**
 * A work item's `start_date` / `due_date` input: a calendar date
 * (`YYYY-MM-DD`, what an `<input type="date">` produces) OR an ISO-8601
 * datetime (what every client sent before the editors existed). A superset on
 * purpose — the old clients keep working and the editors never have to pass a
 * date through local time.
 */
export const dateInput = z
  .string()
  .max(40)
  .refine((s) => (DATE_ONLY.test(s) ? isRealCalendarDate(s) : DATETIME.safeParse(s).success), {
    message: "Expected a calendar date (YYYY-MM-DD) or an ISO-8601 datetime",
  });

/**
 * `dateInput` -> the Date stored. A calendar date lands at 00:00:00Z — never
 * `new Date(local)` — so the day entered is the day stored whatever timezone
 * the server or the browser is in.
 */
export function parseDateInput(s: string): Date {
  return DATE_ONLY.test(s) ? new Date(`${s}T00:00:00.000Z`) : new Date(s);
}
