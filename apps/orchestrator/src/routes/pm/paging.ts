/**
 * WARP-3371 — the paging query every PM list endpoint accepts, validated once.
 *
 *   limit     rows per page, 1..PM_PAGE_MAX (the service applies the default)
 *   per_page  the pre-cursor name for `limit`; kept so a caller that never heard
 *             of the cursor (the assistant's tools, the department widgets, an
 *             older dashboard bundle) keeps working. `limit` wins when both come.
 *   cursor    opaque — the previous page's `nextCursor`
 *   page      legacy 1-based offset page; it names a position the cursor already
 *             names, so the two together are a 400 rather than a guess
 *
 * 🔴 Every number is parsed here, at the boundary. `Number("abc")` is NaN, and a
 * NaN `take` reaches Prisma's driver and comes back as a 500 on a request the
 * API had every chance to refuse in words (the defect `?per_page=abc` was on
 * `GET /pm/projects` and `GET /pm/work-items`). `z.coerce.number().int()` is
 * what turns non-numeric, fractional and out-of-range input into a 400.
 */

import { z } from "zod";
import { PM_PAGE_MAX } from "../../services/pm/pm-paging.js";

// A cursor is ~100 characters today; the bound only stops a hostile one.
const CURSOR_MAX = 512;
// 100 000 pages of the largest size is 50 million rows — more than the box can
// hold — and keeps `(page - 1) * limit` far inside what Postgres OFFSET takes.
const PAGE_NUMBER_MAX = 100_000;

export const pagingQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(PM_PAGE_MAX).optional(),
    per_page: z.coerce.number().int().min(1).max(PM_PAGE_MAX).optional(),
    cursor: z.string().min(1).max(CURSOR_MAX).optional(),
    page: z.coerce.number().int().min(1).max(PAGE_NUMBER_MAX).optional(),
  })
  .refine((q) => q.cursor === undefined || q.page === undefined, {
    path: ["cursor"],
    message: "cursor and page cannot be combined",
  });

/** The paging a list reads, with `per_page` folded into `limit`. */
export interface PagingInput {
  limit: number | undefined;
  cursor: string | undefined;
  page: number | undefined;
}

export type PagingParse =
  | { success: true; data: PagingInput }
  | { success: false; error: z.ZodError };

/** Validate the paging part of a query string (`req.query`). */
export function parsePaging(query: unknown): PagingParse {
  const parsed = pagingQuerySchema.safeParse(query);
  if (!parsed.success) return { success: false, error: parsed.error };
  const { limit, per_page, cursor, page } = parsed.data;
  return { success: true, data: { limit: limit ?? per_page, cursor, page } };
}
