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
 * ── Every width, one component ─────────────────────────────────────────────
 *
 * The addendum's §2.2 is explicit that the rail supersedes the switcher "at
 * every width — desktop via the sidebar's Files section, below 900px via the
 * mobile drawer's Files section". So this mounts twice: inside the desktop
 * `<aside>`'s Files sub-nav, and inside the mobile "More" drawer's Files
 * caption group (WARP-1554 already renders that section's children there).
 * `variant` is the only difference — the drawer is a touch surface and owes
 * 44px rows, the sidebar is a pointer surface and matches its sibling
 * sub-nav's 32px. Shipping desktop-only would leave exactly the customer this
 * ticket exists for — a practice with four-plus libraries on a phone — still
 * looking at "Spaces ▾".
 *
 * ── What this deliberately is NOT ──────────────────────────────────────────
 *
 * A second rail. It renders inside the existing Files section, which already
 * reveals its children on any `/files/*` route. Two rails side by side would
 * add ~210px of permanent horizontal chrome to a surface whose entire problem
 * is chrome (packet §0.2).
 *
 * ── Home mode ──────────────────────────────────────────────────────────────
 *
 * ADR-029 §5 ("UI surfaces … Home mode pixel-identical", line 255) is binding:
 * a single-space Home install must render exactly as it does today. The gate
 * is `hasSpaceControl()` from `lib/space-rows` — the same threshold the switcher
 * and the Files page key off, so the three can never disagree about what "there is
 * nothing to switch between" means. Below two visible spaces this renders nothing at
 * all: no caption, no group, no teaser.
 *
 * ── Colour ─────────────────────────────────────────────────────────────────
 *
 * Every colour is a `.files-rail-*` class in `globals.css`, none inline. The
 * sidebar renders ABOVE every page scope (`AuthGate`, WARP-1079), so the
 * `.droplet-shell` ramp — `--text`, `--text-muted`, `--brand`, `--border` —
 * does not resolve here at all; an inline `var(--text-muted)` on a sidebar row
 * is a dropped declaration, not a colour. The rail's rules key off the
 * `:root`/`.dark` contract tokens instead, which are in scope everywhere, and
 * the state captions use the AA-safe `-text` variants (WARP-633 / WARP-1475)
 * rather than the vivid fills. Measured in `__tests__/files-rail.contrast.test.ts`.
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
import { buildFilesUrl, spaceRenderName } from "@/lib/space-attribution";
import { hasSpaceControl, rightLabel, visibleSpaces } from "@/lib/space-rows";
import type { FileSpace, FileSpaceId } from "@/lib/types";

/** Glyph by kind. Personal and household keep the switcher's mapping so a
 *  library does not change icon depending on which control you look at. */
function iconFor(space: FileSpace): LucideIcon {
  if (space.kind === "department") return Building2;
  if (space.kind === "team") return Users;
  if (space.id === "personal") return FolderLock;
  return Users;
}

/** Rights are a neutral, text-first chip — never the `--role-*` ramp, which
 *  carries a known 3-way drift (departments packet §1, D-4). */
function RightChip({ right }: { right: string }) {
  return (
    <span className="files-rail-chip ml-auto shrink-0 rounded-full px-1.5 type-caption-2">
      {rightLabel(right)}
    </span>
  );
}

/** Where the rail is mounted. The two hosts have different tap-target and
 *  type contracts, and a row that ignores its host's is the mobile bug this
 *  component's own review caught. */
export type FilesLibrariesNavVariant = "sidebar" | "drawer";

interface Props {
  /** Current pathname, passed down so this never re-reads it. */
  pathname: string;
  /** Row density + type scale. Defaults to the desktop sidebar's sub-nav. */
  variant?: FilesLibrariesNavVariant;
  /**
   * Called when a library row is followed. The mobile drawer is a modal that
   * does not dismiss itself on navigation — every other row in it passes the
   * same callback (`DrawerLink`), and without it a tap would navigate behind
   * an open drawer.
   */
  onNavigate?: () => void;
}

export function FilesLibrariesNav({
  pathname,
  variant = "sidebar",
  onNavigate,
}: Props) {
  const { spaces } = useSpaces();
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const isOwnerOrAdmin = user?.role === "owner" || user?.role === "admin";

  // The active library is the `?space=` on /files; its absence means personal.
  // Read from the URL rather than tracked here so a deep link, a back button
  // and a rail click all agree — the same reason WARP-1547 made (space, path)
  // addressable in the first place.
  //
  // `||`, not `??`: `/files?space=` yields the empty string, which is a param
  // that is present and says nothing. `app/files/page.tsx` reads it with a
  // truthy check and falls back to the personal space, so `??` here would
  // leave the page showing My Files while the rail highlighted nothing.
  const activeSpace: FileSpaceId | null =
    pathname === "/files" ? searchParams?.get("space") || "personal" : null;

  // One pass over the space list per render: the visibility filter feeds BOTH
  // the rows and the Home-mode gate below, and the rail re-renders on every
  // /files/* route change.
  const { visible, ordered, orphans } = useMemo(() => {
    const visible = visibleSpaces(spaces, isOwnerOrAdmin);

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
    // (`orphanTeams` in `SpaceSwitcher.tsx`), kept because a library you can
    // open but cannot see is worse than an oddly-placed row.
    const claimed = new Set(departments.map((d) => d.name));
    const orphanTeams = teams
      .filter((t) => !claimed.has(t.parentName ?? ""))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { visible, ordered: rows, orphans: orphanTeams };
  }, [spaces, isOwnerOrAdmin]);

  // Home mode: nothing to switch between means no control at all. Same
  // threshold as `spaceSwitcherVisible`, asked of the list already filtered
  // above rather than filtering a second time.
  if (!hasSpaceControl(visible)) return null;

  const drawer = variant === "drawer";
  const iconSize = drawer ? 18 : 14;

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
          size={iconSize}
          strokeWidth={active ? 2 : 1.5}
          aria-hidden="true"
          className="shrink-0"
        />
        <span className="truncate">{label}</span>
        {provisioning && (
          <span className="files-rail-state-provisioning ml-auto flex shrink-0 items-center gap-1 type-caption-2">
            <Loader2
              size={11}
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
            Setting up…
          </span>
        )}
        {failed && (
          <span className="files-rail-state-failed ml-auto flex shrink-0 items-center gap-1 type-caption-2">
            <AlertTriangle size={11} aria-hidden="true" />
            Needs attention
          </span>
        )}
        {!disabled && space.right && <RightChip right={space.right} />}
      </>
    );

    // 44px rows in the drawer, matching its `DrawerLink` siblings — a touch
    // surface, so the tap target is the contract. 32px in the sidebar, where
    // the sibling sub-nav links are 32px and the pointer is the input.
    const shared = drawer
      ? `flex items-center gap-3 min-h-[44px] rounded-lg type-subheadline ${
          nested ? "pl-8 pr-3" : "px-3"
        }`
      : `flex items-center gap-2 h-8 rounded-md type-footnote ${
          nested ? "pl-6 pr-2" : "px-2"
        }`;

    // A provisioning or failed library is not browsable (fail-closed), so it is
    // rendered as a non-link rather than a link that would 404 or 403. The row
    // still appears, with its reason — never silent absence.
    if (disabled) {
      return (
        <div
          key={space.id}
          className={`files-rail-row ${shared} cursor-default`}
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
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={`files-rail-row ${shared} transition-colors duration-200 ease-smooth`}
      >
        {body}
      </Link>
    );
  };

  return (
    <nav aria-label="Libraries" className="mt-2">
      <div
        className={`files-rail-caption type-caption-2 uppercase tracking-wider pb-1 ${
          drawer ? "px-3 pt-2" : "px-2"
        }`}
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
