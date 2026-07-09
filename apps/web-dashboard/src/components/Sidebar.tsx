"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  BookOpen,
  Calendar as CalendarIcon,
  Cpu,
  Film,
  FlaskConical,
  FolderKanban,
  FolderOpen,
  Globe,
  HardDrive,
  HeartPulse,
  HelpCircle,
  Laptop,
  LayoutDashboard,
  LogOut,
  Mail,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Network,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Star,
  Clock,
  Share2,
  Users,
  Video,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { DropletMark } from "./DropletMark";
import { ThemeToggle } from "./ThemeToggle";
import { Dialog } from "./Dialog";
import { useAuth } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace";
import { useCapabilities } from "@/lib/hooks/useCapabilities";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * Restrict visibility by workspace. Default: visible in both.
   * Phase 3 entries (Roles, Groups, Sessions, Billing) will set
   * `workspace: "business"` so Home users never see them.
   */
  workspace?: "home" | "business";
  /** Restrict visibility by role. Default: visible to all. */
  roles?: Array<NonNullable<AuthRole>>;
  /**
   * Hide unless the named backend capability is wired (GET
   * /api/admin/capabilities). Used for optional admin surfaces whose backing
   * integration may be unconfigured. Default: no capability gate.
   */
  requiresCapability?: "claudeActivity" | "ragEval";
  /**
   * Nested sub-navigation. When present, the desktop sidebar reveals these
   * children indented under the parent whenever the user is anywhere inside
   * the parent section (the parent's href OR any child's href). Mirrors the
   * Files sub-nav pattern, generalized so any section can nest (e.g. Events
   * under Cameras). Children are rendered flat in the mobile "More" drawer so
   * every destination stays reachable with a single tap.
   */
  children?: NavItem[];
  /**
   * Match this item's active state by exact path equality instead of the
   * default `startsWith` prefix match. Used by section-index sub-items (e.g.
   * the Cameras index sits at /cameras, but /events is a sibling child — the
   * index must not light up when a deeper child route is active).
   */
  exact?: boolean;
};

type AuthRole = "owner" | "admin" | "family" | "guest";

type NavGroup = {
  /** Caption shown above the group (sentence case is intentional — the
   *  caption is rendered with `uppercase tracking-[0.18em] type-caption-1`
   *  so we let CSS handle the visual upper-casing instead of duplicating
   *  it in copy). */
  label: string;
  items: NavItem[];
};

