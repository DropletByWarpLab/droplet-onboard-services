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
  // WARP-580 (part 2) — device/service secrets a PRODUCTION boot must carry
  // non-empty. Mirrors PRODUCTION_REQUIRED_SECRET_KEYS in config.ts (asserted
  // below); scripts/setup.sh generates every one of these into .env.
  const REQUIRED_SECRET_KEYS = [
    "DEVICE_SECRET_KEY",
    "SERVICE_TOKEN_SWITCH",
    "SERVICE_TOKEN_AI_GATEWAY",
    "SERVICE_TOKEN_VOICE",
    "SERVICE_TOKEN_MCP",
    "SERVICE_TOKEN_EMAIL",
    "SERVICE_TOKEN_EGRESS_AUDIT",
  ] as const;
  const ORIGINAL: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    AUTH_ENABLED: process.env.AUTH_ENABLED,
    JWT_SECRET: process.env.JWT_SECRET,
    ...Object.fromEntries(REQUIRED_SECRET_KEYS.map((k) => [k, process.env[k]])),
  };

  const restore = (key: string) => {
    const v = ORIGINAL[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  };

  /** Make a production parse pass its secret gates (strong JWT + every
   *  required device/service secret non-empty). Individual cases then knock
   *  out the one key they exercise. */
  const setProductionSecrets = () => {
    process.env.JWT_SECRET = STRONG_SECRET;
    for (const key of REQUIRED_SECRET_KEYS) {
      process.env[key] = `test-${key.toLowerCase()}-0123456789abcdef`;
    }
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of Object.keys(ORIGINAL)) restore(key);
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
      setProductionSecrets(); // prod also needs strong/non-empty secrets to parse
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
      setProductionSecrets();
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

  // WARP-580 (part 2) — production boot must fail fast, with a message naming
  // the offending keys, when any device/service secret is empty or the
  // .env.example placeholder. setup.sh generates all of them, so a provisioned
  // box is unaffected; dev/test (non-production) keep their empty defaults.
  describe("device/service secret emptiness guard (production)", () => {
    it("exports the required-keys list and it covers every SERVICE_TOKEN_* schema key", async () => {
      const { PRODUCTION_REQUIRED_SECRET_KEYS } = await import("../config.js");
      expect([...PRODUCTION_REQUIRED_SECRET_KEYS].sort()).toEqual(
        [...REQUIRED_SECRET_KEYS].sort(),
      );
    });

    it("findEmptyProductionSecrets flags empty, whitespace, and placeholder values", async () => {
      const { findEmptyProductionSecrets } = await import("../config.js");
      const good = Object.fromEntries(
        REQUIRED_SECRET_KEYS.map((k) => [k, "a-real-generated-secret-value"]),
      );
      expect(findEmptyProductionSecrets(good)).toEqual([]);
      expect(
        findEmptyProductionSecrets({ ...good, DEVICE_SECRET_KEY: "" }),
      ).toEqual(["DEVICE_SECRET_KEY"]);
      expect(
        findEmptyProductionSecrets({ ...good, SERVICE_TOKEN_MCP: "   " }),
      ).toEqual(["SERVICE_TOKEN_MCP"]);
      // The `.env.example` placeholder is as bad as empty.
      expect(
        findEmptyProductionSecrets({ ...good, DEVICE_SECRET_KEY: "change-me" }),
      ).toEqual(["DEVICE_SECRET_KEY"]);
    });

    it("rejects an empty DEVICE_SECRET_KEY in production at config load", async () => {
      process.env.NODE_ENV = "production";
      setProductionSecrets();
      process.env.DEVICE_SECRET_KEY = "";
      await expect(import("../config.js")).rejects.toThrow(/DEVICE_SECRET_KEY/);
    });

    it("rejects an empty service token in production and names every missing key", async () => {
      process.env.NODE_ENV = "production";
      setProductionSecrets();
      delete process.env.SERVICE_TOKEN_VOICE;
      process.env.SERVICE_TOKEN_EMAIL = "";
      await expect(import("../config.js")).rejects.toThrow(
        /SERVICE_TOKEN_VOICE.*SERVICE_TOKEN_EMAIL|SERVICE_TOKEN_EMAIL.*SERVICE_TOKEN_VOICE/s,
      );
    });

    it("boots in production when every required secret is non-empty", async () => {
      process.env.NODE_ENV = "production";
      setProductionSecrets();
      const { config } = await import("../config.js");
      expect(config.DEVICE_SECRET_KEY).not.toBe("");
    });

    it("tolerates empty device/service secrets outside production (dev/test ergonomics)", async () => {
      process.env.NODE_ENV = "development";
      for (const key of REQUIRED_SECRET_KEYS) delete process.env[key];
      const { config } = await import("../config.js");
      expect(config.DEVICE_SECRET_KEY).toBe("");
      expect(config.SERVICE_TOKEN_VOICE).toBe("");
    });
  });
});
