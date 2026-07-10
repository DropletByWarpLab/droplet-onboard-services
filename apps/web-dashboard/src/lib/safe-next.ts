/**
 * Resolve a `?next=` redirect to a same-origin path, or fall back to "/".
 *
 * Extracted from `app/login/page.tsx` (WARP-1054) so the login page AND the new
 * `/login/passkey` approval page share ONE hardened resolver instead of two
 * copies drifting apart. The comment below encodes non-obvious URL-parser attack
 * coverage — do not reimplement it inline anywhere; import this instead.
 *
 * A plain `startsWith("/")` / `startsWith("//")` guard is unsafe: the WHATWG
 * URL parser (used by router.push → `new URL(next, origin)` in Next 14.2)
 * collapses `\` → `/` and strips leading tab/newline, so `/\evil.com`,
 * `/⇥/evil.com` and `/\n//evil.com` resolve to an off-origin authority *after*
 * a naive string check passes. Instead we resolve the candidate against a
 * sentinel origin and only honour it when its `.origin` is unchanged — then
 * return just the path+query+fragment so the caller never pushes an absolute
 * URL. Anything off-origin (incl. `//host`, `https:evil`, encoded variants) or
 * malformed falls back to "/".
 *
 * The sentinel-origin check is necessary but NOT sufficient: `..` resolution
 * can pop the empty leading path segment so the *resolved path itself* becomes
 * an authority while `.origin` stays the sentinel. `/..//evil.com` resolves to
 * `.pathname === "//evil.com"` with `.origin === SENTINEL` (the origin check
 * passes), and returning `//evil.com` lets the caller's `router.push` resolve
 * it against the *real* `location.origin` → off-origin nav. Re-checking the
 * origin can't catch this — under the sentinel `//evil.com` looks same-origin —
 * so we additionally reject any resolved path that opens with `//` or `/\`
 * (`/x/..//evil.com`, `/.//evil.com`, `/../\evil.com`, …) and fall back to "/".
 */
export function safeNext(next: string | null): string {
  if (!next) return "/";
  const SENTINEL = "http://x.invalid";
  try {
    const u = new URL(next, SENTINEL);
    if (u.origin !== SENTINEL) return "/";
    const path = u.pathname + u.search + u.hash;
    // Reject a protocol-relative / authority-leading resolved path, which
    // router.push would otherwise resolve against the real location.origin.
    if (path.startsWith("//") || path.startsWith("/\\")) return "/";
    return path;
  } catch {
    return "/";
  }
}
