/**
 * WARP-2971 — the Workspace layout's information architecture.
 *
 * The 2026-09-19 design handoff (`design_handoff_workspace_nav`) rebuilds the
 * dashboard's navigation as three horizontal levels and no left rail:
 *
 *   Level 1 — Spaces        top tabs        Home · Work · Business · Operations
 *                                           · Intelligence · Admin
 *   Level 2 — Destinations  chips           every existing route
 *   Level 3 — Views         in-page pills   a destination's routed children
 *
 * It ships as a SECOND layout, not a replacement (see `lib/nav-layout.tsx`):
 * the sidebar stays the default and this file only says how the same
 * destinations regroup when a person picks "Workspace tabs".
 *
 * Two rules keep it from becoming a second nav definition:
 *
 *   1. A destination is an HREF, nothing more. Label, icon, `roles`,
 *      `requiresCapability`, `requiresModule`, `badgeKey`, `children` all
 *      come from the matching `NAV_GROUPS` entry at resolve time. Renaming a
 *      route or tightening its gate in `nav-config.ts` reaches this layout
 *      with no second edit; an href that stops existing there fails the
 *      `workspace-nav-config.test.ts` pin rather than silently rendering a
 *      dead chip.
 *   2. Only the SURFACE differs. `passesGates` (role/capability/module) is
 *      the sidebar's own predicate; what this layout does not apply is the
 *      WARP-1807 `hidden` tuck, because the handoff lists Knowledge and
 *      Context as first-class Intelligence destinations. A tucked item is
 *      still gated exactly as the sidebar gates it.
 *
 * The handoff had five spaces. Stage carries the ADR-044 Business group
 * (Insights, Brief, Customers, Projects, Money, Practice) that post-dates the
 * handoff's read of the repo, so it is a sixth space here rather than folded
 * into Work — ADR-044's point was that those pages are one subject.
 *
 * ── WARP-2967 and this file ────────────────────────────────────────────────
 *
 * WARP-2967 cut the SIDEBAR to four groups and moved sixteen destinations
 * behind Settings. Rule 2 above is exactly what kept this map from needing a
 * re-cut: `hidden` is a surface decision, so a tucked item stays a first-class
 * chip here, and the routes that merely changed INDENT in the sidebar (Brief,
 * Reports and Money; Voice and Remote access) were already chips of their own.
 *
 * What the nesting DOES reach: a child inherits its parent's gate here too
 * (`allowed()` below checks `entry.parent`), so Money now needs the `projects`
 * module and Voice needs `network`, matching the sidebar exactly. That is the
 * mirror this file promises, not a divergence.
 */
import type { LucideIcon } from "lucide-react";
import {
  Brain,
  Briefcase,
  Building2,
  House,
  Radar,
  ShieldCheck,
} from "lucide-react";

import {
  NAV_GROUPS,
  passesGates,
  pathMatches,
  type AuthRole,
  type NavCapabilities,
  type NavItem,
} from "@/components/nav-config";

export type SpaceId = "home" | "work" | "business" | "ops" | "ai" | "admin";

export interface SpaceDef {
  id: SpaceId;
  label: string;
  /** Mobile bottom-bar glyph; the desktop tab is text-only per the handoff. */
  icon: LucideIcon;
  /**
   * Destination hrefs, in chip order. Each MUST be a top-level `NAV_GROUPS`
   * item or one of their `children` (the test pins it). Order is the
   * handoff's, with the post-handoff routes slotted where their nav-config
   * comments say they belong.
   */
  hrefs: string[];
}

