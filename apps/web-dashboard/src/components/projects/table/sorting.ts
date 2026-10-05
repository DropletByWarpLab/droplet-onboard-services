// WARP-3537 — clicking a column header, as a function of the sort it started from.
//
// A sort is the query API's `PmSortSpec[]` (at most three keys), and `null` means
// "the server's own order" — a project's manual `sortOrder`, a workspace's newest
// change first. A plain click walks one column through ascending → descending →
// the default; shift-click adds a column as a tie-break. Pure, so every step is a
// test and the header only draws what this says.

import { PM_SORT_MAX_KEYS, type PmSortField, type PmSortSpec } from "@droplet/shared-types";

const norm = (sort: PmSortSpec[] | null): PmSortSpec[] => sort ?? [];

export function nextSort(sort: PmSortSpec[] | null, field: PmSortField, additive: boolean): PmSortSpec[] | null {
  const keys = norm(sort);
  const at = keys.findIndex((s) => s.field === field);

  if (!additive) {
    // Only the PRIMARY key walks asc → desc → default; a column that is just a
    // tie-break starts over as "sort by this".
    if (at === 0 && keys[0].dir === "asc") return [{ field, dir: "desc" }];
    if (at === 0) return null;
    return [{ field, dir: "asc" }];
  }

  if (at >= 0) {
    if (keys[at].dir === "asc") return keys.map((s, i) => (i === at ? { field, dir: "desc" as const } : s));
    const rest = keys.filter((_, i) => i !== at);
    return rest.length === 0 ? null : rest;
  }
  const added: PmSortSpec = { field, dir: "asc" };
  return keys.length >= PM_SORT_MAX_KEYS ? [...keys.slice(0, PM_SORT_MAX_KEYS - 1), added] : [...keys, added];
}

export type AriaSort = "ascending" | "descending" | "none";

/** `aria-sort` for a header: the direction of the PRIMARY key, "none" for everything else. */
export function ariaSortOf(sort: PmSortSpec[] | null, field: PmSortField): AriaSort {
  const primary = norm(sort)[0];
  if (!primary || primary.field !== field) return "none";
  return primary.dir === "asc" ? "ascending" : "descending";
}

/** 1-based position of a column in a MULTI-key sort, for the little number beside its arrow; null otherwise. */
export function sortIndexOf(sort: PmSortSpec[] | null, field: PmSortField): number | null {
  const keys = norm(sort);
  if (keys.length < 2) return null;
  const at = keys.findIndex((s) => s.field === field);
  return at < 0 ? null : at + 1;
}

/** Equal by value; `null` and `[]` are both "the default order". */
export function sortEqual(a: PmSortSpec[] | null, b: PmSortSpec[] | null): boolean {
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((s, i) => s.field === y[i].field && s.dir === y[i].dir);
}
