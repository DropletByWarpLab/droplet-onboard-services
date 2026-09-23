/**
 * WARP-2976 (ADR-059 §2.3) — what the nav shows inside a department.
 *
 * PURE functions over `NAV_GROUPS`. The one rule they exist to hold:
 *
 *   department nav = profile.navHrefs ∩ (the existing gates)
 *
 * An INTERSECTION, never a union, and the gates are not re-implemented here.
 * `departmentNavGroups` only NARROWS and REORDERS: every item it returns is the
 * original `NavItem` object from `NAV_GROUPS` (same `roles`, `requiresModule`,
 * `requiresCapability`, `hidden`, `children`), and the caller still runs
 * `visibleItems` / `passesGates` over the result exactly as it does for the
 * whole-business nav. So a `/cameras` href in a Security profile is still gone
 * for a person whose cameras module is off, and a profile can never surface a
 * route the person could not already reach. The switcher SHOWS; it never
 * GRANTS (§2.5).
 *
 * With no department, or a department with no profile, the groups come back
 * untouched — "Whole business" is today's nav, byte for byte.
 */
import type { LucideIcon } from "lucide-react";

import {
  passesGates,
  type AuthRole,
  type NavCapabilities,
  type NavGroup,
  type NavItem,
} from "@/components/nav-config";
import type { Department, DepartmentProfile } from "@/lib/types";

import { departmentIcon } from "./templates";

/**
 * Destinations a person can always reach from inside a department, whatever
 * its profile says — so a profile can never strand someone away from the
 * assistant, their own settings or the manual. `/chat` is the one core module
 * (never module-gated), and "ask Droplet" is how a department reaches
 * everything its nav does not list.
 */
export const DEPARTMENT_ALWAYS_HREFS: readonly string[] = ["/chat", "/settings", "/help"];

/** Caption over the always-reachable group. */
export const DEPARTMENT_GENERAL_GROUP_LABEL = "General";

/** A department's home. `/d/<slug>/…` is not a route tree (§2.3). */
export function departmentHomeHref(slug: string): string {
  return `/d/${encodeURIComponent(slug)}`;
}

