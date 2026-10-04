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

/**
 * WARP-3168 — true when a home-relative path is in the company Workspace
 * (same NFC, case-insensitive, fail-closed matching as `libraryOfHomePath`).
 *
 * Ruling (Romain, 2026-09-25): members may not share Workspace items AT ALL,
 * internal shares included. Every member already sees the whole Workspace, so
 * an internal share adds nothing, and Nextcloud can only express "no share of
 * any kind" on a groupfolder (group mask 15, as for department libraries), so
 * the box refuses exactly what Nextcloud refuses. Department/team libraries
 * keep the WARP-3053 rule: internal shares open, anything leaving the company
 * owner/admin only.
 */
export function isWorkspacePath(homePath: string, workspaceRoot: string): boolean {
  return libraryOfHomePath(homePath, [workspaceRoot]) === "company";
}

export const WORKSPACE_SHARE_REFUSAL = {
  error: "workspace_share_admin_only",
  message:
    "Workspace files are already shared with everyone in the company. Only an owner or admin can share them outside.",
} as const;

export const PUBLIC_LINK_REFUSAL = {
  error: "public_link_company_data",
  message:
    "Only an owner or admin can create or change a public link to company files, or let others re-share them. You can still share with people in the company.",
} as const;

// ── WARP-3586 — what a public link may be, whoever asks ───────────────────
//
// WARP-3053 above decides WHO may publish a link. These rules decide WHAT a
// link may be, and apply to every caller of the share routes (dashboard, Mac,
// iOS, the assistant's share_file tool): an expiry always (30 days when none is
// given, never beyond 90), a password of at least 8 characters when one is set,
// and no anonymous edit/upload/delete for a member on a folder. Nextcloud gets
// the same expiry ceiling from docker/nextcloud-init.sh.

/** OCS share types that mint a token URL anyone holding it can open: link (3) and email (4). */
const PUBLIC_LINK_SHARE_TYPES: ReadonlySet<number> = new Set([3, 4]);

export const PUBLIC_LINK_DEFAULT_EXPIRY_DAYS = 30;
export const PUBLIC_LINK_MAX_EXPIRY_DAYS = 90;
export const PUBLIC_LINK_MIN_PASSWORD_LENGTH = 8;

/** OCS permission bits that let an anonymous holder change data. */
export const PERM_UPDATE = 2;
export const PERM_CREATE = 4;
export const PERM_DELETE = 8;

export function isPublicLinkType(shareType: number): boolean {
  return PUBLIC_LINK_SHARE_TYPES.has(shareType);
}

function ymdPlusDays(days: number, now: Date): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD, the 30-day default a link gets when the caller sends no expiry. */
export function defaultPublicLinkExpiry(now: Date = new Date()): string {
  return ymdPlusDays(PUBLIC_LINK_DEFAULT_EXPIRY_DAYS, now);
}

export interface PublicLinkViolation {
  error: string;
  message: string;
}

/**
 * Null when `expireDate` is an acceptable public-link expiry. Empty/missing is
 * a violation here: callers that mean "default" substitute `defaultPublicLinkExpiry`
 * first; a PUT that sends "" is trying to remove the expiry.
 */
export function publicLinkExpiryViolation(
  expireDate: string | undefined,
  now: Date = new Date(),
): PublicLinkViolation | null {
  if (!expireDate || !/^\d{4}-\d{2}-\d{2}$/.test(expireDate)) {
    return {
      error: "public_link_expiry_required",
      message: "A public link must expire. Send an expiry date as YYYY-MM-DD.",
    };
  }
  // ISO dates compare correctly as strings.
  if (expireDate > ymdPlusDays(PUBLIC_LINK_MAX_EXPIRY_DAYS, now)) {
    return {
      error: "public_link_expiry_too_far",
      message: `A public link can last at most ${PUBLIC_LINK_MAX_EXPIRY_DAYS} days.`,
    };
  }
  return null;
}

/** Null when there is no password or it meets the minimum length. Never echoes the value. */
export function publicLinkPasswordViolation(password: string | undefined): PublicLinkViolation | null {
  if (password === undefined) return null;
  if (password.length < PUBLIC_LINK_MIN_PASSWORD_LENGTH) {
    return {
      error: "public_link_password_too_short",
      message: `A public link password must be at least ${PUBLIC_LINK_MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  return null;
}

/** Only an owner or admin may hand an anonymous link holder write access to a folder. */
export const PUBLIC_LINK_EDIT_REFUSAL = {
  error: "public_link_edit_admin_only",
  message:
    "Only an owner or admin can let people with a public link edit, upload to or delete from a folder. A view-only link is available.",
} as const;

/**
 * True when `permissions` on a public link would let an anonymous holder write,
 * and a member may not grant it. Create and delete only exist on folders, so
 * they are refused outright; update is refused when the target is a folder
 * (`isFolder`), and allowed on a single file (the dashboard's "can edit" level).
 * Owner/admin are never capped here.
 */
export function memberPublicLinkWriteRefused(
  role: string | undefined,
  permissions: number,
  isFolder: boolean,
): boolean {
  if (role === "owner" || role === "admin") return false;
  if ((permissions & (PERM_CREATE | PERM_DELETE)) !== 0) return true;
  return (permissions & PERM_UPDATE) !== 0 && isFolder;
}