/* ─────────── Nav definition (re-pointed 2026-05-18 from flat lists) ───────────
   Groups mirror the redesign's Workspace / Operations / Admin IA.
   Routes are unchanged — only labels and grouping are new. The /users
   route is rendered with the label "People" to match the Business-mode
   vocabulary; in Home mode it still reads "People" since "family member"
   is friendlier than "user" even at home. */
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Home", icon: LayoutDashboard },
      { href: "/chat", label: "Ask AI", icon: MessageSquare },
      {
        href: "/files",
        label: "Files",
        icon: FolderOpen,
        // Files sub-nav — the original nesting, now expressed via the
        // generalized `children` mechanism (was the standalone filesSubNav
        // const). Reveals on any /files/* route. "All files" is `exact` so
        // it doesn't stay lit while you're in a deeper Files view.
        children: [
          { href: "/files", label: "All files", icon: FolderOpen, exact: true },
          { href: "/files/drives", label: "Drives", icon: HardDrive },
          { href: "/files/recents", label: "Recents", icon: Clock },
          { href: "/files/favorites", label: "Favorites", icon: Star },
          { href: "/files/shared", label: "Shared", icon: Share2 },
          { href: "/files/trash", label: "Trash", icon: Trash2 },
          { href: "/files/devices", label: "Sync Devices", icon: Laptop },
        ],
      },
      // WARP-837: Email triage surface. Left unrestricted — the backend allows
      // owner/admin/family and RBAC-scopes accounts per user; the send tier is
      // gated to owner/admin in the UI + server. No unread-count badge (the
      // NavItem type has no count field; out of scope).
      { href: "/email", label: "Email", icon: Mail },
      { href: "/calendar", label: "Calendar", icon: CalendarIcon },
      // ADR-026: native PM surface — sits next to Calendar (both are
      // time/workflow-oriented) and ahead of Knowledge (the read-only search
      // index). Page at /projects renders natively off /api/pm/* under the
      // dashboard session — no embedded stack, no second login.
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/knowledge", label: "Knowledge", icon: BookOpen },
      // WARP-225: per-user context-meter. Lives next to Knowledge so the
      // eye reads them paired — /knowledge is "what's indexed" by file,
      // /context is "what's indexed" by capability density.
      { href: "/context", label: "Context", icon: Sparkles },
    ],
  },
  {
    label: "Operations",
    items: [
      // Cameras owns the surveillance section. Events nests beneath it
      // (Samantha QA #bugs) — they were flat siblings, which read as two
      // unrelated destinations. The sub-nav reveals on /cameras or /events
      // (mirrors the Files sub-nav). The Cameras parent link IS the section
      // index; its default prefix match keeps it lit on /cameras and the
      // /cameras/[name] detail pages, but NOT on the /events sibling (which
      // owns its own active state).
      {
        href: "/cameras",
        label: "Cameras",
        icon: Video,
        children: [
          // Events replaces the old "Clips" entry — same icon, expanded UX.
          // The /clips route still resolves (kept as a redirect) so external
          // links and the LLM tool list_clips don't 404.
          { href: "/events", label: "Events", icon: Film },
        ],
      },
      { href: "/network", label: "Network", icon: Network },
      // WARP-302: "Devices" uses Cpu (not Home) so it doesn't visually
      // collide with the Home tab's LayoutDashboard glyph at thumb distance.
      { href: "/devices", label: "Devices", icon: Cpu },
      // WARP-1055: mic health + guided calibration. A peer surface, not
      // a Settings subpage — calibration is living, health-bearing state
      // (design brief §2). Ordered Cameras · Network · Devices · Voice.
      { href: "/voice", label: "Voice", icon: Mic },
      { href: "/remote-access", label: "Remote Access", icon: Globe },
    ],
  },
  {
    label: "Admin",
    items: [
      // /users is the existing People surface. Label kept as "Users" in
      // Phase 1 so the WARP-290 a11y test contract (queries by /users/i)
      // doesn't regress; Phase 3 renames to "People" alongside test
      // updates and adds the full Roles / Groups / Sessions entries
      // with workspace:"business" set.
      { href: "/users", label: "Users", icon: Users },
      // WARP-555: read-only catalog of the assistant's built-in tools.
      // No role restriction — the /api/llm/tools/catalog route filters
      // write tools out for non-privileged roles, so family/guest see a
      // safe read-only subset. Visible in both workspaces.
      { href: "/tools", label: "Tools", icon: Wrench },
      // WARP-836: read-only Models status surface (local LLMs + opt-in cloud).
      // Unrestricted — GET /api/models is open to any authenticated principal
      // (ADR-004 §3), so family/guest see the same status-only view. Reuses the
      // Cpu glyph already imported for /devices. Active-state is automatic.
      { href: "/models", label: "Models", icon: Cpu },
      { href: "/settings", label: "Settings", icon: Settings },
      // PR #382: appliance/service health status page. Reads the existing
      // WARP-43 aggregate; sits in the support/reference zone next to Help.
      { href: "/health", label: "Health", icon: HeartPulse },
      // WARP-174: customer-facing manual + "How Droplet works" replay
      // modal. Sits next to Settings — same "support / reference" zone.
      { href: "/help", label: "Help", icon: HelpCircle },
      // WARP-279: admin-only Activity log entry. Role-gated AND hidden unless
      // GitHub/Jira is configured (capabilities.claudeActivity) — #14.
      {
        href: "/admin/claude-activity",
        label: "Activity",
        icon: Activity,
        roles: ["owner", "admin"],
        requiresCapability: "claudeActivity",
      },
      // WARP-519: ad-hoc RAGAS run + baseline bootstrap trigger surface.
      // Hidden unless RAG_EVAL_URL is set (capabilities.ragEval) — #15.
      {
        href: "/admin/rag-eval",
        label: "RAG eval",
        icon: FlaskConical,
        roles: ["owner", "admin"],
        requiresCapability: "ragEval",
      },
      // WARP-246: signed activity log viewer. Role-gated to owner/admin
      // (mirrors the orchestrator's owner/admin gate on /api/activity);
      // no capability gate — the activity surface always exists.
      {
        href: "/admin/audit",
        label: "Audit log",
        icon: ScrollText,
        roles: ["owner", "admin"],
      },
      // WARP-246: Trust Center placeholder — visible to every signed-in
      // household member (support/reference zone, next to Help).
      { href: "/trust", label: "Trust Center", icon: ShieldCheck },
    ],
  },
];

