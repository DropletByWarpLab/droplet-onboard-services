"use client";

// WARP-3537 — a view's DISPLAY options: how it is grouped, how it is sorted, which
// columns the table shows. They are persisted by the saved view that carries them
// (`PmSavedView.groupBy` / `sortBy` / `columns`, WS-6) — the same view, saved and
// updated by the same calls as its filter; there is no second place they live.
//
// Until saved they are the page's own state, seeded from the active view: a person
// who re-sorts a table sees it re-sorted at once, and is told the view has changed
// ("You've changed “…”" with Update view / Reset, exactly as for a filter). `null`
// for any of the three is "the layout's own default" — which is why the layout is
// an argument: a project's list groups by state, a table groups by nothing.

import { useCallback, useMemo, useState } from "react";
import {
  PM_TABLE_DEFAULT_COLUMNS,
  resolveTableColumns,
  type PmGroupByField,
  type PmSortSpec,
  type PmTableColumnId,
  type PmTableScope,
} from "@droplet/shared-types";
import { defaultGroupBy, effectiveGroupBy, type DisplayLayout } from "./grouping";
import { sortEqual } from "./sorting";

export interface ViewDisplay {
  groupBy: PmGroupByField | null;
  sortBy: PmSortSpec[] | null;
  columns: string[] | null;
}

export const NO_DISPLAY: ViewDisplay = { groupBy: null, sortBy: null, columns: null };

/** What is actually drawn: every `null` resolved against the layout and scope. */
export interface ResolvedDisplay {
  groupBy: PmGroupByField | null;
  /** `null` is the server's own order. */
  sort: PmSortSpec[] | null;
  columns: PmTableColumnId[];
}

export function resolveDisplay(d: ViewDisplay, scope: PmTableScope, layout: DisplayLayout): ResolvedDisplay {
  return {
    groupBy: effectiveGroupBy(d.groupBy, scope, layout),
    sort: d.sortBy && d.sortBy.length > 0 ? d.sortBy : null,
    columns: resolveTableColumns(d.columns, scope),
  };
}

/** Equal by what is DRAWN: `null` and the default spelled out are the same view. */
export function displayEqual(a: ViewDisplay, b: ViewDisplay, scope: PmTableScope, layout: DisplayLayout): boolean {
  const x = resolveDisplay(a, scope, layout);
  const y = resolveDisplay(b, scope, layout);
  return (
    x.groupBy === y.groupBy &&
    sortEqual(x.sort, y.sort) &&
    x.columns.length === y.columns.length &&
    x.columns.every((c, i) => c === y.columns[i])
  );
}

export interface UseTableDisplayArgs {
  /** The active saved view's display options; null when there is no saved view. */
  saved: ViewDisplay | null;
  /** Names WHICH view `saved` is (and which version of it). When it changes, edits made to the
   *  last one are dropped — they were edits to something else. */
  scopeKey: string;
  scope: PmTableScope;
  layout: DisplayLayout;
}

const NO_EDITS: Partial<ViewDisplay> = {};

export function useTableDisplay({ saved, scopeKey, scope, layout }: UseTableDisplayArgs) {
  const [edit, setEdit] = useState<{ key: string; over: Partial<ViewDisplay> }>({ key: scopeKey, over: NO_EDITS });
  // Derived, not synced: edits belong to the view they were made on. A different key
  // is simply "no edits yet", with nothing to clear in an effect.
  const over = edit.key === scopeKey ? edit.over : NO_EDITS;
  const base = saved ?? NO_DISPLAY;
  const raw: ViewDisplay = useMemo(() => ({ ...base, ...over }), [base, over]);

  const change = useCallback(
    (patch: Partial<ViewDisplay>) => setEdit((e) => ({ key: scopeKey, over: { ...(e.key === scopeKey ? e.over : {}), ...patch } })),
    [scopeKey],
  );

  // What is stored is the CANONICAL form: a default is null, never spelled out, so a saved view is
  // not full of values that would silently change meaning if a default ever moved.
  const setSort = useCallback((sort: PmSortSpec[] | null) => change({ sortBy: sort && sort.length > 0 ? sort : null }), [change]);
  const setGroupBy = useCallback(
    (g: PmGroupByField | null) => change({ groupBy: g === defaultGroupBy(scope, layout) ? null : g }),
    [change, scope, layout],
  );
  const setColumns = useCallback(
    (ids: readonly string[] | null) => {
      const resolved = resolveTableColumns(ids, scope);
      const isDefault = resolved.length === PM_TABLE_DEFAULT_COLUMNS[scope].length && resolved.every((c, i) => c === PM_TABLE_DEFAULT_COLUMNS[scope][i]);
      change({ columns: ids === null || isDefault ? null : resolved });
    },
    [change, scope],
  );
  const reset = useCallback(() => setEdit({ key: scopeKey, over: NO_EDITS }), [scopeKey]);

  return {
    resolved: useMemo(() => resolveDisplay(raw, scope, layout), [raw, scope, layout]),
    raw,
    dirty: !displayEqual(raw, base, scope, layout),
    setSort,
    setGroupBy,
    setColumns,
    reset,
  };
}