export const SPACES: SpaceDef[] = [
  {
    id: "home",
    label: "Home",
    icon: House,
    // Overview · Reports · Health · Activity — "what's happening now", "how
    // did it go", "is the box well", "what did the assistant do".
    //
    // WARP-2967 nested /reports under Insights in the SIDEBAR; the handoff
    // reads it as the Home space's "how did it go", and rule 2 says only the
    // surface may differ. It stays a Home chip, gated exactly as the sidebar
    // gates it (its own roles, plus its new parent's — identical arrays).
    hrefs: ["/", "/reports", "/health", "/admin/claude-activity"],
  },
  {
    id: "work",
    label: "Work",
    icon: Briefcase,
    // Files · Email · Calendar · Messages, then the two post-handoff Workspace
    // routes (Routines, Workshop) — nav-config files both as "their work".
    //
    // WARP-2966 promoted Sync devices out of Files' children and tucked it
    // (`hidden: true`) so the sidebar's Files section reads as one idea. Rule
    // 2 above applies exactly as it does to Knowledge and Context: the tuck is
    // a SURFACE decision, so this layout keeps it as a first-class chip — next
    // to Files, whose `files` module gate it still carries.
    hrefs: [
      "/files",
      "/files/devices",
      "/email",
      "/calendar",
      "/messages",
      "/routines",
      "/workshop",
    ],
  },
  {
    id: "business",
    label: "Business",
    icon: Building2,
    // The ADR-044 group, in its nav-config order.
    hrefs: ["/business", "/brief", "/customers", "/projects", "/money", "/practice"],
  },
  {
    id: "ops",
    label: "Operations",
    icon: Radar,
    // Events is a CHILD of Cameras in the sidebar; the handoff promotes it to
    // its own chip (they read as two destinations, not one section). WARP-2967
    // did the same to Voice and Remote access, which were already chips here.
    //
    // WARP-2968 (#2241) made Credentials a SIBLING of Integrations rather than
    // its child, so it is its own chip here too — the pin in
    // workspace-nav-config.test.ts caught the two PRs crossing on stage.
    // WARP-2967 then tucked both behind Settings in the sidebar; rule 2 keeps
    // them chips here, with their owner/admin gate untouched.
    hrefs: [
      "/cameras",
      "/events",
      "/network",
      "/devices",
      "/voice",
      "/remote-access",
      "/integrations",
      "/integrations/credentials",
    ],
  },
  {
    id: "ai",
    label: "Intelligence",
    icon: Brain,
    // Ask AI · Knowledge · Context · Models · Tools, plus the WARP-2823
    // Assistant inspector — it explains what the assistant can reach, which is
    // this space's subject even though nav-config files it under Admin.
    hrefs: ["/chat", "/knowledge", "/context", "/models", "/tools", "/admin/prompt"],
  },
  {
    id: "admin",
    label: "Admin",
    icon: ShieldCheck,
    hrefs: [
      "/admin",
      "/users",
      "/admin/files",
      "/settings",
      "/admin/audit",
      "/trust",
      "/admin/rag-eval",
      "/downloads",
      "/help",
    ],
  },
];

/** A destination once resolved against the nav definition and the viewer. */
export interface Destination {
  item: NavItem;
  /**
   * Level 3 — the destination's routed children that are not themselves a
   * chip somewhere, rendered as view pills under the page head (the sidebar
   * showed them as an indented sub-nav, which this layout has no rail for).
   * Empty when there would be fewer than two: a single pill is a title.
   */
  views: NavItem[];
}

export interface Space {
  def: SpaceDef;
  destinations: Destination[];
}

interface Indexed {
  item: NavItem;
  /** Set when the href is a `children` entry — it inherits the parent's gate. */
  parent?: NavItem;
}

/** href → nav entry, over top-level items and their children. Built once:
 *  `NAV_GROUPS` is a module constant. A child that repeats its parent's href
 *  (Files' "All files" index) resolves to the PARENT, so the chip carries the
 *  section label and the child stays a view. */
const INDEX: Map<string, Indexed> = (() => {
  const m = new Map<string, Indexed>();
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      m.set(item.href, { item });
      for (const child of item.children ?? []) {
        if (!m.has(child.href)) m.set(child.href, { item: child, parent: item });
      }
    }
  }
  return m;
})();

