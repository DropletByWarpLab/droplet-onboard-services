/**
 * WARP-3053 — who may publish company files outside the company.
 *
 * Ruling (Romain, 2026-09-25): a public link (OCS shareType 3) to anything
 * that is not the caller's personal space is company data, so only an owner
 * or admin may create or edit one. "Not personal" means the company Workspace
 * (wire space `household`, sent as `space=shared`, mounted at `/Household`)
 * AND every department/team library. Members keep sharing their own personal
 * files and sharing internally with named people.
 *
 * Granting the re-share bit on company data is the same decision one hop
 * later (the recipient can then mint a public link from their own home, where
 * the item no longer sits under a company path), so it goes through the same
 * function.
 *
 * `mayCreatePublicLink` is the ONE place that decides. A future box setting
 * ("members may create public links") widens it here and nowhere else.
 */

export type ShareLibrary = "personal" | "company";

/** OCS share types that stay inside the company: a named user (0) or group (1). */
const INTERNAL_SHARE_TYPES: ReadonlySet<number> = new Set([0, 1]);
/** OCS re-share permission bit. */
export const PERM_SHARE = 16;

export function mayCreatePublicLink(role: string | undefined, library: ShareLibrary): boolean {
  if (library === "personal") return true;
  return role === "owner" || role === "admin";
}

/**
 * True when this share could let data leave the company. An ALLOWLIST: only
 * a user (0) or group (1) share WITHOUT the re-share bit is internal. Link
 * (3), email (4, an external token link), federated (6, 9), circle (7),
 * Talk room (10), deck (12), ScienceMesh (15) and any type Nextcloud adds
 * later all count as leaving.
 *
 * Ruling (WARP-3053 fix round 1): circles and Talk rooms are NOT internal.
 * The box installs neither app and sends neither type, and both can hold
 * guests or federated members, so an unknown audience fails closed.
 */
export function exposesOutside(shareType: number, permissions: number): boolean {
  return !INTERNAL_SHARE_TYPES.has(shareType) || (permissions & PERM_SHARE) !== 0;
}

/** Canonical form for comparison: NFC, case-folded, `.`/empty segments dropped. */
function canonical(path: string): string {
  return path
    .normalize("NFC")
    .toLowerCase()
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".")
    .join("/");
}

/**
 * Classify a home-relative path. Nextcloud mounts the Workspace and every
 * department/team library as a folder in each member's home, so the web's
 * and the Mac's "full home path, no `space`" shape still names the library.
 *
 * Roots are matched as whole path prefixes, longest first, because a
 * department name may itself contain `/` (`Sales/EMEA`). Comparison is NFC
 * and case-insensitive: a personal folder that differs from a library only
 * by case or Unicode form is treated as company data (fail closed; costs a
 * member a public link, never a leak). A backslash is refused upstream and
 * classified as company here for the same reason.
 */
export function libraryOfHomePath(homePath: string, companyRoots: readonly string[]): ShareLibrary {
  if (homePath.includes("\\")) return "company";
  const p = canonical(homePath);
  if (!p) return "personal";
  const roots = companyRoots
    .map(canonical)
    .filter((r) => r !== "")
    .sort((a, b) => b.length - a.length);
  return roots.some((r) => p === r || p.startsWith(r + "/")) ? "company" : "personal";
}

export const PUBLIC_LINK_REFUSAL = {
  error: "public_link_company_data",
  message:
    "Only an owner or admin can create or change a public link to company files, or let others re-share them. You can still share with people in the company.",
} as const;