// Mobile bottom tab bar — capped at 4 + a "More" trigger. Per WARP-290
// the cap is iOS convention (7 tabs at 360px crowded each label to
// ~51px). The four hrefs below win a tab spot; the fifth slot is the
// "More" trigger that opens the drawer (see below). Everything else
// from NAV_GROUPS routes through the drawer. Phase 2 will branch this
// on `workspace` (Files swaps for Cameras in Business).
const MOBILE_PRIMARY_HREFS = ["/", "/chat", "/files", "/devices"] as const;

/** Filter a group's items by current workspace + role. Returns the same
 *  shape with items shaped to render order; empty groups are caller's
 *  responsibility to skip. */
function visibleItems(
  items: NavItem[],
  workspace: "home" | "business",
  role: AuthRole | undefined,
  capabilities: { claudeActivity: boolean; ragEval: boolean },
): NavItem[] {
  return items.filter((item) => {
    if (item.workspace && item.workspace !== workspace) return false;
    if (item.roles && (!role || !item.roles.includes(role))) return false;
    if (item.requiresCapability && !capabilities[item.requiresCapability])
      return false;
    return true;
  });
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const { workspaceType, isBusiness } = useWorkspace();
  const capabilities = useCapabilities();

  // WARP-290: drawer state for the mobile "More" trigger.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreHeadingId = useId();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  // Active-state for an individual nav entry, honoring `exact`. Section-index
  // sub-items (e.g. the Cameras index at /cameras) set `exact` so they don't
  // stay lit while a deeper sibling child (/events) is the active route.
  const isItemActive = (item: NavItem) =>
    item.exact ? pathname === item.href : isActive(item.href);

  // A parent section is "open" — its child sub-nav reveals — whenever the
  // user is on the parent's own route OR on any of its children's routes.
  // Generalizes the old Files-only `pathname.startsWith("/files")` check so
  // Cameras (with the Events child) reveals on /cameras or /events.
  const isSectionOpen = (item: NavItem) =>
    !!item.children &&
    (isActive(item.href) ||
      item.children.some((child) => isActive(child.href)));

  async function handleLogout() {
    setMoreOpen(false);
    await logout();
    router.push("/login");
  }

  const initials = user?.displayName
    ? user.displayName
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : user?.username?.slice(0, 2).toUpperCase() ?? "?";

  // Compute the rendered groups once. Empty groups (e.g. Admin when the
  // user is family/guest in Home mode without the Activity entry) are
  // filtered out so we don't render a lone caption.
  const renderedGroups = NAV_GROUPS.map((g) => ({
    label: g.label,
    items: visibleItems(
      g.items,
      workspaceType,
      user?.role as AuthRole | undefined,
      capabilities,
    ),
  })).filter((g) => g.items.length > 0);

  // Flatten for the "More" drawer — anything not in the bottom-bar
  // primary set lands here in group order. Nested children (e.g. Events
  // under Cameras) ride along with their parent: they're flattened into
  // the drawer list right after it so every destination stays reachable
  // with a single tap. A child whose parent is itself a bottom-tab primary
  // (e.g. the Files sub-views) is excluded with that parent — the drawer
  // never orphans a child under an absent parent.
  const drawerGroups = renderedGroups
    .map((g) => ({
      label: g.label,
      items: g.items
        .filter(
          (item) =>
            !MOBILE_PRIMARY_HREFS.includes(
              item.href as (typeof MOBILE_PRIMARY_HREFS)[number],
            ),
        )
        .flatMap((item) => {
          const children = (item.children ?? []).filter(
            (child) => child.href !== item.href,
          );
          return [item, ...children];
        }),
    }))
    .filter((g) => g.items.length > 0);

  // The four hrefs that survive into the bottom tab bar. Each looked up
  // against the full nav so the icon + label match the desktop sidebar.
  const mobileTabs: NavItem[] = MOBILE_PRIMARY_HREFS.map((href) => {
    for (const g of NAV_GROUPS) {
      const found = g.items.find((i) => i.href === href);
      if (found) return found;
    }
    // This shouldn't happen — the constant is hand-curated against NAV_GROUPS.
    return { href, label: href, icon: LayoutDashboard };
  });

  return (
    <>
      {/* ── Desktop Sidebar ── */}
      <aside
        aria-label="Primary navigation"
        className="
          hidden lg:flex lg:flex-col lg:fixed lg:inset-y-0 lg:left-0 lg:w-[260px]
          bg-[var(--color-sidebar-bg)] dp-material
          border-r border-separator z-40
        "
      >
        {/* Logo + workspace badge */}
        <div className="flex items-center gap-2.5 px-5 h-16">
          <DropletMark size={22} className="text-accent" />
          <span className="type-headline text-label-primary tracking-tight">
            Droplet
          </span>
          {/* Tiny chip — tells the user which IA they're in. Click-through
              to /settings/workspace lands in Phase 4. */}
          <span
            className={`
              ml-auto type-caption-2 px-1.5 py-0.5 rounded-full border
              ${
                isBusiness
                  ? "border-accent/30 text-accent bg-accent-subtle"
                  : "border-separator text-label-tertiary bg-surface-secondary"
              }
            `}
            title={
              isBusiness
                ? "Business workspace — full admin surfaces"
                : "Home workspace — simplified IA"
            }
          >
            {isBusiness ? "Business" : "Home"}
          </span>
        </div>

        {/* Navigation */}
        <nav
          aria-label="Sections"
          className="flex-1 px-3 py-1 overflow-y-auto"
        >
          {renderedGroups.map((group, groupIndex) => (
            <div key={group.label} className={groupIndex > 0 ? "mt-4" : ""}>
              {/* Section caption. Apple-HIG-style: uppercase + tracking
                  + tertiary label color. Kept tiny so groups read as
                  organizational, not as primary nav. */}
              <p
                className="
                  px-3 mb-1 type-caption-2 uppercase tracking-[0.18em]
                  text-label-tertiary font-semibold
                "
              >
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={isItemActive(item)}
                    showChildren={isSectionOpen(item)}
                    pathname={pathname}
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-4 pb-4 pt-3 space-y-3 border-t border-separator">
          <ThemeToggle />

          {user && (
            <div className="flex items-center gap-2.5 px-1 py-1">
              <div className="w-8 h-8 rounded-full bg-accent-subtle flex items-center justify-center flex-shrink-0">
                <span className="type-caption-1 text-accent font-semibold">
                  {initials}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="type-footnote text-label-primary font-medium truncate">
                  {user.displayName || user.username}
                </p>
                <p className="type-caption-2 text-label-tertiary truncate">
                  {user.username}
                </p>
              </div>
              <button
                onClick={handleLogout}
                className="
                  p-1.5 rounded-sm text-label-tertiary
                  hover:text-system-red hover:bg-system-red/10
                  transition-colors
                "
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut size={14} />
              </button>
            </div>
          )}

          <p className="type-caption-2 text-label-quaternary text-center">
            Droplet v0.1.0
          </p>
        </div>
      </aside>

      {/* ── Mobile Bottom Tab Bar — 4 + More ── */}
      <nav
        aria-label="Bottom navigation"
        className="
          lg:hidden fixed bottom-0 inset-x-0 z-40
          bg-[var(--color-toolbar-bg)] dp-material
          border-t border-separator
          pb-[env(safe-area-inset-bottom)]
        "
      >
        <div className="flex items-stretch h-[56px]">
          {mobileTabs.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`
                  flex-1 flex flex-col items-center justify-center gap-0.5
                  min-h-[44px] transition-colors duration-200 ease-smooth
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                  ${active ? "bg-accent-subtle text-accent" : "text-label-tertiary"}
                `}
              >
                <Icon size={22} strokeWidth={active ? 2 : 1.5} />
                <span className="type-caption-2 whitespace-nowrap">
                  {item.label}
                </span>
              </Link>
            );
          })}

          <button
            ref={moreTriggerRef}
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            className={`
              flex-1 flex flex-col items-center justify-center gap-0.5
              min-h-[44px] transition-colors duration-200 ease-smooth
              text-label-tertiary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
              ${moreOpen ? "bg-accent-subtle text-accent" : ""}
            `}
          >
            <MoreHorizontal size={22} strokeWidth={moreOpen ? 2 : 1.5} />
            <span className="type-caption-2 whitespace-nowrap">More</span>
          </button>
        </div>
      </nav>

      {/* ── Mobile "More" drawer ── */}
      <Dialog
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        triggerRef={moreTriggerRef}
        labelledBy={moreHeadingId}
        placement="right"
        // Sectioned full-height drawer — sections own their padding
        // (WARP-1153).
        flush
      >
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-between px-5 h-16 border-b border-separator">
            <h2 id={moreHeadingId} className="type-headline text-label-primary">
              More
            </h2>
            <span
              className={`
                type-caption-2 px-2 py-0.5 rounded-full border
                ${
                  isBusiness
                    ? "border-accent/30 text-accent bg-accent-subtle"
                    : "border-separator text-label-tertiary bg-surface-secondary"
                }
              `}
            >
              {isBusiness ? "Business" : "Home"}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
            {drawerGroups.map((group, groupIndex) => (
              <div key={`drawer-${group.label}`}>
                {/* Hairline separator between groups — pinned by the
                    WARP-290 drawer separator test. Skipped before the
                    first group so the drawer doesn't open with one. */}
                {groupIndex > 0 && (
                  <div className="px-3 pt-2 pb-2">
                    <div className="h-px bg-separator" />
                  </div>
                )}
                <p
                  className="
                    px-3 mb-1 type-caption-2 uppercase tracking-[0.18em]
                    text-label-tertiary font-semibold
                  "
                >
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const active = isActive(item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setMoreOpen(false)}
                        aria-current={active ? "page" : undefined}
                        className={`
                          flex items-center gap-3 px-3 min-h-[44px] rounded-lg
                          type-subheadline transition-all duration-200 ease-smooth
                          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                          ${
                            active
                              ? "bg-accent-subtle text-accent font-medium"
                              : "text-label-secondary hover:bg-surface-secondary hover:text-label-primary"
                          }
                        `}
                      >
                        <Icon size={18} strokeWidth={active ? 2 : 1.5} />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="px-3 pt-4 pb-2">
              <div className="h-px bg-separator" />
            </div>

            <div className="flex items-center min-h-[44px] px-3">
              <ThemeToggle />
            </div>
          </div>

          {user && (
            <div className="px-3 py-3 border-t border-separator">
              <div className="flex items-center gap-2.5 px-2 py-2">
                <div className="w-8 h-8 rounded-full bg-accent-subtle flex items-center justify-center flex-shrink-0">
                  <span className="type-caption-1 text-accent font-semibold">
                    {initials}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="type-footnote text-label-primary font-medium truncate">
                    {user.displayName || user.username}
                  </p>
                  <p className="type-caption-2 text-label-tertiary truncate">
                    {user.username}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="
                  mt-1 w-full flex items-center gap-3 px-3 min-h-[44px] rounded-lg
                  type-subheadline text-system-red hover:bg-system-red/10
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                  transition-colors duration-200 ease-smooth
                "
              >
                <LogOut size={18} strokeWidth={1.75} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}

/* ─────────────────────── Nav link sub-component ──────────────────────── */

function NavLink({
  item,
  active,
  showChildren,
  pathname,
}: {
  item: NavItem;
  active: boolean;
  /** Reveal the nested `item.children` sub-nav (we're inside this section). */
  showChildren?: boolean;
  pathname: string;
}) {
  const Icon = item.icon;
  return (
    <div>
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={`
          flex items-center gap-3 px-3 h-9 rounded-lg
          type-subheadline transition-all duration-200 ease-smooth
          ${
            active
              ? "bg-accent-subtle text-accent font-medium"
              : "text-label-secondary hover:bg-surface-secondary hover:text-label-primary"
          }
        `}
      >
        <Icon size={17} strokeWidth={active ? 2 : 1.5} />
        {item.label}
      </Link>

      {showChildren && item.children && (
        <div className="ml-7 mt-1 space-y-0.5">
          {item.children.map((sub) => {
            const SubIcon = sub.icon;
            const subActive = sub.exact
              ? pathname === sub.href
              : pathname.startsWith(sub.href);
            return (
              <Link
                key={sub.href}
                href={sub.href}
                aria-current={subActive ? "page" : undefined}
                className={`
                  flex items-center gap-2 px-2 h-8 rounded-md
                  type-footnote transition-all duration-200 ease-smooth
                  ${
                    subActive
                      ? "text-accent font-medium"
                      : "text-label-tertiary hover:text-label-primary"
                  }
                `}
              >
                <SubIcon size={14} strokeWidth={subActive ? 2 : 1.5} />
                {sub.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
