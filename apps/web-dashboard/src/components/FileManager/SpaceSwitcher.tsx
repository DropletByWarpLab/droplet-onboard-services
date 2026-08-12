"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Building2,
  ChevronDown,
  Eye,
  FolderLock,
  KeyRound,
  Loader2,
  Pencil,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { FileSpace, FileSpaceId } from "@/lib/types";
// WARP-1808 — display-only "Workspace" mapping for the household space, used
// at RENDER SITES ONLY. Grouping and parent lookups below (`teamsByParent`,
// `claimedParentNames`) keep keying off RAW server names — the data contract.
import { spaceRenderName } from "@/lib/space-attribution";

interface SpaceSwitcherProps {
  spaces: FileSpace[];
  active: FileSpaceId;
  onChange: (space: FileSpaceId) => void;
  /**
   * WARP-1267 — true for owner/admin viewers. Admins see every department
   * and team library loudly (design brief §0.3): a `failed` row renders
   * "Needs attention" for them, but must never reach a plain member — the
   * server should already omit non-active rows for members; this is the
   * client-side defense-in-depth filter on top of that.
   */
  isOwnerOrAdmin?: boolean;
}

const SPACE_ICON: Record<FileSpaceId, LucideIcon> = {
  personal: FolderLock,
  shared: Users,
};

/** Departments/teams get their kind glyph; anything else falls back to the
 *  per-id map, and finally the group glyph for unrecognized future kinds. */
function iconForSpace(space: FileSpace): LucideIcon {
  if (space.kind === "department") return Building2;
  if (space.kind === "team") return Users;
  return SPACE_ICON[space.id] ?? Users;
}

const RIGHT_ICON: Record<string, LucideIcon> = {
  reader: Eye,
  contributor: Pencil,
  manager: KeyRound,
};

const RIGHT_LABEL: Record<string, string> = {
  reader: "Reader",
  contributor: "Contributor",
  manager: "Manager",
};

/**
 * Rights are a neutral, text-first chip (design brief §1) — never the
 * `--role-*` ramp. Right glyphs render in the tertiary label color, never a
 * status color.
 */
function RightChip({ right }: { right: string }) {
  const Icon = RIGHT_ICON[right];
  const label = RIGHT_LABEL[right] ?? right;
  return (
    <span className="inline-flex items-center gap-1.5 h-5 px-2 rounded-full border border-separator bg-surface-tertiary type-caption-1 text-label-secondary flex-none">
      {Icon && (
        <Icon size={11} aria-hidden="true" className="text-label-tertiary" />
      )}
      {label}
    </span>
  );
}

const PINNED_IDS = new Set<FileSpaceId>(["personal", "shared"]);

/** A space with no state (personal) or an explicit "active" state. */
function isActiveState(space: FileSpace): boolean {
  return !space.state || space.state === "active";
}

/**
 * WARP-1267 — which non-active rows this viewer may see. Provisioning rows
 * are visible to whoever the server already scoped the row to (a member
 * with a right, or an admin); failed rows are owner/admin-only — loud
 * see-all, never silent absence, but never leaked to a plain member either
 * (brief §2). Mirrors the server-side filter; kept here as defense in depth.
 */
function isVisibleNonActive(space: FileSpace, isOwnerOrAdmin: boolean): boolean {
  if (space.state === "provisioning") return true;
  if (space.state === "failed") return isOwnerOrAdmin;
  return false;
}

/**
 * WARP-1910 — whether the switcher renders at all for this viewer: at least
 * two visible spaces (active ones, plus the provisioning/failed rows this
 * viewer may see). Exported because the Files page keys off it too — the
 * breadcrumb bar's lone root crumb is suppressed only while the switcher is
 * actually on screen. Single source of truth: the component's own
 * nothing-to-switch-between early return uses this same predicate.
 */
export function spaceSwitcherVisible(
  spaces: FileSpace[],
  isOwnerOrAdmin = false
): boolean {
  const visible = spaces.filter(
    (s) => isActiveState(s) || isVisibleNonActive(s, isOwnerOrAdmin)
  );
  return visible.length >= 2;
}

/**
 * WARP-883 (ADR-027 WS-5) — segmented control to switch between the user's
 * private "My Files" space and other spaces (shared Household, and — as of
 * WARP-1267 — N departments/teams with one level of nesting).
 *
 * ≤3 visible spaces: the shipped segmented tablist, untouched. >3 (or any
 * provisioning/failed row present): the third segment collapses to a
 * "Spaces" menu grouping departments with their teams indented beneath,
 * a right-aligned rights chip per row, and honest state chips instead of
 * silent absence for rows still provisioning or needing attention.
 */
