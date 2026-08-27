"use client";

import { Suspense, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, MoreHorizontal, X } from "lucide-react";
import { DropletMark } from "./DropletMark";
import { ThemeToggle } from "./ThemeToggle";
import { Dialog } from "./Dialog";
import { useAuth } from "@/lib/auth";
import { useCapabilities } from "@/lib/hooks/useCapabilities";
import { useModuleGate } from "@/lib/hooks/useModuleGate";
import { useTeamChatUnread } from "@/lib/hooks/useTeamChat";
// WARP-1548 — the Files places rail's Libraries group. Lives in its own
// component because it is the one piece of this nav that is DATA, not
// config: the libraries come from GET /api/files/spaces at render time.
import { FilesLibrariesNav } from "./nav/FilesLibrariesNav";
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

/** Does this href own a slot in the mobile bottom tab bar? */
const isMobilePrimary = (href: string): boolean =>
  (MOBILE_PRIMARY_HREFS as readonly string[]).includes(href);

/**
 * One block of the mobile "More" drawer: a nav destination plus the
 * sub-destinations rendered beneath it.
 *
 * `captionOnly` marks the WARP-1554 case — the anchor is a bottom-tab
 * primary, so its own row is omitted (the tab bar already goes there) and it
 * renders as a non-navigating caption instead. Its children still render, so
 * they stay reachable without ever appearing orphaned under an absent parent.
 */
