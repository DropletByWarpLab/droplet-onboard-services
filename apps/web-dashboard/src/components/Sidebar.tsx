"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BookOpen,
  Calendar as CalendarIcon,
  Film,
  FolderOpen,
  Globe,
  Home,
  Laptop,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Network,
  Settings,
  Trash2,
  Star,
  Clock,
  Share2,
  Users,
  Video,
} from "lucide-react";
import { DropletMark } from "./DropletMark";
import { ThemeToggle } from "./ThemeToggle";
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
  { href: "/devices", label: "Devices", icon: Home },
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
];

const navItems: NavItem[] = [...primaryNav, ...secondaryNav];

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

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const showFilesSubNav = pathname.startsWith("/files");

  async function handleLogout() {
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

  return (
    <>
      {/* ── Desktop Sidebar ── */}
      <aside
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

      {/* ── Mobile Bottom Tab Bar (primary items only for density) ── */}
      <nav
        className="
          lg:hidden fixed bottom-0 inset-x-0 z-40
          bg-[var(--color-toolbar-bg)] dp-material
          border-t border-separator
          pb-[env(safe-area-inset-bottom)]
        "
      >
        <div className="flex items-stretch h-[56px]">
          {primaryNav.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`
                  flex-1 flex flex-col items-center justify-center gap-0.5
                  min-h-[44px] transition-colors duration-200 ease-smooth
                  ${active ? "text-accent" : "text-label-tertiary"}
                `}
              >
                <Icon size={22} strokeWidth={active ? 2 : 1.5} />
                <span className="type-caption-2">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
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