export function SpaceSwitcher({
  spaces,
  active,
  onChange,
  isOwnerOrAdmin = false,
}: SpaceSwitcherProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const activeVisible = spaces.filter(isActiveState);
  const nonActiveVisible = spaces.filter(
    (s) => !isActiveState(s) && isVisibleNonActive(s, isOwnerOrAdmin)
  );

  // Light dismiss + Esc on the Spaces menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Nothing to switch between → don't show a lone control. Same predicate
  // the Files page uses to decide the root breadcrumb's fate (WARP-1910).
  if (!spaceSwitcherVisible(spaces, isOwnerOrAdmin)) return null;

  // ── ≤3 spaces, all active: the shipped segmented tablist, untouched. ──
  const useMenu = activeVisible.length > 3 || nonActiveVisible.length > 0;
  if (!useMenu) {
    return (
      <div role="tablist" aria-label="File space" className="pills">
        {activeVisible.map((space) => {
          const Icon = iconForSpace(space);
          const isActive = space.id === active;
          return (
            <button
              key={space.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(space.id)}
              className={isActive ? "active" : undefined}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                whiteSpace: "nowrap",
              }}
            >
              <Icon size={14} aria-hidden="true" />
              {spaceRenderName(space)}
            </button>
          );
        })}
      </div>
    );
  }

  // ── >3 spaces (or a provisioning/failed row present): My Files + Household
  // stay pinned segments; every department/team space collapses into the
  // Spaces menu (design brief §2). ──
  const pinned = activeVisible.filter((s) => PINNED_IDS.has(s.id));
  const menuActive = activeVisible.filter((s) => !PINNED_IDS.has(s.id));
  const menuItems = [...menuActive, ...nonActiveVisible];

  const activeSpace = spaces.find((s) => s.id === active);
  const activeIsInMenu = !!activeSpace && !PINNED_IDS.has(activeSpace.id);
  const triggerLabel =
    activeIsInMenu && activeSpace ? spaceRenderName(activeSpace) : "Spaces";

  const departments = menuItems.filter((s) => s.kind === "department");
  const teams = menuItems.filter((s) => s.kind === "team");
  const teamsByParent = new Map<string, FileSpace[]>();
  for (const team of teams) {
    const key = team.parentName ?? "";
    if (!teamsByParent.has(key)) teamsByParent.set(key, []);
    teamsByParent.get(key)!.push(team);
  }
  // Teams whose parent department isn't itself in the menu (shouldn't
  // normally happen, but render them rather than silently dropping them).
  const claimedParentNames = new Set(departments.map((d) => d.name));
  const orphanTeams = teams.filter((t) => !claimedParentNames.has(t.parentName ?? ""));

  const renderRow = (space: FileSpace, indent: boolean) => {
    const Icon = iconForSpace(space);
    const isActive = space.id === active;
    const isProvisioning = space.state === "provisioning";
    const isFailed = space.state === "failed";
    const disabled = isProvisioning || isFailed;

    return (
      <button
        key={space.id}
        type="button"
        role="menuitem"
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled) return;
          onChange(space.id);
          setMenuOpen(false);
        }}
        className={`flex items-center gap-2.5 w-full text-left px-2.5 py-2 rounded-md type-footnote transition-colors ${
          indent ? "pl-7" : ""
        } ${
          disabled
            ? "text-label-tertiary cursor-default"
            : isActive
            ? "bg-accent-subtle text-accent font-medium"
            : "text-label-primary hover:bg-accent-subtle"
        }`}
      >
        <Icon
          size={14}
          aria-hidden="true"
          className="flex-none text-label-secondary"
        />
        <span className="flex-1 min-w-0 truncate">{spaceRenderName(space)}</span>
        {isProvisioning && (
          <span className="inline-flex items-center gap-1.5 type-caption-1 text-system-orange flex-none">
            <Loader2
              size={12}
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
            Setting up…
          </span>
        )}
        {isFailed && (
          <span className="inline-flex items-center gap-1.5 type-caption-1 text-system-red flex-none">
            <AlertTriangle size={12} aria-hidden="true" />
            Needs attention
          </span>
        )}
        {!disabled && space.right && <RightChip right={space.right} />}
      </button>
    );
  };

  return (
    <div role="tablist" aria-label="File space" className="pills" ref={rootRef}>
      {pinned.map((space) => {
        const Icon = iconForSpace(space);
        const isActive = space.id === active;
        return (
          <button
            key={space.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(space.id)}
            className={isActive ? "active" : undefined}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
            }}
          >
            <Icon size={14} aria-hidden="true" />
            {spaceRenderName(space)}
          </button>
        );
      })}

      <div className="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          className={activeIsInMenu ? "active" : undefined}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            whiteSpace: "nowrap",
          }}
        >
          <Building2 size={14} aria-hidden="true" />
          <span className="max-w-[9rem] truncate">{triggerLabel}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>

        {menuOpen && (
          <div
            role="menu"
            aria-label="Spaces"
            className="absolute left-0 top-[calc(100%+6px)] z-30 w-80 max-w-[85vw] p-1.5 bg-surface-elevated border border-separator rounded-lg shadow-lg"
          >
            <div className="px-2 pt-1.5 pb-1 type-caption-1 uppercase tracking-wider text-label-tertiary">
              Departments
            </div>
            {departments.length === 0 && orphanTeams.length === 0 ? (
              <div className="px-2.5 py-3 type-footnote text-label-tertiary">
                No department libraries yet.
              </div>
            ) : (
              departments.map((dept) => {
                const kids = teamsByParent.get(dept.name) ?? [];
                return (
                  <div key={dept.id}>
                    {renderRow(dept, false)}
                    {kids.length > 0 && (
                      <div className="ml-[19px] border-l border-separator">
                        {kids.map((team) => renderRow(team, true))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
            {orphanTeams.map((team) => renderRow(team, false))}
          </div>
        )}
      </div>
    </div>
  );
}
