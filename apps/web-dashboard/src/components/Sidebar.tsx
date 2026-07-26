"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, MoreHorizontal } from "lucide-react";
import { DropletMark } from "./DropletMark";
import { ThemeToggle } from "./ThemeToggle";
import { Dialog } from "./Dialog";
import { useAuth } from "@/lib/auth";
import { useCapabilities } from "@/lib/hooks/useCapabilities";
import { useModuleGate } from "@/lib/hooks/useModuleGate";
// The nav definition + its pure gate predicates live beside this component
// (WARP-1528) so the route guard and the tests can read them without pulling
// in the chrome. This file owns rendering; nav-config owns what there is to
// render and who may see it.
import {
  MOBILE_PRIMARY_HREFS,
  NAV_GROUPS,
  visibleItems,
  type AuthRole,
  type NavItem,
} from "./nav-config";

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const capabilities = useCapabilities();
  const isModuleOn = useModuleGate();

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
  // user is family/guest without the Activity entry) are filtered out so
  // we don't render a lone caption.
  const renderedGroups = NAV_GROUPS.map((g) => ({
    label: g.label,
    items: visibleItems(
      g.items,
      user?.role as AuthRole | undefined,
      capabilities,
      isModuleOn,
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

  // The primary hrefs that survive into the bottom tab bar. WARP-1397: looked
  // up against the GATED `renderedGroups`, NOT the raw NAV_GROUPS — otherwise a
  // module-gated primary (/files, /devices) would still render a dead bottom
  // tab on mobile while the desktop sidebar and "More" drawer correctly hide
  // it (the exact dead-surface state this gate exists to remove). A primary
  // whose module is off is dropped; the bar simply shows fewer tabs (the
  // surface is genuinely gone), and everything non-primary stays in the
  // drawer.
  const mobileTabs: NavItem[] = MOBILE_PRIMARY_HREFS.map((href) => {
    for (const g of renderedGroups) {
      const found = g.items.find((i) => i.href === href);
      if (found) return found;
    }
    return null;
  }).filter((x): x is NavItem => x !== null);

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
          {/* Tiny chip — names the workspace mode. WARP-1341: business-only
              build, so this is static. */}
          <span
            className="ml-auto type-caption-2 px-1.5 py-0.5 rounded-full border border-accent/30 text-accent bg-accent-subtle"
            title="Business workspace — full admin surfaces"
          >
            Business
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
            <span className="type-caption-2 px-2 py-0.5 rounded-full border border-accent/30 text-accent bg-accent-subtle">
              Business
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
