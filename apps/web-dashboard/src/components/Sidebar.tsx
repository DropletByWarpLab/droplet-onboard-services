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
  FolderOpen,
  Globe,
  HardDrive,
  HelpCircle,
  Laptop,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Network,
  Settings,
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
      { href: "/files", label: "Files", icon: FolderOpen },
      { href: "/calendar", label: "Calendar", icon: CalendarIcon },
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
      { href: "/cameras", label: "Cameras", icon: Video },
      // Events replaces the old "Clips" entry — same icon, expanded UX.
      // The /clips route still resolves (kept as a redirect) so external
      // links and the LLM tool list_clips don't 404.
      { href: "/events", label: "Events", icon: Film },
      { href: "/network", label: "Network", icon: Network },
      // WARP-302: "Devices" uses Cpu (not Home) so it doesn't visually
      // collide with the Home tab's LayoutDashboard glyph at thumb distance.
      { href: "/devices", label: "Devices", icon: Cpu },
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
      { href: "/settings", label: "Settings", icon: Settings },
      // WARP-174: customer-facing manual + "How Droplet works" replay
      // modal. Sits next to Settings — same "support / reference" zone.
      { href: "/help", label: "Help", icon: HelpCircle },
      // WARP-279: admin-only Activity log entry. Visibility gated below.
      {
        href: "/admin/claude-activity",
        label: "Activity",
        icon: Activity,
        roles: ["owner", "admin"],
      },
      // WARP-519: ad-hoc RAGAS run + baseline bootstrap trigger surface.
      {
        href: "/admin/rag-eval",
        label: "RAG eval",
        icon: FlaskConical,
        roles: ["owner", "admin"],
      },
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

// Sub-navigation rendered under Files when we're on a /files/* route.
const filesSubNav = [
  { href: "/files", label: "All files", icon: FolderOpen, exact: true },
  { href: "/files/drives", label: "Drives", icon: HardDrive, exact: false },
  { href: "/files/recents", label: "Recents", icon: Clock, exact: false },
  { href: "/files/favorites", label: "Favorites", icon: Star, exact: false },
  { href: "/files/shared", label: "Shared", icon: Share2, exact: false },
  { href: "/files/trash", label: "Trash", icon: Trash2, exact: false },
  { href: "/files/devices", label: "Sync Devices", icon: Laptop, exact: false },
];

/** Filter a group's items by current workspace + role. Returns the same
 *  shape with items shaped to render order; empty groups are caller's
 *  responsibility to skip. */
function visibleItems(
  items: NavItem[],
  workspace: "home" | "business",
  role: AuthRole | undefined,
): NavItem[] {
  return items.filter((item) => {
    if (item.workspace && item.workspace !== workspace) return false;
    if (item.roles && (!role || !item.roles.includes(role))) return false;
    return true;
  });
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const { workspaceType, isBusiness } = useWorkspace();

  // WARP-290: drawer state for the mobile "More" trigger.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreHeadingId = useId();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const showFilesSubNav = pathname.startsWith("/files");

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
    items: visibleItems(g.items, workspaceType, user?.role as AuthRole | undefined),
  })).filter((g) => g.items.length > 0);

  // Flatten for the "More" drawer — anything not in the bottom-bar
  // primary set lands here in group order.
  const drawerGroups = renderedGroups
    .map((g) => ({
      label: g.label,
      items: g.items.filter(
        (item) =>
          !MOBILE_PRIMARY_HREFS.includes(
            item.href as (typeof MOBILE_PRIMARY_HREFS)[number],
          ),
      ),
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
                    active={isActive(item.href)}
                    showFilesSubNav={
                      item.href === "/files" && showFilesSubNav
                    }
                    filesSubNav={filesSubNav}
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
  showFilesSubNav,
  filesSubNav: subNav,
  pathname,
}: {
  item: NavItem;
  active: boolean;
  showFilesSubNav?: boolean;
  filesSubNav?: typeof filesSubNav;
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

      {showFilesSubNav && subNav && (
        <div className="ml-7 mt-1 space-y-0.5">
          {subNav.map((sub) => {
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
