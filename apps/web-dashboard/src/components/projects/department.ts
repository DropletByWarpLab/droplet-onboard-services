// ADR-045 §5.3 (slice 8) — the department dimension, dashboard side.
//
// Pure helpers for the board's department filter. They live in their own file
// rather than config.ts because they encode two decisions worth reading, not
// two bits of formatting.
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
// Picking a DEPARTMENT matches it AND its TEAMs — a department's board that
// hides the work its own teams own is not a department's board. Picking a TEAM
// matches only that team. There is no second "include teams" toggle: one
// control, one rule. The server's `?department=` filter applies exactly the
// same rule (`pm-department.ts` `expandDepartmentScope`), so this board and the
// LLM's `pm_list_work_items` never disagree about what a department contains.
//
// HOUSEHOLD is never offered. It is the seeded system unit everyone is already
// in, so "route it to Household" is indistinguishable from routing nothing. The
// orchestrator refuses the assignment (`department_not_assignable`); filtering
// it out here means the refusal is never reachable from this surface.
//
// The filtering is client-side, like `savedView` and `q` on this page: the
// board already holds every item for the project in one fetch, so a server
// round-trip would buy nothing and would cost the instant saved-view counts.

import type { Department } from "@/lib/types";
import type { PmDepartmentRef, PmWorkItem } from "./types";

/** No department filter applied. */
export const DEPARTMENT_ANY = "all";
/** Only work no department owns — at the item level AND the project level. */
export const DEPARTMENT_NONE = "none";

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

/**
 * Does this work item belong to the selected department?
 *
 * `item.department` is already RESOLVED by the orchestrator (the item's own
 * overriding its project's), so this never re-implements the override rule —
 * it only adds the DEPARTMENT→TEAM rollup, which needs no lookup because the
 * item's own ref carries `parentId`.
 *
 * `options` is consulted for one thing only: confirming the SELECTED unit is a
 * DEPARTMENT, since a TEAM must not roll up to anything. When the option list
 * has not loaded, the `parentId` comparison alone is still correct — it can
 * only match a genuine parent.
 */
export function matchesDepartment(
  item: PmWorkItem,
  selection: string,
  options: readonly DepartmentOption[],
): boolean {
  if (selection === DEPARTMENT_ANY) return true;
  const dept = item.department;
  if (selection === DEPARTMENT_NONE) return dept === null;
  if (!dept) return false;
  if (dept.id === selection) return true;
  const selected = options.find((o) => o.id === selection);
  if (selected && selected.kind !== "DEPARTMENT") return false;
  return dept.parentId === selection;
}
