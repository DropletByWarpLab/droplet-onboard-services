/**
 * WARP-1548 — the shared vocabulary for rendering the Files space list as
 * rows: which rows a viewer may see, whether there is anything to switch
 * between at all, and how a right is labelled.
 *
 * These lived in `components/FileManager/SpaceSwitcher.tsx` while that
 * component was the only thing that rendered a space list. The places rail
 * (`components/nav/FilesLibrariesNav.tsx`) renders the same list, so a copy
 * in each would let the row filter and the render gate drift apart —
 * precisely the failure the addendum's "absorb, do not discard" (§2.2) is
 * trying to avoid.
 *
 * A neutral `lib/` module rather than an export from either component: the
 * rail is an always-mounted piece of the global nav, and importing it from
 * `components/FileManager/` would pull the whole FileManager module graph
 * into every route's chrome. Nothing here is React, so both sides — and the
 * Files page — can take it without a dependency direction to argue about.
 */
import type { FileSpace } from "./types";

/** A space with no state (personal) or an explicit "active" state. */
export function isActiveState(space: FileSpace): boolean {
  return !space.state || space.state === "active";
}

/**
 * WARP-1267 — which non-active rows this viewer may see. Provisioning rows
 * are visible to whoever the server already scoped the row to (a member
 * with a right, or an admin); failed rows are owner/admin-only — loud
 * see-all, never silent absence, but never leaked to a plain member either
 * (departments brief §2). Mirrors the server-side filter; kept here as
 * defense in depth.
 */
export function isVisibleNonActive(
  space: FileSpace,
  isOwnerOrAdmin: boolean
): boolean {
  if (space.state === "provisioning") return true;
  if (space.state === "failed") return isOwnerOrAdmin;
  return false;
}

/**
 * The rows this viewer may see: active spaces, plus the provisioning/failed
 * rows `isVisibleNonActive` admits. Exported so a caller that needs both the
 * list AND the gate below can filter once — the rail renders on every
 * `/files/*` route change and had been paying for two passes.
 */
export function visibleSpaces(
  spaces: FileSpace[],
  isOwnerOrAdmin = false
): FileSpace[] {
  return spaces.filter(
    (s) => isActiveState(s) || isVisibleNonActive(s, isOwnerOrAdmin)
  );
}

/**
 * ADR-029 §5 ("Home mode pixel-identical", line 255) — below two visible
 * spaces there is nothing to switch between, so no location control renders
 * at all: not collapsed, not a teaser. The threshold lives here once, and
 * `spaceSwitcherVisible` is the same question asked of an unfiltered list.
 */
export function hasSpaceControl(visible: FileSpace[]): boolean {
  return visible.length >= 2;
}

/**
 * WARP-1910 — whether a space control renders at all for this viewer. The
 * `SpaceSwitcher`'s own early return, the Files page's breadcrumb-root
 * suppression and the places rail's Home-mode gate are all this one
 * predicate, so the three can never disagree about what "nothing to switch
 * between" means.
 */
export function spaceSwitcherVisible(
  spaces: FileSpace[],
  isOwnerOrAdmin = false
): boolean {
  return hasSpaceControl(visibleSpaces(spaces, isOwnerOrAdmin));
}

/**
 * The neutral, text-first label for an effective right (departments brief
 * §1, D-4). An unrecognized future right falls through to its raw wire value
 * rather than vanishing — a chip that says `curator` is honest; a missing
 * chip claims the viewer has no right at all.
 */
export function rightLabel(right: string): string {
  return RIGHT_LABEL[right] ?? right;
}

const RIGHT_LABEL: Record<string, string> = {
  reader: "Reader",
  contributor: "Contributor",
  manager: "Manager",
};
