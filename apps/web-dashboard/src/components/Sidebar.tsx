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
  FolderOpen,
  Globe,
  HelpCircle,
  Home,
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
} from "lucide-react";
import { DropletMark } from "./DropletMark";
import { ThemeToggle } from "./ThemeToggle";
import { Dialog } from "./Dialog";
import { useAuth } from "@/lib/auth";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Home;
};

const primaryNav: NavItem[] = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/chat", label: "Ask AI", icon: MessageSquare },
  { href: "/calendar", label: "Calendar", icon: CalendarIcon },
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  // WARP-225: investor-grade per-user context-meter dashboard. Lives in
  // primary nav next to Knowledge so the eye reads them as paired —
  // /knowledge is "what's indexed" by file, /context is "what's
  // indexed" by capability density.
  { href: "/context", label: "Context", icon: Sparkles },
  // WARP-302: Devices uses `Cpu` (not `Home`) so it doesn't visually
  // collide with the actual Home tab's `LayoutDashboard` glyph at thumb
  // distance on mobile. `Cpu` reads as "hardware/devices" — the page
  // covers both smart-home Matter devices and paired client hardware.
  { href: "/devices", label: "Devices", icon: Cpu },
];

const secondaryNav: NavItem[] = [
  { href: "/cameras", label: "Cameras", icon: Video },
  // Events replaces the old "Clips" entry — same icon, expanded UX. The
  // /clips route still resolves (kept as a redirect) so external links
  // and the LLM tool list_clips don't 404.
  { href: "/events", label: "Events", icon: Film },
  { href: "/network", label: "Network", icon: Network },
  { href: "/remote-access", label: "Remote Access", icon: Globe },
  { href: "/users", label: "Users", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
  // WARP-174: customer-facing manual + "How Droplet works" replay
  // modal. Placed at the bottom of the secondary nav so it sits next
  // to Settings — the same "support / reference" mental zone.
  { href: "/help", label: "Help", icon: HelpCircle },
];

// WARP-279: admin-only entries appended to the secondary nav at render
// time when the current user has owner/admin role. Keeping it as a
// separate list rather than baking the role check into NavItem so the
// rest of the file stays type-stable.
const adminNav: NavItem[] = [
  { href: "/admin/claude-activity", label: "Activity", icon: Activity },
];

// WARP-290: the mobile bottom tab bar is capped at 5 surfaces (iOS
// convention; 7 tabs at 360px crowded each label to ~51px). These four
// hrefs win a tab spot — the fifth slot is the "More" trigger that
// opens the drawer (see below). Everything else from primaryNav and
// the entirety of secondaryNav routes through the drawer.
const MOBILE_PRIMARY_HREFS = ["/", "/chat", "/files", "/devices"] as const;

// Sub-navigation rendered under Files when we're on a /files/* route.
const filesSubNav = [
  { href: "/files", label: "All files", icon: FolderOpen, exact: true },
  { href: "/files/recents", label: "Recents", icon: Clock, exact: false },
  { href: "/files/favorites", label: "Favorites", icon: Star, exact: false },
  { href: "/files/shared", label: "Shared", icon: Share2, exact: false },
  { href: "/files/trash", label: "Trash", icon: Trash2, exact: false },
  { href: "/files/devices", label: "Sync Devices", icon: Laptop, exact: false },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();

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

  // WARP-290: items the bottom tab bar can't fit get folded into the
  // drawer. Three logical groups, rendered with a hairline separator
  // between each so the drawer mirrors the desktop sidebar's
  // primary / secondary / admin mental model (UX fold-in).
  const displacedPrimaryNav: NavItem[] = primaryNav.filter(
    (item) => !MOBILE_PRIMARY_HREFS.includes(item.href as typeof MOBILE_PRIMARY_HREFS[number]),
  );
  const drawerAdminNav: NavItem[] =
    user?.role === "owner" || user?.role === "admin" ? adminNav : [];

  // The four hrefs that survive into the bottom tab bar, looked up
  // against primaryNav so the icon + label match the desktop sidebar.
  const mobileTabs: NavItem[] = MOBILE_PRIMARY_HREFS.map(
    (href) => primaryNav.find((item) => item.href === href)!,
  );

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
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 h-16">
          <DropletMark size={22} className="text-accent" />
          <span className="type-headline text-label-primary tracking-tight">Droplet</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-1 space-y-0.5">
          {primaryNav.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isActive(item.href)}
              showFilesSubNav={showFilesSubNav}
              filesSubNav={filesSubNav}
              pathname={pathname}
            />
          ))}

          {/* Subtle divider between primary and secondary nav */}
          <div className="px-3 pt-4 pb-2">
            <div className="h-px bg-separator" />
          </div>

          {secondaryNav.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isActive(item.href)}
              pathname={pathname}
            />
          ))}

          {/* WARP-279: admin-only nav entries. Hidden until the user's
              role hydrates as owner/admin so we never render a link the
              orchestrator would 403. */}
          {(user?.role === "owner" || user?.role === "admin") && (
            <>
              <div className="px-3 pt-4 pb-2">
                <div className="h-px bg-separator" />
              </div>
              {adminNav.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  active={isActive(item.href)}
                  pathname={pathname}
                />
              ))}
            </>
          )}
        </nav>

        {/* Footer */}
        <div className="px-4 pb-4 space-y-3">
          <ThemeToggle />

          {/* User info + logout */}
          {user && (
            <div className="flex items-center gap-2.5 px-1 py-1">
              <div className="w-8 h-8 rounded-full bg-accent/15 flex items-center justify-center flex-shrink-0">
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
                className="p-1.5 rounded-sm text-label-tertiary hover:text-system-red hover:bg-system-red/10 transition-colors"
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

      {/* ── Mobile Bottom Tab Bar — WARP-290: 5 surfaces max ──
          Home / Ask AI / Files / Devices / More. The "More" trigger
          opens a side-panel dialog (placement="right") via the WARP-289
          <Dialog> primitive that hosts every displaced primaryNav item
          + every secondaryNav destination + theme toggle + sign-out. */}
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
                <span className="type-caption-2 whitespace-nowrap">{item.label}</span>
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

      {/* ── Mobile "More" drawer — WARP-290 ── */}
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
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
            {[displacedPrimaryNav, secondaryNav, drawerAdminNav]
              .filter((group) => group.length > 0)
              .map((group, groupIndex, groups) => (
                <div key={`drawer-group-${groupIndex}`}>
                  {group.map((item) => {
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
                  {groupIndex < groups.length - 1 && (
                    <div className="px-3 pt-2 pb-2">
                      <div className="h-px bg-separator" />
                    </div>
                  )}
                </div>
              ))}

            <div className="px-3 pt-4 pb-2">
              <div className="h-px bg-separator" />
            </div>

            {/* Theme toggle rendered as a full-height row so it reads as
                a peer of the nav items, not a hidden subnav. The toggle
                component owns its own internal layout (light/dark/system
                segmented control). */}
            <div className="flex items-center min-h-[44px] px-3">
              <ThemeToggle />
            </div>
          </div>

          {/* User identity card + sign-out — destructive-emphasis
              text-system-red, mirroring the desktop sidebar logout
              affordance. */}
          {user && (
            <div className="px-3 py-3 border-t border-separator">
              <div className="flex items-center gap-2.5 px-2 py-2">
                <div className="w-8 h-8 rounded-full bg-accent/15 flex items-center justify-center flex-shrink-0">
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

// ─────────────────────── Nav link sub-component ────────────────────────

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

      {item.href === "/files" && showFilesSubNav && subNav && (
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
