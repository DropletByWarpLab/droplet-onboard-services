// ADR-045 §5.3 (slice 8) — the department dimension, dashboard side.
//
// Pure helper for the board's department filter picker. It lives in its own file
// rather than config.ts because it encodes a decision worth reading, not a bit
// of formatting.
//
// ── 1. WHICH OPTIONS THE PICKER OFFERS ──────────────────────────────────────
//
// `GET /api/departments` is SCOPED, and scoped two ways at once: owner/admin
// see every unit including archived ones, and everybody else sees only units
// they hold a `DepartmentMembership` row on, with archived rows hidden. That is
// the right scope for storage administration and the wrong scope for a work
// label — PM is household-shared, so a person can perfectly well be looking at
// a work item owned by a department they are not a member of, or by one that
// has since been archived. Driving the label off that list would render those
// items blank, and driving the picker off it alone would make them
// unfilterable.
//
// So the label travels ON THE WORK ITEM (`item.department`, projected by the
// orchestrator with name and kind and nothing from the storage half), and the
// option list is the UNION of the scoped list and every department already
// visible on the loaded items. Nothing extra is fetched: the second half comes
// free with the board.
//
// The honest cost of that union, stated rather than buried: a department's NAME
// becomes visible to anyone who can see a work item it owns, which is a wider
// audience than `GET /api/departments` gives it. That is deliberate and it is
// the minimum the feature requires — you cannot route a ticket to a department
// and simultaneously hide from the people who can see the ticket whose ticket
// it is. Only the name, kind and parent cross; state, quota, provisioning error
// and every Nextcloud group identifier stay behind the storage API.
//
// ── 2. WHAT SELECTING A DEPARTMENT MATCHES ──────────────────────────────────
//
// Not decided here. A department chip is the filter language's `department`
// condition, and the SERVER evaluates it (WS-6, WARP-3522): picking a DEPARTMENT
// matches it AND its TEAMs, picking a TEAM matches only that team, and an item's
// own department overrides its project's — `expandDepartmentScope` and
// `departmentWorkItemWhere` in the orchestrator's pm-department.ts, the same
// functions `?department=` and the assistant use, so this board and the
// assistant never disagree about what a department contains. This file used to
// repeat that rule client-side (`matchesDepartment`); the page no longer
// filters what it holds, so the copy is gone rather than left to drift.
//
// HOUSEHOLD is never offered. It is the seeded system unit everyone is already
// in, so "route it to Household" is indistinguishable from routing nothing. The
// orchestrator refuses the assignment (`department_not_assignable`); filtering
// it out here means the refusal is never reachable from this surface.

import type { Department } from "@/lib/types";
import type { PmDepartmentRef, PmWorkItem } from "./types";

/** One row of the picker. Deliberately the PM projection's shape, not the
 *  storage API's `Department` — the two sources are merged INTO this. */
export interface DepartmentOption {
  id: string;
  name: string;
  kind: PmDepartmentRef["kind"];
  parentId: string | null;
}

/**
 * The picker's options: the caller's scoped department list, unioned with every
 * department already visible on the loaded items, HOUSEHOLD removed, sorted so
 * a team sits under its parent.
 *
 * `scoped` may be undefined — `useDepartments` fails soft, and a board whose
 * items carry departments is still filterable without it.
 */
export function departmentOptions(
  items: readonly PmWorkItem[],
  scoped: readonly Department[] | undefined,
): DepartmentOption[] {
  const byId = new Map<string, DepartmentOption>();

  for (const d of scoped ?? []) {
    if (d.kind === "HOUSEHOLD") continue;
    byId.set(d.id, {
      id: d.id,
      name: d.name,
      kind: d.kind,
      parentId: d.parentId,
    });
  }
  // The items' own refs close both scope holes at once: a department the caller
  // is not a member of, and an archived one the scoped list hides.
  for (const it of items) {
    const d = it.department;
    if (!d || d.kind === "HOUSEHOLD" || byId.has(d.id)) continue;
    byId.set(d.id, {
      id: d.id,
      name: d.name,
      kind: d.kind,
      parentId: d.parentId,
    });
  }

  const all = [...byId.values()];
  const nameOf = (id: string | null) =>
    (id && byId.get(id)?.name) || "";
  // Group each team under its parent's name, then alphabetical, so "Clinical"
  // is immediately followed by "Hygiene (team)" rather than by "Front desk".
  return all.sort((a, b) => {
    const ga = a.kind === "TEAM" ? nameOf(a.parentId) || a.name : a.name;
    const gb = b.kind === "TEAM" ? nameOf(b.parentId) || b.name : b.name;
    if (ga !== gb) return ga.localeCompare(gb);
    if (a.kind !== b.kind) return a.kind === "TEAM" ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}
