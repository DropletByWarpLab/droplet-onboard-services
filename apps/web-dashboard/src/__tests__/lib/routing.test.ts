/**
 * WARP-2981 (ADR-059 §3.8) — the one check for "is this the Security wall?".
 * AuthGate (no shell, the D6 refusal), the toaster (no toast) and authFetch
 * (no sign-in form on its own) all ask it, so a trailing slash (Next's
 * `trailingSlash`) or a query must not slip the wall past any of them — and a
 * neighbouring path must not be caught.
 */
import { describe, expect, it } from "vitest";
import { SECURITY_WALL_PATH, isSecurityWallPath } from "@/lib/routing";

describe("isSecurityWallPath", () => {
  it.each([SECURITY_WALL_PATH, "/security/wall/", "/security/wall//", "/security/wall?x=1", "/security/wall/?x=1", "/security/wall#top"])(
    "%s is the wall",
    (path) => expect(isSecurityWallPath(path)).toBe(true),
  );

  it.each(["/security", "/security/", "/security/wallpaper", "/security/walls", "/security/wall/x", "/security/zones", "/wall", "/", "", null, undefined])(
    "%s is not",
    (path) => expect(isSecurityWallPath(path)).toBe(false),
  );
});
