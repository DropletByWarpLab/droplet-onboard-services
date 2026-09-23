"use client";

/**
 * WorkspaceShell — the "Workspace tabs" navigation layout (WARP-2971).
 *
 * The 2026-09-19 handoff's three-level shell, rendered by `AuthGate` in place
 * of `<Sidebar/> + <main>` when the person's nav layout is `workspace`
 * (`lib/nav-layout.tsx`). Rows, top to bottom:
 *
 *   header       mark · greeting · (spring) · live health · person · sign out
 *   spaces       Level 1 — a tablist of the resolved spaces (desktop)
 *   destinations Level 2 — chips for the active space's routes
 *   views        Level 3 — pills, only for a destination with routed children
 *   main         the page, unchanged
 *   status strip health · box address · version · shortcut legend (desktop)
 *   bottom bar   the spaces again, as the phone's tab bar (< lg)
 *
 * What it deliberately does NOT do:
 *   · fetch anything the Sidebar does not — the same five hooks, so both
 *     layouts see the same gates and the same badge, and switching layouts
 *     cannot change what a person can reach;
 *   · store the active space — it is derived from the pathname every render
 *     (`locate`), so a deep link and a refresh land on the right tab for free;
 *   · render a search field or a notification bell. The handoff's search
 *     "opens the existing command palette" and there is none yet (WARP-523),
 *     and there is no unread source for a bell (WARP-2892). A control that
 *     does nothing is worse than no control; both are follow-ups.
 *
 * Styling: `workspace-nav.css`, scoped under `.droplet-workspace`, which
 * carries the same indigo token ramp as `.droplet-shell` (indigo-tokens.css)
 * — every colour, radius and easing here is that ramp, never a literal.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import { LogOut } from "lucide-react";

import { DropletMark } from "@/components/DropletMark";
import { NavBadge } from "@/components/Sidebar";
import { isMedicalConnector } from "@/components/integrations/provider-descriptors";
import { resolveHealthCopy } from "@/app/health-copy";
import { fetchSystemHealth, type SystemHealth } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBoxAddress } from "@/lib/hooks/useBoxAddress";
import { useCapabilities } from "@/lib/hooks/useCapabilities";
import { useIntegrations } from "@/lib/hooks/useIntegrations";
import { useModuleGate } from "@/lib/hooks/useModuleGate";
import { useTeamChatUnread } from "@/lib/hooks/useTeamChat";
import type { AuthRole, NavItem } from "@/components/nav-config";
// WARP-2976 (ADR-059 §2.3) — the same switcher and the same department
// filter as the sidebar. Here the filter is `resolveSpaces`' `restrictTo`,
// applied alongside (never instead of) the gates it already runs.
import { DepartmentSwitcher } from "@/components/Departments/DepartmentSwitcher";
import { useActiveDepartment } from "@/lib/departments/active-department";
import {
  departmentHomeHref,
  departmentRestrictSet,
} from "@/lib/departments/department-nav";
import {
  locate,
  resolveSpaces,
  type Space,
  type SpaceId,
} from "./workspace-nav-config";

import { VERSION_LABEL } from "@/lib/brand";
import "@/components/shell/indigo-tokens.css";
import "./workspace-nav.css";

/** Same buckets as the Home board's `greetingNow` — one voice on both shells. */
function greetingNow(): string {
  const hr = new Date().getHours();
  if (hr < 5) return "Still up";
  if (hr < 12) return "Good morning";
  if (hr < 18) return "Good afternoon";
  if (hr < 22) return "Good evening";
  return "Working late";
}

/**
 * Roving focus for one horizontal row of tabs/chips/pills (WAI-ARIA tabs
 * pattern, manual activation): arrows move focus, Home/End jump, Enter/Space
 * act on the focused control. Activation is the control's own click, so a
 * chip that is a real link keeps its link semantics.
 */
function rovingKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
  const row = e.currentTarget;
  const focusables = Array.from(
    row.querySelectorAll<HTMLElement>("[data-roving]"),
  );
  const i = focusables.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  let next = -1;
  if (e.key === "ArrowRight") next = (i + 1) % focusables.length;
  else if (e.key === "ArrowLeft")
    next = (i - 1 + focusables.length) % focusables.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = focusables.length - 1;
  if (next < 0) return;
  e.preventDefault();
  focusables[next].focus();
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();

  // ── the same gates the Sidebar resolves, so nothing is reachable here that
  //    the rail would hide (or vice versa) ────────────────────────────────
  const adminCapabilities = useCapabilities();
  const isModuleOn = useModuleGate();
  const role = user?.role as AuthRole | undefined;
  const { connected } = useIntegrations(role === "owner" || role === "admin");
  const medicalConnector = connected.some((e) => isMedicalConnector(e.meta.id));
  const teamChatUnread = useTeamChatUnread();
  const badgeCounts: Record<NonNullable<NavItem["badgeKey"]>, number> = {
    teamChatUnread,
  };

  // WARP-2976 — null for Whole business (and for a department that is not
  // set up), which leaves resolveSpaces exactly as it was.
  const { active: activeDepartment, activeProfile } = useActiveDepartment();
  const restrictTo = useMemo(
    () => (activeDepartment ? departmentRestrictSet(activeProfile) : null),
    [activeDepartment, activeProfile],
  );

  const spaces = useMemo(
    () =>
      resolveSpaces(
        role,
        { ...adminCapabilities, medicalConnector },
        isModuleOn,
        restrictTo ?? undefined,
      ),
    [role, adminCapabilities, medicalConnector, isModuleOn, restrictTo],
  );
  // Inside a set-up department the mark leads to its home, the page the
  // restricted chips hang off; otherwise to Overview, as it always has.
  const markHref =
    activeDepartment && restrictTo ? departmentHomeHref(activeDepartment.slug) : "/";
  const markLabel =
    activeDepartment && restrictTo
      ? `Droplet — ${activeDepartment.name} home`
      : "Droplet — Overview";

  // Derived every render. A route no chip leads to (e.g. /clips) keeps the
  // last space's chips on screen instead of an empty row, so the person can
  // still walk away; the first space is the cold-start fallback.
  const location = useMemo(() => locate(spaces, pathname), [spaces, pathname]);
  const lastSpaceId = useRef<SpaceId | null>(null);
  if (location) lastSpaceId.current = location.space.def.id;
  const currentSpace: Space | undefined =
    location?.space ??
    spaces.find((s) => s.def.id === lastSpaceId.current) ??
    spaces[0];

  const badgeFor = (item: NavItem) =>
    item.badgeKey ? badgeCounts[item.badgeKey] : 0;
  const spaceHasAttention = (space: Space) =>
    space.destinations.some((d) => badgeFor(d.item) > 0);

  // Space click → that space's FIRST destination (handoff: "set space, select
  // that space's first destination, reset view").
  const goToSpace = useCallback(
    (space: Space) => {
      const first = space.destinations[0];
      if (first) router.push(first.item.href);
    },
    [router],
  );

  // ⌥1–⌥6 jump to a space. Alt rather than Cmd/Ctrl so nothing collides with
  // the browser's own tab shortcuts; skipped while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isTypingTarget(e.target)) return;
      const n = Number(e.code.replace("Digit", ""));
      if (!Number.isInteger(n) || n < 1 || n > spaces.length) return;
      e.preventDefault();
      goToSpace(spaces[n - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spaces, goToSpace]);

  // ── header data ────────────────────────────────────────────────────────
  const firstName = useMemo(() => {
    const raw = user?.displayName || user?.username || "";
    return raw.split(/[\s@.]/)[0] || "";
  }, [user]);
  const initials = user?.displayName
    ? user.displayName
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : (user?.username?.slice(0, 2).toUpperCase() ?? "?");
  // Computed once per mount, like the Home board's — the greeting is a
  // salutation, not a clock, and a re-render per minute buys nothing.
  const [greeting] = useState(greetingNow);
  const [dateStr] = useState(() =>
    new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
  );
  const host = useBoxAddress();
  const { data: systemHealth } = useSWR<SystemHealth>(
    "/api/orchestrator/health",
    fetchSystemHealth,
    { refreshInterval: 15_000 },
  );
  const healthStatus = systemHealth?.status ?? "unknown";
  const healthCopy = resolveHealthCopy(healthStatus);

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  const activeSpaceId = currentSpace?.def.id;
  const activeHref = location?.destination.item.href;
  const views = location?.destination.views ?? [];
  const activeViewHref = location?.view?.href;

  return (
    <div className="droplet-workspace" data-nav-layout="workspace">
      <div className="ws-chrome">
        <header className="ws-head">
          <Link href={markHref} className="ws-mark" aria-label={markLabel}>
            <DropletMark size={22} />
          </Link>
          {/* WARP-2976 — left of the header, before the tabs (ADR-059 §2.3).
              Renders nothing below two choices. */}
          <DepartmentSwitcher variant="header" />
          <div className="ws-greet">
            <span className="g">
              {greeting}
              {firstName && <b>, {firstName}</b>}
            </span>
            <span className="d">
              {host} · {dateStr.toLowerCase()}
            </span>
          </div>
          <span className="ws-spring" />
          <span className={"ws-status is-" + healthStatus}>
            <span className="dot" aria-hidden="true" />
            <span className="lbl">{healthCopy.label}</span>
          </span>
          {user && (
            <span className="ws-user" title={user.username}>
              <span className="ws-avatar" aria-hidden="true">
                {initials}
              </span>
              <span className="ws-user-name">
                {user.displayName || user.username}
              </span>
            </span>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="ws-icon-btn"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut size={15} aria-hidden="true" />
          </button>
        </header>

        {/* Level 1 — desktop. Buttons, not links: a space is not a route, it
            is a choice that resolves to its first route. */}
        <div
          role="tablist"
          aria-label="Spaces"
          className="ws-spaces"
          onKeyDown={rovingKeyDown}
        >
          {spaces.map((space) => {
            const active = space.def.id === activeSpaceId;
            return (
              <button
                key={space.def.id}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                data-roving
                className={"ws-space" + (active ? " is-active" : "")}
                onClick={() => goToSpace(space)}
              >
                {space.def.label}
                {spaceHasAttention(space) && (
                  <span className="ws-attn" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>

        {/* Level 2. Real links with aria-current: a chip IS a route, and a
            link keeps open-in-new-tab, copy-address and SR "link" semantics
            the handoff's role=tab would take away. Arrow keys still rove. */}
        <nav aria-label="Destinations" className="ws-chips" onKeyDown={rovingKeyDown}>
          {currentSpace?.destinations.map((d) => {
            const active = d.item.href === activeHref;
            return (
              <Link
                key={d.item.href}
                href={d.item.href}
                aria-current={active ? "page" : undefined}
                tabIndex={active || !activeHref ? 0 : -1}
                data-roving
                className={"ws-chip" + (active ? " is-active" : "")}
              >
                {d.item.label}
                <NavBadge count={badgeFor(d.item)} />
              </Link>
            );
          })}
        </nav>
      </div>

      <main id="main" tabIndex={-1} className="ws-main">
        {views.length > 0 && (
          <nav aria-label="Views" className="ws-views" onKeyDown={rovingKeyDown}>
            <div className="ws-views-inner">
              {views.map((v) => {
                const active = v.href === activeViewHref;
                return (
                  <Link
                    key={v.href}
                    href={v.href}
                    aria-current={active ? "page" : undefined}
                    tabIndex={active || !activeViewHref ? 0 : -1}
                    data-roving
                    className={"ws-view" + (active ? " is-active" : "")}
                  >
                    {v.label}
                  </Link>
                );
              })}
            </div>
          </nav>
        )}
        {children}
      </main>

      <footer className="ws-strip" aria-label="Status">
        <span className={"ws-strip-health is-" + healthStatus}>
          <span className="dot" aria-hidden="true" />
          {healthCopy.label}
        </span>
        <span className="ws-strip-meta">{host}</span>
        <span className="ws-strip-meta">{VERSION_LABEL}</span>
        <span className="ws-spring" />
        <span className="ws-strip-keys" aria-hidden="true">
          ⌥1–{spaces.length} spaces
        </span>
      </footer>

      {/* Level 1 — phone. The existing bottom-bar pattern (56px + safe area),
          one slot per space. */}
      <nav aria-label="Spaces" className="ws-bottom">
        {spaces.map((space) => {
          const Icon = space.def.icon;
          const active = space.def.id === activeSpaceId;
          return (
            <button
              key={space.def.id}
              type="button"
              aria-current={active ? "true" : undefined}
              className={"ws-bottom-item" + (active ? " is-active" : "")}
              onClick={() => goToSpace(space)}
            >
              <Icon size={20} strokeWidth={active ? 2 : 1.5} aria-hidden="true" />
              <span>{space.def.label}</span>
              {spaceHasAttention(space) && (
                <span className="ws-attn" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
