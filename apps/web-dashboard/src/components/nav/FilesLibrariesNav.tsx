"use client";

/**
 * WARP-1548 — the Libraries group of the Files places rail.
 *
 * Design packet §2.2 (`shared_brain content/brand/handoffs/files/`, pinned in
 * `docs/design/files-surface-addendum.md`). Every department and team the
 * viewer can see, **always visible**, with its teams nested one level beneath
 * it.
 *
 * This replaces the `SpaceSwitcher`'s overflow behaviour, which is the thing
 * the packet supersedes: past three spaces that control keeps My Files and
 * Household as pills and collapses every department and team into a
 * "Spaces ▾" menu. A practice crosses three spaces on its first day — Front
 * Desk, Clinical, Billing is already four with Workspace — so the menu branch
 * is not an overflow case, it is *the* case, and the structure that organises
 * the whole business becomes the least visible thing on screen.
 *
 * ── What this deliberately is NOT ──────────────────────────────────────────
 *
 * A second rail. It renders inside the existing Sidebar Files section, which
 * already reveals its children on any `/files/*` route. Two rails side by side
 * would add ~210px of permanent horizontal chrome to a surface whose entire
 * problem is chrome (packet §0.2).
 *
 * ── Home mode ──────────────────────────────────────────────────────────────
 *
 * ADR-029 §5 ("UI surfaces … Home mode pixel-identical", line 255) is binding:
 * a single-space Home install must render exactly as it does today. The gate is
 * `spaceSwitcherVisible()` — the same predicate the switcher and the Files page
 * already key off, reused rather than reimplemented so the two can never
 * disagree about what "there is nothing to switch between" means. Below two
 * visible spaces this renders nothing at all: no caption, no group, no teaser.
 *
 * ── Accessibility ──────────────────────────────────────────────────────────
 *
 * `role="navigation"`, not the switcher's `tablist`, and not `tree`. Each
 * library is a distinct URL with its own history entry (WARP-1547 made
 * `(space, path)` addressable), which is a navigation contract; `tree` would
 * promise expand/collapse over a hierarchy ADR-029 caps at exactly one level.
 * The decision and its divergence from the Network-tabs precedent are recorded
 * in `docs/design/files-surface-addendum.md` §2.1.
 */

import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Building2,
  FolderLock,
  Loader2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useSpaces } from "@/lib/hooks/useSpaces";
import { useAuth } from "@/lib/auth";
import { spaceSwitcherVisible } from "@/components/FileManager/SpaceSwitcher";
import { buildFilesUrl, spaceRenderName } from "@/lib/space-attribution";
import type { FileSpace, FileSpaceId } from "@/lib/types";

/** Glyph by kind. Personal and household keep the switcher's mapping so a
 *  library does not change icon depending on which control you look at. */
function iconFor(space: FileSpace): LucideIcon {
  if (space.kind === "department") return Building2;
  if (space.kind === "team") return Users;
  if (space.id === "personal") return FolderLock;
  return Users;
}

const RIGHT_LABEL: Record<string, string> = {
  reader: "Reader",
  contributor: "Contributor",
  manager: "Manager",
};

function isActiveState(space: FileSpace): boolean {
  return !space.state || space.state === "active";
}

/**
 * Mirrors `SpaceSwitcher.isVisibleNonActive`: a provisioning row is visible to
 * whoever the server already scoped it to; a failed row is owner/admin-only —
 * loud see-all, never silent absence, but never leaked to a plain member.
 */
function isVisibleNonActive(space: FileSpace, isOwnerOrAdmin: boolean): boolean {
  if (space.state === "provisioning") return true;
  if (space.state === "failed") return isOwnerOrAdmin;
  return false;
}

/** Rights are a neutral, text-first chip — never the `--role-*` ramp, which
 *  carries a known 3-way drift (departments packet §1, D-4). */
function RightChip({ right }: { right: string }) {
  return (
    <span
      className="ml-auto shrink-0 rounded-full px-1.5 type-caption-2"
      style={{
        border: "1px solid var(--border)",
        background: "var(--surface)",
        color: "var(--text-faint)",
      }}
    >
      {RIGHT_LABEL[right] ?? right}
    </span>
  );
}

interface Props {
  /** Current pathname, passed down so this never re-reads it. */
  pathname: string;
}

