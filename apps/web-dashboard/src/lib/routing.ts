export const HELP_PATH = "/help";

/** WARP-2981 (ADR-059 §3.8) — the Security wall: a chromeless, read-only page for a TV. */
export const SECURITY_WALL_PATH = "/security/wall";

/** Where the wall's "sign in" goes: the sign-in page, back to the wall afterwards. */
export const SECURITY_WALL_SIGN_IN_HREF = `/login?next=${encodeURIComponent(SECURITY_WALL_PATH)}`;

/**
 * Whether `path` is the Security wall: trailing slashes, a query and a hash
 * are ignored, so `/security/wall/` and `/security/wall?x=1` are the wall
 * (with `trailingSlash` on, Next serves the first); `/security/wallpaper` and
 * `/security/wall/x` are not. The one check for every place that treats the
 * wall differently (AuthGate, the toaster, authFetch's sign-out). A missing
 * path is not the wall: the toaster's suites (this PR's and PR-C's) stand in
 * a `Location` with no `pathname`.
 */
export function isSecurityWallPath(path: string | null | undefined): boolean {
  if (typeof path !== "string") return false;
  const bare = path.split(/[?#]/, 1)[0]!.replace(/\/+$/, "");
  return bare === SECURITY_WALL_PATH;
}
