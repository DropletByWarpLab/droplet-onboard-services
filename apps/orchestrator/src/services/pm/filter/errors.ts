/**
 * WARP-3522 — the stable error codes of the filter / query layer. Thrown as
 * `Error(code)` like `PM_ERRORS` (pm.service.ts) so routes keep ONE place that
 * maps a code to an HTTP status (`routes/pm/views.ts`).
 */
export const PM_QUERY_ERRORS = {
  /** The filter (or sort, group-by, columns) failed the shared validator. 400. */
  INVALID_FILTER: "invalid_filter",
  /** `me` in a filter evaluated for a principal that is not a person — the
   *  assistant's service principal. 422: the request is well-formed, the
   *  caller just has no "me". */
  ME_UNAVAILABLE: "me_unavailable",
  /** The compiler was handed a department the resolver never resolved. A bug in
   *  the caller, not a user error — 500, never shown as "no such department". */
  DEPARTMENT_UNRESOLVED: "department_unresolved",
  /** `tz` is not an IANA zone the runtime resolves. 400. */
  INVALID_TIMEZONE: "invalid_timezone",
  /** A cursor that is not ours, or belongs to a different query. 400. */
  INVALID_CURSOR: "invalid_cursor",
} as const;
