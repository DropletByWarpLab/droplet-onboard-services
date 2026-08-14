/**
 * WARP-1549 — which library does a file row belong to?
 *
 * Outside the main Files browser (Favorites, Recents, Trash, Shared) a row is
 * just a home-relative path. Nothing said whether "/Contracts/2026/msa.pdf"
 * lived in My Files or in the Finance library, and every row click routed into
 * the PERSONAL space regardless of where the file actually was.
 *
 * ── Where attribution lives: CLIENT-SIDE (v1 decision) ──────────────────────
 *
 * The ticket offered two mechanisms and asked for one, not both. This is the
 * client-side resolver, not a new `space`/`spaceName` field on `FileEntryInfo`:
 *
 *  - The data is already here. `GET /api/files/spaces` (`useSpaces()`) returns
 *    each visible space's home-relative `root`, which is all a longest-prefix
 *    match needs. No backend change, no new field to version, nothing for the
 *    four sub-view tickets to wait on.
 *  - It cannot go stale. Attribution is derived at render time from the space
 *    list the caller can see RIGHT NOW. A `space` baked into a cached
 *    `FileEntryInfo` would keep asserting a library after the membership behind
 *    it was revoked — exactly the mislabel this ticket exists to prevent.
 *  - It stays inside the orchestrator's authority (ADR-029 §47/§181 → ADR-013).
 *    The only input is the orchestrator's own space list; no Nextcloud state is
 *    read as truth, and no mount name is inferred from a WebDAV response.
 *  - Scope. The backend variant means touching `apps/orchestrator` and every
 *    listing endpoint's response shape.
 *
 * The backend field is still the better long-term answer for MCP and mobile,
 * which have no `useSpaces()` to resolve against. It is additive on top of this
 * (the resolver would simply prefer a server-supplied space when present) and
 * belongs on its own ticket — not smuggled into the web-dashboard change.
 *
 * ── Matching rules ─────────────────────────────────────────────────────────
 *
 * LONGEST prefix, on SEGMENT boundaries. Both halves matter: "/Household" and
 * "/Household Archive" would each `startsWith`-match "/Household Archive/x",
 * and a naive `startsWith` would also claim a personal "/Financeable" for the
 * "/Finance" library.
 *
 * Mount names are built by the orchestrator and reproduced here exactly:
 * DEPARTMENT → `name`; TEAM → `"<Parent> — <Team>"` with an em dash (U+2014)
 * and a space on both sides (`apps/orchestrator/src/routes/files.ts` — the
 * `rootForSpace` mount resolution and the `/spaces` listing). We never PARSE a
 * mount name — team names may themselves contain em dashes — we only compare
 * whole `root` strings, so the separator is never load-bearing.
 */
import type { FileSpace, FileSpaceId } from "./types";