const DESTINATION_HREFS: ReadonlySet<string> = new Set(
  SPACES.flatMap((s) => s.hrefs),
);

/** Exported for the pin that every nav href has exactly one home. */
export function indexedNavHrefs(): string[] {
  return [...INDEX.keys()];
}

/**
 * Resolve the spaces for one viewer. Mirrors `visibleItems` gate-for-gate
 * (a child drops with its parent; a switched-off module drops its chip), with
 * the one documented difference that `hidden` does not apply. Spaces with no
 * visible destination are dropped, so the tab row never advertises an empty
 * space — the handoff's "a space with no visible destinations must not render
 * its tab".
 */
export function resolveSpaces(
  role: AuthRole | undefined,
  capabilities: NavCapabilities,
  isModuleOn: (moduleId: string) => boolean,
): Space[] {
  const allowed = (entry: Indexed): boolean =>
    passesGates(entry.item, role, capabilities, isModuleOn) &&
    (!entry.parent ||
      passesGates(entry.parent, role, capabilities, isModuleOn));

  return SPACES.map((def) => {
    const destinations: Destination[] = [];
    for (const href of def.hrefs) {
      const entry = INDEX.get(href);
      if (!entry || !allowed(entry)) continue;
      const views = viewsFor(entry.item, role, capabilities, isModuleOn);
      destinations.push({ item: entry.item, views });
    }
    return { def, destinations };
  }).filter((s) => s.destinations.length > 0);
}

function viewsFor(
  item: NavItem,
  role: AuthRole | undefined,
  capabilities: NavCapabilities,
  isModuleOn: (moduleId: string) => boolean,
): NavItem[] {
  const children = (item.children ?? []).filter(
    (child) =>
      // A child that is a chip in its own right (Events under Cameras) is not
      // also a view; the section's own index (Files' "All files" repeats the
      // parent href) is.
      (child.href === item.href || !DESTINATION_HREFS.has(child.href)) &&
      !child.hidden &&
      passesGates(child, role, capabilities, isModuleOn),
  );
  if (children.length === 0) return [];
  // Integrations' only child is Credentials; a pill row of one is a title.
  // Lead with the section itself so the row reads "Integrations · Credentials"
  // and the parent route stays reachable from the row. Files already lists
  // its own index ("All files") as a child, so nothing is prepended there.
  const views = children.some((c) => c.href === item.href)
    ? children
    : [{ ...item, exact: true }, ...children];
  return views.length >= 2 ? views : [];
}

export interface Location {
  space: Space;
  destination: Destination;
  /** The active Level-3 view, when the destination has views. */
  view: NavItem | null;
}

/**
 * Where a pathname sits in the resolved spaces — derived, never stored (the
 * handoff: "the space tab is inferred, never stored separately from the
 * route"). Longest matching destination href wins, segment-aware via
 * `pathMatches`, so `/files/recents` lands on Files and `/admin/audit` on
 * Audit log rather than Console. `null` for a route no chip leads to
 * (`/clips`, `/cameras/<name>` still resolves to Cameras by prefix).
 */
export function locate(spaces: Space[], pathname: string): Location | null {
  let best: { space: Space; destination: Destination } | null = null;
  let bestLen = -1;
  for (const space of spaces) {
    for (const destination of space.destinations) {
      const href = destination.item.href;
      const hit = destination.item.exact
        ? pathname === href
        : pathMatches(pathname, href);
      if (hit && href.length > bestLen) {
        best = { space, destination };
        bestLen = href.length;
      }
    }
  }
  if (!best) return null;
  let view: NavItem | null = null;
  let viewLen = -1;
  for (const v of best.destination.views) {
    const hit = v.exact ? pathname === v.href : pathMatches(pathname, v.href);
    if (hit && v.href.length > viewLen) {
      view = v;
      viewLen = v.href.length;
    }
  }
  return { ...best, view };
}