export function FilesLibrariesNav({ pathname }: Props) {
  const { spaces } = useSpaces();
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const isOwnerOrAdmin = user?.role === "owner" || user?.role === "admin";

  // The active library is the `?space=` on /files; its absence means personal.
  // Read from the URL rather than tracked here so a deep link, a back button
  // and a rail click all agree — the same reason WARP-1547 made (space, path)
  // addressable in the first place.
  const activeSpace: FileSpaceId | null =
    pathname === "/files" ? (searchParams?.get("space") ?? "personal") : null;

  const { ordered, orphans } = useMemo(() => {
    const visible = spaces.filter(
      (s) => isActiveState(s) || isVisibleNonActive(s, isOwnerOrAdmin)
    );

    const pinned = visible.filter((s) => s.id === "personal" || s.id === "shared");
    const departments = visible
      .filter((s) => s.kind === "department")
      .sort((a, b) => a.name.localeCompare(b.name));
    const teams = visible.filter((s) => s.kind === "team");

    const byParent = new Map<string, FileSpace[]>();
    for (const team of teams) {
      const key = team.parentName ?? "";
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(team);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Depth-first: department, then its teams. One level only (ADR-029
    // Non-goals, line 329) — a team never has children of its own.
    const rows: Array<{ space: FileSpace; nested: boolean }> = [
      ...pinned.map((space) => ({ space, nested: false })),
    ];
    for (const dept of departments) {
      rows.push({ space: dept, nested: false });
      for (const team of byParent.get(dept.name) ?? []) {
        rows.push({ space: team, nested: true });
      }
    }

    // A team whose parent department isn't itself visible still renders rather
    // than being silently dropped — the switcher's orphan fallback
    // (`SpaceSwitcher.tsx:220`), kept because a library you can open but cannot
    // see is worse than an oddly-placed row.
    const claimed = new Set(departments.map((d) => d.name));
    const orphanTeams = teams
      .filter((t) => !claimed.has(t.parentName ?? ""))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { ordered: rows, orphans: orphanTeams };
  }, [spaces, isOwnerOrAdmin]);

  // Home mode: nothing to switch between means no control at all. Same
  // predicate as the switcher and the Files page — one source of truth.
  if (!spaceSwitcherVisible(spaces, isOwnerOrAdmin)) return null;

  const renderRow = (space: FileSpace, nested: boolean) => {
    const Icon = iconFor(space);
    const provisioning = space.state === "provisioning";
    const failed = space.state === "failed";
    const disabled = provisioning || failed;
    const active = !disabled && activeSpace === space.id;
    const label = spaceRenderName(space);

    const body = (
      <>
        <Icon
          size={14}
          strokeWidth={active ? 2 : 1.5}
          aria-hidden="true"
          className="shrink-0"
        />
        <span className="truncate">{label}</span>
        {provisioning && (
          <span
            className="ml-auto flex shrink-0 items-center gap-1 type-caption-2"
            style={{ color: "var(--color-system-orange)" }}
          >
            <Loader2
              size={11}
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
            Setting up…
          </span>
        )}
        {failed && (
          <span
            className="ml-auto flex shrink-0 items-center gap-1 type-caption-2"
            style={{ color: "var(--color-system-red)" }}
          >
            <AlertTriangle size={11} aria-hidden="true" />
            Needs attention
          </span>
        )}
        {!disabled && space.right && <RightChip right={space.right} />}
      </>
    );

    const shared = `flex items-center gap-2 h-8 rounded-md type-footnote transition-all duration-200 ease-smooth ${
      nested ? "pl-6 pr-2" : "px-2"
    }`;

    // A provisioning or failed library is not browsable (fail-closed), so it is
    // rendered as a non-link rather than a link that would 404 or 403. The row
    // still appears, with its reason — never silent absence.
    if (disabled) {
      return (
        <div
          key={space.id}
          className={`${shared} cursor-default`}
          style={{ color: "var(--text-faint)" }}
          aria-disabled="true"
        >
          {body}
        </div>
      );
    }

    return (
      <Link
        key={space.id}
        href={buildFilesUrl(space.id, "/")}
        aria-current={active ? "page" : undefined}
        className={`${shared} files-rail-row${active ? " is-active" : ""}`}
        style={{ color: active ? "var(--brand)" : "var(--text-muted)" }}
      >
        {body}
      </Link>
    );
  };

  return (
    <nav aria-label="Libraries" className="mt-2">
      <div
        className="px-2 pb-1 type-caption-2 uppercase tracking-wider"
        style={{ color: "var(--text-faint)" }}
      >
        Libraries
      </div>
      <div className="space-y-0.5">
        {ordered.map(({ space, nested }) => renderRow(space, nested))}
        {orphans.map((team) => renderRow(team, false))}
      </div>
    </nav>
  );
}