/** Trailing-slash-free, comparable form of a space root ("/" stays "/"). */
function normalizeRoot(root: string | null | undefined): string {
  if (!root) return "/";
  const trimmed = root.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Is `path` inside `root`, matching on SEGMENT boundaries?
 *
 * "/Household" contains "/Household" and "/Household/Trips/x" but NOT
 * "/Household Archive/x" — the collision the ticket calls out.
 */
export function isPathInSpaceRoot(path: string, root: string | null | undefined): boolean {
  const r = normalizeRoot(root);
  if (r === "/") return true; // the personal home contains every home-relative path
  return path === r || path.startsWith(`${r}/`);
}

/**
 * Strip one leading space-root prefix ("/Finance/Contracts" → "/Contracts";
 * "/Finance" → "/"). A child literally named like its own mount
 * ("/Finance/Finance/x") keeps the inner segment — only the prefix goes.
 *
 * Same contract as `toSpaceRelativePath` in
 * `components/FileManager/search-target.ts`; kept here so `lib/` doesn't
 * import from `components/`.
 */
export function spaceRelativePath(path: string, root: string | null | undefined): string {
  const r = normalizeRoot(root);
  if (r === "/") return path || "/";
  if (path === r) return "/";
  if (path.startsWith(`${r}/`)) return path.slice(r.length) || "/";
  return path;
}

/**
 * How much the attribution can actually be trusted.
 *
 * - `matched`          — the path sits under a library root the caller can see.
 * - `assumed-personal` — the space list loaded and nothing claimed this path,
 *                        so it is (as far as we can tell) in the user's home.
 * - `unknown`          — the space list isn't available (still loading, or the
 *                        probe failed). We know NOTHING about this path.
 *
 * `unknown` exists so the UI can stay silent instead of asserting "My Files"
 * about a file it cannot place. See `libraryLabelForPath`.
 */
export type SpaceAttributionConfidence = "matched" | "assumed-personal" | "unknown";

export interface SpaceAttribution {
  /**
   * The owning library — populated ONLY for `matched`.
   *
   * Deliberately null for `assumed-personal` and `unknown`: a non-null `space`
   * is a positive claim, and this field can only ever name a space the caller
   * can currently see. It is what makes "degrade honestly" structural rather
   * than a rule each caller has to remember.
   */
  space: FileSpace | null;
  /** Safe to route with in every branch — falls back to the personal space. */
  spaceId: FileSpaceId;
  /** `path` relative to the matched space's root ("/Finance/Q1" → "/Q1"). */
  spacePath: string;
  /**
   * The value to put in `?path=` when linking to `/files` for this space.
   *
   * Equals `spacePath` for every matched space: the Files page's `?path=` is
   * space-root-relative, `fetchFiles` (`lib/api.ts`) sends the space, and the
   * orchestrator prefixes the mount server-side. `app/files/page.tsx` treats
   * its `currentPath` the same way via `toActiveSpaceRelative`.
   *
   * WARP-1623 flipped this. It used to be space-relative for `shared` only,
   * because `fetchFiles` sent `space=` for `shared` and nothing else — so a
   * department listed through personal semantics, where the groupfolder mount
   * is a real directory inside the user's home and the HOME-relative path was
   * the one that listed. WARP-1623 made `fetchFiles` send every non-personal
   * space, which is the trigger this comment used to name. Keeping the old
   * form would now double-prefix ("/Finance/Finance/Q1" — the WARP-1140 bug)
   * and render as a silently empty folder.
   *
   * The personal fallback stays the full home-relative path: personal sends no
   * `space` param and its root is "/", for which the translation is identity.
   */
  urlPath: string;
  confidence: SpaceAttributionConfidence;
  /**
   * True when more than one visible space declares the SAME root string.
   *
   * Only reachable through the team `parentName` join, which is by DISPLAY
   * NAME, not id (see `SpaceSwitcher`): two departments that share a display
   * name, each with a same-named team, produce two space ids with one
   * identical mount name. We resolve deterministically to the FIRST such space
   * in the server's order (`/spaces` is ordered `createdAt` ascending, so the
   * older library wins) and flag it here. The rendered label is unaffected —
   * both candidates have the same display name by construction — and routing
   * lands in the same place either way, because the server resolves both ids
   * to that one mount path.
   */
  ambiguous: boolean;
}

/**
 * Resolve a HOME-RELATIVE path to its owning space by longest-prefix match
 * over `spaces[].root`, falling back to the personal space.
 *
 * Pass the `spaces` array straight from `useSpaces()`. An empty array means
 * "not loaded / failed", not "no libraries exist" — the result is `unknown`,
 * never `assumed-personal`, so a slow or broken `/api/files/spaces` cannot
 * make every library file claim to be in My Files.
 */
export function resolveFileSpace(path: string, spaces: FileSpace[]): SpaceAttribution {
  const personalFallback = (confidence: SpaceAttributionConfidence): SpaceAttribution => ({
    space: null,
    spaceId: "personal",
    spacePath: path || "/",
    urlPath: path || "/",
    confidence,
    ambiguous: false,
  });

  if (!path) return personalFallback(spaces.length === 0 ? "unknown" : "assumed-personal");
  if (spaces.length === 0) return personalFallback("unknown");

  // Candidates: every non-personal space whose root contains the path. The
  // personal space's root is "/", which contains everything — it is the
  // fallback below, never a candidate, so it can't win a length comparison.
  let winner: FileSpace | null = null;
  let winnerRoot = "";
  let ties = 0;
  for (const candidate of spaces) {
    const root = normalizeRoot(candidate.root);
    if (root === "/") continue;
    if (!isPathInSpaceRoot(path, root)) continue;
    if (root.length > winnerRoot.length) {
      winner = candidate;
      winnerRoot = root;
      ties = 0;
    } else if (root === winnerRoot) {
      // Byte-identical roots — the same-display-name collision. First wins.
      ties++;
    }
  }

  if (!winner) return personalFallback("assumed-personal");

  const relative = spaceRelativePath(path, winnerRoot);
  return {
    space: winner,
    spaceId: winner.id,
    spacePath: relative,
    // WARP-1623 — space-relative for EVERY matched space, not just `shared`.
    urlPath: relative,
    confidence: "matched",
    ambiguous: ties > 0,
  };
}

/**
 * WARP-1808 — display-only mapping for the shared household space.
 *
 * The build is business-only (WARP-1341): the server still seeds and mounts
 * the shared space under its raw name ("Household" — a data contract that
 * grouping, `parentName` joins, and the longest-prefix path math above all
 * key off), but no user-visible surface may render that word. ONLY the
 * presentation changes, and it keys off `kind`, never the name string, so a
 * renamed server row maps too and a user-created space that happens to be
 * NAMED "Household" renders verbatim.
 *
 * Takes just `kind` + `name` (all it reads) so callers holding a partial
 * space row — e.g. a pre-load fallback literal without `root` — can use it.
 */
export function spaceRenderName(space: Pick<FileSpace, "kind" | "name">): string {
  return space.kind === "household" ? "Workspace" : space.name;
}

/**
 * The library's name as the user knows it, reconstructed to equal the mount
 * name: DEPARTMENT → `name`; TEAM → `"<Parent> — <Team>"`.
 *
 * A team's `name` alone ("Platform") is ambiguous across departments, so the
 * parent is included when the server sent one. Nothing is invented: with no
 * `parentName` the bare team name is shown rather than a guessed parent.
 *
 * The household space renders as "Workspace" (WARP-1808, `spaceRenderName`) —
 * for every other space this still equals the mount name. Teams keep their
 * RAW parent name: a team can't parent off the household space, and mapping
 * `parentName` would break the equals-the-mount-name property.
 */
export function spaceDisplayName(space: FileSpace): string {
  if (space.kind === "team" && space.parentName) {
    return `${space.parentName} — ${space.name}`;
  }
  return spaceRenderName(space);
}

/**
 * The chip text for a row, or `null` for "make no claim".
 *
 * Null covers both non-library cases on purpose:
 *
 *  - `assumed-personal` — a personal file needs no library chip; the row
 *    already shows a home-relative path.
 *  - `unknown` — the space list is missing, so we genuinely don't know.
 *
 * That is also how the revoked-membership case degrades honestly. When a
 * library disappears from the caller's space list between the row being
 * fetched and being rendered, its path stops matching, and the row falls to
 * `assumed-personal` — which prints NO chip. The row is unattributed, which is
 * the pre-WARP-1549 status quo, rather than being stamped "My Files", which
 * would be a false statement about where the file lives.
 */
export function libraryLabelForPath(path: string, spaces: FileSpace[]): string | null {
  const attribution = resolveFileSpace(path, spaces);
  return attribution.space ? spaceDisplayName(attribution.space) : null;
}

/**
 * Re-express a FOLDER path inside its own library ("/Finance/Q1" → "/Q1"),
 * leaving it alone when it can't be attributed.
 *
 * Used wherever a library chip is shown next to a path, so the mount name
 * isn't printed twice ("Finance" · "/Finance/Q1"). Unattributed paths keep
 * their full home-relative form — the pre-WARP-1549 display — because
 * shortening a path we can't place would be a claim we can't make.
 */
export function inSpacePath(path: string, spaces: FileSpace[]): string {
  const attribution = resolveFileSpace(path, spaces);
  return attribution.space ? attribution.spacePath : path;
}

/**
 * The location line for a file row: its PARENT folder, expressed inside its
 * library when attributable. Mirrors what the sub-view listings already
 * computed inline (`file.path.replace(/\/[^/]*$/, "") || "/"`), minus the
 * repeated mount name.
 */
export function displayLocationForPath(path: string, spaces: FileSpace[]): string {
  const parent = path.replace(/\/[^/]*$/, "") || "/";
  return inSpacePath(parent, spaces);
}

/**
 * Build a `/files` link for a (space, path) pair.
 *
 * Mirrors — byte for byte — the private `buildFilesUrl` in
 * `app/files/page.tsx` (WARP-1547), which is the only writer of that URL and
 * the reader of it. The defaults (personal space, space root) are OMITTED, so
 * the plain surface stays `/files`, a personal deep-link stays `/files?path=…`,
 * and a library jump stays exactly `/files?space=dept%3A<id>`.
 *
 * Duplicated rather than imported because `page.tsx` keeps it module-private
 * and is owned by another change in flight; the two should be de-duplicated
 * into this module (the tests below pin the shared contract).
 */
export function buildFilesUrl(space: FileSpaceId, path: string): string {
  const qs = new URLSearchParams();
  if (space && space !== "personal") qs.set("space", space);
  if (path && path !== "/") qs.set("path", path);
  const query = qs.toString();
  return query ? `/files?${query}` : "/files";
}

/**
 * The `/files` link a sub-view row should navigate to: the file's own library,
 * at the file's own folder.
 *
 * Directories open themselves; files open their parent folder (the behavior
 * the sub-views already had — they just always opened it in the personal
 * space). An unattributable path still resolves to personal with its full
 * home-relative path, which is the same fail-safe `page.tsx` applies to an
 * unknown `?space=` id: no error surface, and no leak of whether the library
 * exists.
 */
export function filesUrlForEntry(
  entry: { path: string; isDirectory: boolean },
  spaces: FileSpace[]
): string {
  const target = entry.isDirectory ? entry.path : entry.path.replace(/\/[^/]*$/, "") || "/";
  const attribution = resolveFileSpace(target, spaces);
  return buildFilesUrl(attribution.spaceId, attribution.urlPath);
}