/** `/d/<slug>` → slug; anything else → null. `/d` itself is the overview. */
export function slugFromPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const m = /^\/d\/([^/?#]+)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** The synthetic home entry that leads a department's nav. */
export function departmentHomeItem(
  dept: Pick<Department, "name" | "slug">,
  icon: LucideIcon,
): NavItem {
  return {
    href: departmentHomeHref(dept.slug),
    label: `${dept.name} home`,
    icon,
    exact: true,
  };
}

/**
 * Find the NAV_GROUPS item that owns an href: the top-level item whose own
 * href matches, or whose child's does. Returns the ORIGINAL object.
 */
function ownerOf(groups: readonly NavGroup[], href: string): NavItem | null {
  for (const g of groups) {
    for (const item of g.items) {
      if (item.href === href) return item;
    }
  }
  for (const g of groups) {
    for (const item of g.items) {
      if (item.children?.some((c) => c.href === href)) return item;
    }
  }
  return null;
}

type ProfileNav = Pick<DepartmentProfile, "navHrefs" | "icon">;

/**
 * The sidebar's groups for one department.
 *
 * - `dept` null, or `profile` null/undefined → `groups` unchanged.
 * - Otherwise: one group captioned with the department's name — its home
 *   first, then each `NAV_GROUPS` item whose href (or a child's href) is in
 *   `navHrefs`, in `navHrefs` order, each at most once — followed by a small
 *   group with Ask AI, Settings and Help unless the department already lists
 *   them.
 *
 * An href that no `NAV_GROUPS` item owns is ignored: a route removed from the
 * dashboard after the profile was saved never renders as a dead link.
 */
export function departmentNavGroups(
  groups: readonly NavGroup[],
  dept: Pick<Department, "name" | "slug"> | null,
  profile: ProfileNav | null | undefined,
): NavGroup[] {
  if (!dept || !profile) return groups as NavGroup[];

  const items: NavItem[] = [departmentHomeItem(dept, departmentIcon(profile.icon))];
  const seen = new Set<NavItem>();
  for (const href of profile.navHrefs) {
    const owner = ownerOf(groups, href);
    if (!owner || seen.has(owner)) continue;
    seen.add(owner);
    items.push(owner);
  }

  const general: NavItem[] = [];
  for (const href of DEPARTMENT_ALWAYS_HREFS) {
    const owner = ownerOf(groups, href);
    if (!owner || seen.has(owner)) continue;
    seen.add(owner);
    general.push(owner);
  }

  const out: NavGroup[] = [{ label: dept.name, items }];
  if (general.length > 0) {
    out.push({ label: DEPARTMENT_GENERAL_GROUP_LABEL, items: general });
  }
  return out;
}

/**
 * The same restriction for the Workspace-tabs layout: the set of hrefs its
 * `resolveSpaces(..., restrictTo)` may keep. `null` means "no restriction"
 * (Whole business, or a department that is not set up).
 */
export function departmentRestrictSet(
  profile: Pick<DepartmentProfile, "navHrefs"> | null | undefined,
): ReadonlySet<string> | null {
  if (!profile) return null;
  return new Set([...profile.navHrefs, ...DEPARTMENT_ALWAYS_HREFS]);
}

/** Every href `NAV_GROUPS` defines — top-level items and their children. */
export function allNavHrefs(groups: readonly NavGroup[]): string[] {
  const out: string[] = [];
  for (const g of groups) {
    for (const item of g.items) {
      if (!out.includes(item.href)) out.push(item.href);
      for (const child of item.children ?? []) {
        if (!out.includes(child.href)) out.push(child.href);
      }
    }
  }
  return out;
}

/** One row of the Customize checklist. */
export interface NavChoice {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Set for a child entry (Events under Cameras), for an indented row. */
  parentLabel?: string;
}

/**
 * The destinations THIS viewer may pick for a department: every NAV_GROUPS
 * entry (and child) that passes the viewer's own gates, minus tucked entries
 * (no sidebar surface would render them) and the always-reachable ones. A
 * person can only arrange what they can already reach.
 */
export function navChoices(
  groups: readonly NavGroup[],
  role: AuthRole | undefined,
  capabilities: NavCapabilities,
  isModuleOn: (moduleId: string) => boolean,
): NavChoice[] {
  const out: NavChoice[] = [];
  const seen = new Set<string>();
  const ok = (item: NavItem) =>
    !item.hidden && passesGates(item, role, capabilities, isModuleOn);
  for (const g of groups) {
    for (const item of g.items) {
      if (!ok(item)) continue;
      if (!seen.has(item.href) && !DEPARTMENT_ALWAYS_HREFS.includes(item.href)) {
        seen.add(item.href);
        out.push({ href: item.href, label: item.label, icon: item.icon });
      }
      for (const child of item.children ?? []) {
        if (seen.has(child.href) || !ok(child)) continue;
        seen.add(child.href);
        out.push({
          href: child.href,
          label: child.label,
          icon: child.icon,
          parentLabel: item.label,
        });
      }
    }
  }
  return out;
}

/**
 * Merge a Customize selection back into the saved list without losing what
 * the editor could not see.
 *
 * A department manager may lack a gate the owner has (Integrations is
 * owner/admin only). Their checklist does not show it, and a naive save would
 * silently delete it from the profile. So: hrefs outside `visible` are kept as
 * they were, in place; visible hrefs follow the checkboxes; newly checked
 * hrefs are appended in checklist order.
 */
export function mergeNavSelection(
  original: readonly string[],
  visible: readonly string[],
  checked: ReadonlySet<string>,
): string[] {
  const visibleSet = new Set(visible);
  const kept = original.filter((h) => !visibleSet.has(h) || checked.has(h));
  const added = visible.filter((h) => checked.has(h) && !kept.includes(h));
  return [...kept, ...added];
}
