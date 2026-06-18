import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * WARP-580 — fail-closed auth posture + production secret-strength guard.
 *
 *   • AUTH_ENABLED defaults to true (fail-closed). The only way to run with
 *     auth off is an EXPLICIT AUTH_ENABLED=false in a non-production NODE_ENV.
 *     In production the var is force-ON regardless of value, so the auth
 *     middleware's owner-injection-when-disabled branch can never fire on a
 *     shipped box.
 *   • Loading config in production with a weak/placeholder JWT_SECRET throws at
 *     startup (the refine), so a misconfiguration dies loud before serving a
 *     request.
 *
 * Mirrors cors-config.test.ts's dynamic-import-with-env-mutation harness:
 * config.ts reads process.env + runs its refines at module load, so each case
 * mutates env, resets the module registry, and re-imports.
 */
describe("WARP-580 — fail-closed auth + JWT secret strength guard", () => {
  const STRONG_SECRET = "x".repeat(64);
  const ORIGINAL = {
    NODE_ENV: process.env.NODE_ENV,
    AUTH_ENABLED: process.env.AUTH_ENABLED,
    JWT_SECRET: process.env.JWT_SECRET,
  };

  const restore = (key: keyof typeof ORIGINAL) => {
    const v = ORIGINAL[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    restore("NODE_ENV");
    restore("AUTH_ENABLED");
    restore("JWT_SECRET");
    vi.resetModules();
  });

  describe("pure helpers", () => {
    it("isWeakJwtSecret rejects short secrets and known dev placeholders", async () => {
      const { isWeakJwtSecret } = await import("../config.js");
      expect(isWeakJwtSecret("short")).toBe(true);
      expect(isWeakJwtSecret("dev-jwt-secret-do-not-use-in-production")).toBe(true);
      expect(isWeakJwtSecret("changeme")).toBe(true);
      // exactly 31 chars — one under the floor
      expect(isWeakJwtSecret("a".repeat(31))).toBe(true);
      // exactly 32 chars, not a placeholder — strong enough
      expect(isWeakJwtSecret("a".repeat(32))).toBe(false);
      expect(isWeakJwtSecret(STRONG_SECRET)).toBe(false);
    });

    it("resolveAuthEnabled is fail-closed: prod always on, dev honours explicit opt-out only", async () => {
      const { resolveAuthEnabled } = await import("../config.js");
      // Production: forced on regardless of the var.
      expect(resolveAuthEnabled("false", "production")).toBe(true);
      expect(resolveAuthEnabled("true", "production")).toBe(true);
      expect(resolveAuthEnabled(undefined, "production")).toBe(true);
      // Development: unset → on; explicit falsey token → off; otherwise → on.
      expect(resolveAuthEnabled(undefined, "development")).toBe(true);
      expect(resolveAuthEnabled("false", "development")).toBe(false);
      expect(resolveAuthEnabled("0", "development")).toBe(false);
      expect(resolveAuthEnabled("OFF", "development")).toBe(false);
      expect(resolveAuthEnabled("true", "development")).toBe(true);
      // A non-falsey junk value stays ON (fail-closed).
      expect(resolveAuthEnabled("maybe", "development")).toBe(true);
      // Test env behaves like non-prod (unset stays on).
      expect(resolveAuthEnabled(undefined, "test")).toBe(true);
    });
  });

  describe("AUTH_ENABLED default + resolution", () => {
    it("defaults to true when the var is unset (fail-closed)", async () => {
      delete process.env.AUTH_ENABLED;
      process.env.NODE_ENV = "development";
      const { config } = await import("../config.js");
      expect(config.AUTH_ENABLED).toBe(true);
    });

    it("honours an explicit AUTH_ENABLED=false in development", async () => {
      process.env.AUTH_ENABLED = "false";
      process.env.NODE_ENV = "development";
      const { config } = await import("../config.js");
      expect(config.AUTH_ENABLED).toBe(false);
    });

    it("force-ENABLES auth in production even with AUTH_ENABLED=false", async () => {
      process.env.AUTH_ENABLED = "false";
      process.env.NODE_ENV = "production";
      process.env.JWT_SECRET = STRONG_SECRET; // prod also needs a strong secret to parse
      const { config } = await import("../config.js");
      expect(config.AUTH_ENABLED).toBe(true);
    });
  });

  describe("JWT secret strength guard (production)", () => {
    it("rejects a weak placeholder secret in production at config load", async () => {
      process.env.NODE_ENV = "production";
      process.env.JWT_SECRET = "dev-jwt-secret-do-not-use-in-production";
      await expect(import("../config.js")).rejects.toThrow(/JWT_SECRET/i);
    });

    it("rejects a too-short secret in production at config load", async () => {
      process.env.NODE_ENV = "production";
      process.env.JWT_SECRET = "x".repeat(31);
      await expect(import("../config.js")).rejects.toThrow(/JWT_SECRET/i);
    });

    it("accepts a strong secret in production", async () => {
      process.env.NODE_ENV = "production";
      process.env.JWT_SECRET = STRONG_SECRET;
      const { config } = await import("../config.js");
      expect(config.JWT_SECRET).toBe(STRONG_SECRET);
    });

    it("tolerates the weak default outside production", async () => {
      process.env.NODE_ENV = "development";
      delete process.env.JWT_SECRET;
      const { config } = await import("../config.js");
      expect(config.JWT_SECRET).toBe("dev-jwt-secret-do-not-use-in-production");
    });
  });
});
