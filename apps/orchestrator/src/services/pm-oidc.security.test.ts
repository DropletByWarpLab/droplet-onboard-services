/**
 * WARP-505 — security regression tests for the OIDC IdP primitives
 * Romain flagged on PR #307:
 *
 *   1. `verifyClientSecret` must use constant-time compare. The prior
 *      `===` path leaked character-by-character timing against the
 *      /token endpoint for same-length guesses.
 *   2. `buildAllowedRedirectUris` (in routes/pm.ts) must return an
 *      exact-match allowlist of pre-registered URIs per RFC 6749
 *      §10.6 / OIDC Core §3.1.2.1. A prefix match or "any non-empty
 *      string" check is an open-redirect vector that leaks the
 *      authorization code to attacker-controlled hosts.
 *
 * These are pure-function unit tests — no Express harness needed.
 * Route-level coverage of /authorize itself is deferred to the
 * WARP-517 pilot's integration tests (the route handler has 8 other
 * branches whose correct shape needs a running Plane to verify
 * end-to-end anyway).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stable secret + web URL for the duration of the test file.
vi.mock("../config.js", () => ({
  config: {
    DROPLET_PM_OIDC_CLIENT_SECRET: "super-secret-32-byte-test-value!",
    DROPLET_PM_OIDC_CLIENT_ID: "plane",
    DROPLET_PM_WEB_URL: "https://droplet-ai.local/pm",
  },
}));

describe("verifyClientSecret — constant-time compare", () => {
  let verifyClientSecret: (s: string) => boolean;

  beforeEach(async () => {
    vi.resetModules();
    ({ verifyClientSecret } = await import("./pm-oidc.service.js"));
  });

  it("returns true for an exact match", () => {
    expect(verifyClientSecret("super-secret-32-byte-test-value!")).toBe(true);
  });

  it("returns false for a same-length mismatch", () => {
    // Same length as expected, all chars differ — proves the compare
    // ran the whole buffer and returned false.
    expect(verifyClientSecret("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
  });

  it("returns false for an empty presented secret", () => {
    expect(verifyClientSecret("")).toBe(false);
  });

  it("returns false for a longer-than-expected presented secret", () => {
    // Length pre-check is mandatory because timingSafeEqual throws on
    // unequal buffer lengths — the test would surface that as a
    // thrown error rather than a clean `false`.
    const longer = "super-secret-32-byte-test-value!XXXX";
    expect(() => verifyClientSecret(longer)).not.toThrow();
    expect(verifyClientSecret(longer)).toBe(false);
  });

  it("returns false for a shorter-than-expected presented secret", () => {
    expect(() => verifyClientSecret("short")).not.toThrow();
    expect(verifyClientSecret("short")).toBe(false);
  });

  it("returns false when DROPLET_PM_OIDC_CLIENT_SECRET is empty", async () => {
    // Re-import with an empty secret config to exercise the
    // fail-CLOSED branch operators hit before they wire up the
    // env var.
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: {
        DROPLET_PM_OIDC_CLIENT_SECRET: "",
        DROPLET_PM_OIDC_CLIENT_ID: "plane",
        DROPLET_PM_WEB_URL: "https://droplet-ai.local/pm",
      },
    }));
    const mod = await import("./pm-oidc.service.js");
    expect(mod.verifyClientSecret("anything")).toBe(false);
    vi.doUnmock("../config.js");
  });
});

describe("buildAllowedRedirectUris — exact-match allowlist", () => {
  let buildAllowedRedirectUris: () => readonly string[];

  beforeEach(async () => {
    vi.resetModules();
    ({ buildAllowedRedirectUris } = await import("../routes/pm.js"));
  });

  it("returns the two documented Plane callback paths", () => {
    const allowed = buildAllowedRedirectUris();
    expect(allowed).toEqual([
      "https://droplet-ai.local/pm/auth/oidc/",
      "https://droplet-ai.local/pm/auth/oidc/callback/",
    ]);
  });

  it("strips trailing slashes from DROPLET_PM_WEB_URL before appending", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: {
        DROPLET_PM_OIDC_CLIENT_SECRET: "x",
        DROPLET_PM_OIDC_CLIENT_ID: "plane",
        DROPLET_PM_WEB_URL: "https://droplet-ai.local/pm/",
      },
    }));
    const mod = await import("../routes/pm.js");
    const allowed = mod.buildAllowedRedirectUris();
    // Should NOT produce //auth/oidc/ — the trailing slash is stripped.
    expect(allowed).toEqual([
      "https://droplet-ai.local/pm/auth/oidc/",
      "https://droplet-ai.local/pm/auth/oidc/callback/",
    ]);
    vi.doUnmock("../config.js");
  });

  it("does NOT include /auth/oidc/logout/ (that's the post_logout_redirect_uri, not the /authorize destination)", () => {
    const allowed = buildAllowedRedirectUris();
    expect(allowed.some((u) => u.endsWith("/logout/"))).toBe(false);
  });

  it("an attacker-controlled redirect_uri does NOT pass an Array.includes() check", () => {
    const allowed = buildAllowedRedirectUris();
    const attackerUris = [
      "https://attacker.example/callback",
      "https://attacker.example/pm/auth/oidc/callback/",
      // Same host but wrong path tree (e.g. open-redirect via a
      // sibling endpoint).
      "https://droplet-ai.local/pm/some/other/path",
      // Sub-path that a careless `startsWith` check would let through.
      "https://droplet-ai.local/pm/auth/oidc/callback/../../../attacker",
    ];
    for (const uri of attackerUris) {
      expect(allowed.includes(uri)).toBe(false);
    }
  });
});
