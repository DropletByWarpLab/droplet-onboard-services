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

/** OCS public-link share type. */
export const SHARE_TYPE_PUBLIC_LINK = 3;
/** OCS re-share permission bit. */
export const PERM_SHARE = 16;

export function mayCreatePublicLink(role: string | undefined, library: ShareLibrary): boolean {
  if (library === "personal") return true;
  return role === "owner" || role === "admin";
}

/** True when this share would let data leave the company (link, or a re-share grant). */
export function exposesOutside(shareType: number, permissions: number): boolean {
  return shareType === SHARE_TYPE_PUBLIC_LINK || (permissions & PERM_SHARE) !== 0;
}

/**
 * Classify a home-relative path by its first segment. Nextcloud mounts the
 * Workspace and every department/team library as a top-level folder in each
 * member's home, so the web's and the Mac's "full home path, no `space`"
 * shape still names the library. Compared case-insensitively on purpose:
 * a personal folder that differs from a library only by case is treated as
 * company data (fail closed, costs that member a public link, never a leak).
 */
export function libraryOfHomePath(homePath: string, companyRoots: readonly string[]): ShareLibrary {
  const first = homePath
    .split("/")
    .find((seg) => seg !== "" && seg !== ".");
  if (!first) return "personal";
  const f = first.toLowerCase();
  return companyRoots.some((r) => r.toLowerCase() === f) ? "company" : "personal";
}

export const PUBLIC_LINK_REFUSAL = {
  error: "public_link_company_data",
  message:
    "Only an owner or admin can create or change a public link to company files, or let others re-share them. You can still share with people in the company.",
} as const;
