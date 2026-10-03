/**
 * WARP-3522 — the zod face of the filter grammar, for the routes (and, later,
 * tool schemas) that validate with zod. The rules are NOT restated here: a
 * hand-written validator in `pm-filter.ts` / `pm-views.ts` owns them so its
 * limits hold before any recursion. These adapters hand its verdict to zod —
 * the clean copy on success, one issue carrying the offending path on failure.
 *
 * `z.unknown().transform` rather than `z.custom`: the output is the validator's
 * CLEAN COPY (trimmed text, de-duplicated lists), not the caller's object.
 */
import { z } from "zod";
import { validatePmFilter, type PmFilter } from "./pm-filter";
import {
  validatePmColumns,
  validatePmGroupBy,
  validatePmSort,
  type PmGroupByField,
  type PmSortSpec,
} from "./pm-views";

export const PmFilterSchema = z.unknown().transform((value, ctx): PmFilter => {
  const res = validatePmFilter(value);
  if (!res.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: res.error, path: res.path });
    return z.NEVER;
  }
  return res.filter;
});

export const PmSortSchema = z.unknown().transform((value, ctx): PmSortSpec[] => {
  const res = validatePmSort(value);
  if (!res.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: res.error });
    return z.NEVER;
  }
  return res.sort;
});

export const PmGroupBySchema = z.unknown().transform((value, ctx): PmGroupByField => {
  const res = validatePmGroupBy(value);
  if (!res.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: res.error });
    return z.NEVER;
  }
  return res.groupBy;
});

export const PmColumnsSchema = z.unknown().transform((value, ctx): string[] => {
  const res = validatePmColumns(value);
  if (!res.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: res.error });
    return z.NEVER;
  }
  return res.columns;
});