type DrawerEntry = {
  item: NavItem;
  children: NavItem[];
  captionOnly: boolean;
};

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const capabilities = useCapabilities();
  const isModuleOn = useModuleGate();
  // WARP-1683: resolves nav-config's `badgeKey` names to live counts. The
  // Sidebar owns the polling hook (nav-config stays pure data); the badge
  // reads 0 — and renders nothing — while the module is off or unresolved.
  const teamChatUnread = useTeamChatUnread();
  const badgeCounts: Record<NonNullable<NavItem["badgeKey"]>, number> = {
    teamChatUnread,
  };

  // WARP-290: drawer state for the mobile "More" trigger.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreHeadingId = useId();
  // WARP-1554: base id for the drawer's non-navigating section captions —
  // each caption labels the group of sub-views rendered beneath it.
  const drawerSectionBaseId = useId();
  const sectionCaptionId = (href: string) =>
    `${drawerSectionBaseId}${href.replace(/[^a-zA-Z0-9]+/g, "-")}`;

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
  // with a single tap.
  //
  // WARP-1554: a bottom-tab primary's OWN row is still dropped (it already
  // owns a tab), but its children are no longer dropped with it. They used
  // to be, which left the six Files sub-views (Drives, Recents, Favorites,
  // Shared, Trash, Sync Devices) with no mobile navigation path at all — not
  // in the tab bar, not in the drawer, and the desktop sub-nav renders inside
  // a `hidden lg:flex` aside. Such children now render under a
  // non-navigating caption carrying the parent's label + glyph, which keeps
  // the original intent intact: a child is never orphaned under an absent
  // parent — the parent is present, as a label rather than a link.
  //
  // Gating still flows through `visibleItems` alone, so a child hidden on its
  // own gate (or with its parent) never reaches this point.
  //
  // A child whose href is itself a bottom-tab primary (the Files "All files"
  // index at /files) stays out: the tab bar already goes there, and a
  // duplicate row would read as a second, different destination.
  const drawerGroups: Array<{ label: string; entries: DrawerEntry[] }> =
    renderedGroups
      .map((g) => ({
        label: g.label,
        entries: g.items
          .map((item): DrawerEntry => {
            const children = (item.children ?? []).filter(
              (child) =>
                child.href !== item.href && !isMobilePrimary(child.href),
            );
            return { item, children, captionOnly: isMobilePrimary(item.href) };
          })
          // A primary with nothing beneath it (Overview, Ask AI, Devices)
          // contributes no drawer block at all.
          .filter((entry) => !entry.captionOnly || entry.children.length > 0),
      }))
      .filter((g) => g.entries.length > 0);

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
                    badge={item.badgeKey ? badgeCounts[item.badgeKey] : 0}
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
          <div className="flex items-center gap-3 px-5 h-16 border-b border-separator">
            <h2 id={moreHeadingId} className="type-headline text-label-primary">
              More
            </h2>
            <span className="type-caption-2 mr-auto px-2 py-0.5 rounded-full border border-accent/30 text-accent bg-accent-subtle">
              Business
            </span>
            {/* WARP-1787: below 720px the drawer is a full-width sheet, so
                the backdrop it used to be dismissed by is gone — and a phone
                has no Escape key. Same glyph, placement and label as the
                other side panels (e.g. ClientDetailPanel). `-mr-3` pulls the
                44px box out so the glyph sits on the header's own 20px
                inset. */}
            <button
              type="button"
              onClick={() => setMoreOpen(false)}
              aria-label="Close"
              className="
                -mr-3 inline-flex items-center justify-center h-11 w-11
                rounded-lg text-label-tertiary
                hover:bg-surface-secondary transition-colors duration-200 ease-smooth
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
              "
            >
              <X size={20} aria-hidden="true" />
            </button>
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
                  {group.entries.map((entry) => {
                    const closeDrawer = () => setMoreOpen(false);

                    // WARP-1554: the anchor owns a bottom tab, so it renders
                    // as a caption rather than a second link to the same
                    // place — the sub-views beneath it would otherwise have
                    // no mobile path at all. role="group" + aria-labelledby
                    // gives assistive tech the same parent/child reading the
                    // indent gives the eye.
                    if (entry.captionOnly) {
                      const CaptionIcon = entry.item.icon;
                      const captionId = sectionCaptionId(entry.item.href);
                      return (
                        <div
                          key={`drawer-section-${entry.item.href}`}
                          role="group"
                          aria-labelledby={captionId}
                        >
                          <p
                            id={captionId}
                            className="
                              flex items-center gap-2 px-3 pt-2 pb-1
                              type-caption-1 text-label-tertiary font-medium
                            "
                          >
                            <CaptionIcon
                              size={14}
                              strokeWidth={1.5}
                              aria-hidden="true"
                            />
                            {entry.item.label}
                          </p>
                          <div className="space-y-0.5">
                            {entry.children.map((child) => (
                              <DrawerLink
                                key={child.href}
                                item={child}
                                active={isActive(child.href)}
                                onNavigate={closeDrawer}
                                nested
                              />
                            ))}
                            {/* WARP-1548 — the Libraries group, in the drawer
                                as well as the desktop aside. The addendum's
                                §2.2 is explicit that the rail supersedes
                                `SpaceSwitcher` "at every width — desktop via
                                the sidebar's Files section, below 900px via
                                the mobile drawer's Files section", and the
                                desktop mount lives inside a `hidden lg:flex`
                                aside. Mounting only there left every phone
                                user with more than three libraries looking at
                                the collapsed "Spaces ▾" menu this ticket
                                exists to remove.

                                `onNavigate` because the drawer is a modal
                                that does not dismiss itself on navigation —
                                the same callback every `DrawerLink` beside it
                                takes. `variant="drawer"` for the 44px rows a
                                touch surface owes. Suspense for the same
                                reason as the aside: `useSearchParams` must be
                                read under a boundary. */}
                            {entry.item.href === "/files" && (
                              <Suspense fallback={null}>
                                <FilesLibrariesNav
                                  pathname={pathname}
                                  variant="drawer"
                                  onNavigate={closeDrawer}
                                />
                              </Suspense>
                            )}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={`drawer-item-${entry.item.href}`}
                        className="space-y-0.5"
                      >
                        <DrawerLink
                          item={entry.item}
                          active={isActive(entry.item.href)}
                          onNavigate={closeDrawer}
                          badge={
                            entry.item.badgeKey
                              ? badgeCounts[entry.item.badgeKey]
                              : 0
                          }
                        />
                        {entry.children.map((child) => (
                          <DrawerLink
                            key={child.href}
                            item={child}
                            active={isActive(child.href)}
                            onNavigate={closeDrawer}
                          />
                        ))}
                      </div>
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

/* ───────────────── Mobile "More" drawer row sub-component ─────────────── */

/**
 * One tappable row of the mobile drawer. Extracted (WARP-1554) so the three
 * places that emit a drawer row — a top-level destination, a child flattened
 * beneath its parent link, and a child nested under a section caption —
 * share one set of tap-target / focus / active-state rules instead of
 * drifting apart.
 */
function DrawerLink({
  item,
  active,
  onNavigate,
  nested,
  badge = 0,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
  /** Rendered under a section caption — indent to mirror the desktop
   *  sub-nav's nesting so the row never reads as a top-level destination. */
  nested?: boolean;
  /** WARP-1683 — live count for `item.badgeKey`; hidden at 0. */
  badge?: number;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`
        flex items-center gap-3 min-h-[44px] rounded-lg
        type-subheadline transition-all duration-200 ease-smooth
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
        ${nested ? "pl-8 pr-3" : "px-3"}
        ${
          active
            ? "bg-accent-subtle text-accent font-medium"
            : "text-label-secondary hover:bg-surface-secondary hover:text-label-primary"
        }
      `}
    >
      <Icon size={18} strokeWidth={active ? 2 : 1.5} />
      {item.label}
      <NavBadge count={badge} />
    </Link>
  );
}

/**
 * WARP-1683 — unread-count pill for badge-carrying nav items. Deliberately
 * static (no pulse/entrance motion): a persistent count is ambient status,
 * not an event — the number simply updates when the poll does. Hidden at 0
 * so the nav stays quiet by default; capped at 99+ so the row never
 * stretches. The numeral is aria-hidden (an aria-label on a generic span is
 * ignored by SRs); the adjacent sr-only text carries the meaning.
 * Exported for the a11y-markup pin (Sidebar.nav-badge.test.tsx).
 */
export function NavBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className="
          ml-auto min-w-[20px] px-1.5 py-0.5 rounded-full text-center
          type-caption-2 font-semibold tabular-nums
          bg-accent-subtle text-accent
        "
      >
        {count > 99 ? "99+" : count}
      </span>
      <span className="sr-only">{`${count} unread`}</span>
    </>
  );
}

/* ─────────────────────── Nav link sub-component ──────────────────────── */

function NavLink({
  item,
  active,
  showChildren,
  pathname,
  badge = 0,
}: {
  item: NavItem;
  active: boolean;
  /** Reveal the nested `item.children` sub-nav (we're inside this section). */
  showChildren?: boolean;
  pathname: string;
  /** WARP-1683 — live count for `item.badgeKey`; hidden at 0. */
  badge?: number;
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
        <NavBadge count={badge} />
      </Link>

      {showChildren && item.children && (
        <div className="ml-7 mt-1 space-y-0.5">
          {/* WARP-1548 — the Files section's children are the places rail's
              Quick group; the Libraries group is appended below them. Only
              Files has one: it is the single surface where "which library"
              is a question, and the component renders nothing on a Home
              install (ADR-029 §5, Home mode pixel-identical).

              This is the DESKTOP mount, inside a `hidden lg:flex` aside. The
              mobile drawer's Files caption group carries the same rail (see
              the `entry.captionOnly` branch above) — the addendum's §2.2 asks
              for both, and only both.

              Suspense, and scoped to just this: `useSearchParams` must be read
              under a boundary (see `app/admin/audit/page.tsx`), and the Sidebar
              renders on every route — putting the boundary here keeps that
              requirement out of the global shell. `fallback={null}` because the
              rail is additive: nothing renders until the space list resolves,
              and a skeleton in a nav would be noise. */}
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
          {item.href === "/files" && (
            <Suspense fallback={null}>
              <FilesLibrariesNav pathname={pathname} />
            </Suspense>
          )}
        </div>
      )}
    </div>
  );
}
