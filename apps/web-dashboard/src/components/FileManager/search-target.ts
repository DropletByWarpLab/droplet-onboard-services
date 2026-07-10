import type { FileSpaceId } from "@/lib/types";

/**
 * WARP-1139/WARP-1140 — path/space coordination for Files search results.
 *
 * Search results (name, keyword, and semantic modes) and directory-listing
 * entries always carry HOME-relative paths (e.g. "/Docs/a.pdf" or
 * "/Household/Trips/b.pdf" — the groupfolders mount lives inside each
 * member's home). The Files page's `currentPath`, however, is relative to
 * the ACTIVE space's root (`?space=shared&path=/Trips` →
 * "/Household/Trips" server-side). Feeding a home-relative path back into
 * `currentPath` while the Household tab is active double-prefixes the next
 * listing ("/Household/Household/…"), which Nextcloud 404s and the degrade
 * path renders as a silently empty folder.
 */

export interface SearchResultTarget {
  /** The space the picked result lives in. */
  space: FileSpaceId;
  /** The path expressed relative to that space's root. */
  path: string;
}

/**
 * Strip ONE leading shared-root prefix from a home-relative path, yielding
 * the space-root-relative form ("/Household/Trips/x" → "/Trips/x";
 * "/Household" → "/"). Paths outside the shared root pass through verbatim.
 * A nested child literally named like the root ("/Household/Household/x")
 * keeps its inner segment — only the mount prefix is removed.
 */
export function toSpaceRelativePath(
  path: string,
  sharedRoot: string | null | undefined,
): string {
  if (!sharedRoot || sharedRoot === "/") return path;
  const prefix = sharedRoot.endsWith("/") ? sharedRoot.slice(0, -1) : sharedRoot;
  if (path === prefix) return "/";
  if (path.startsWith(prefix + "/")) return path.slice(prefix.length) || "/";
  return path;
}

/**
 * WARP-1200 — inverse of `toSpaceRelativePath`: resolve a space-root-relative
 * path (the shape `currentPath` holds while the Household tab is active) back
 * to the HOME-relative form the write APIs expect ("/Trips" →
 * "/Household/Trips", "/" → "/Household"). The write routes take
 * home-relative paths — the same shape the listing entries carry — so a
 * Household-tab upload / mkdir / paste destination must be resolved through
 * this or the write silently lands in the personal space. With no shared
 * root (personal space, or shared unavailable) the path passes through
 * verbatim.
 */
export function toHomeRelativePath(
  path: string,
  sharedRoot: string | null | undefined,
): string {
  if (!sharedRoot || sharedRoot === "/") return path;
  const prefix = sharedRoot.endsWith("/") ? sharedRoot.slice(0, -1) : sharedRoot;
  if (path === "/" || path === "") return prefix;
  return path.startsWith("/") ? `${prefix}${path}` : `${prefix}/${path}`;
}

/**
 * Map a search-result path to the (space, in-space path) pair the Files
 * page should navigate to. Results under the shared root open in the
 * Household space (prefix stripped); everything else opens in My Files.
 * Pass `sharedRoot: null` when the shared space isn't available — every
 * result then resolves to the personal space.
 */
export function resolveSearchResultTarget(
  path: string,
  sharedRoot: string | null | undefined,
): SearchResultTarget {
  if (sharedRoot && sharedRoot !== "/") {
    const prefix = sharedRoot.endsWith("/")
      ? sharedRoot.slice(0, -1)
      : sharedRoot;
    if (path === prefix || path.startsWith(prefix + "/")) {
      return { space: "shared", path: toSpaceRelativePath(path, prefix) };
    }
  }
  return { space: "personal", path };
}
