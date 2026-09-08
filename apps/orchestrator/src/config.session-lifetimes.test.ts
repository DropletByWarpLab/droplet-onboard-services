/**
 * WARP-2854 — shipped session lifetimes are a product decision: an
 * owner/admin logs in again once every 24 h, a family/guest once every
 * 7 days, nothing shorter. The idle window defaults to the role's cap so it
 * never fires first unless an operator lowers it. Loading config.ts is
 * environment-sensitive, so each case imports it in an isolated module
 * registry with a controlled process.env (same approach as
 * config.review-nudge.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEYS = [
  "SESSION_IDLE_TIMEOUT_ADMIN_SECONDS",
  "SESSION_IDLE_TIMEOUT_USER_SECONDS",
  "SESSION_ABSOLUTE_TIMEOUT_ADMIN_SECONDS",
  "SESSION_ABSOLUTE_TIMEOUT_USER_SECONDS",
  "SESSION_ABSOLUTE_TIMEOUT_SECONDS",
] as const;

describe("WARP-2854 — session lifetime defaults", () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const k of KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("owner/admin: 24 h cap, idle equal to the cap", async () => {
    const { config } = await import("./config.js");
    expect(config.SESSION_ABSOLUTE_TIMEOUT_ADMIN_SECONDS).toBe(24 * 60 * 60);
    expect(config.SESSION_IDLE_TIMEOUT_ADMIN_SECONDS).toBe(config.SESSION_ABSOLUTE_TIMEOUT_ADMIN_SECONDS);
  });

  it("family/guest: 7 d cap, idle equal to the cap", async () => {
    const { config } = await import("./config.js");
    expect(config.SESSION_ABSOLUTE_TIMEOUT_USER_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(config.SESSION_IDLE_TIMEOUT_USER_SECONDS).toBe(config.SESSION_ABSOLUTE_TIMEOUT_USER_SECONDS);
  });

  it("a stale single-cap line from a pre-WARP-2854 .env is ignored, not applied to either role", async () => {
    process.env.SESSION_ABSOLUTE_TIMEOUT_SECONDS = "28800";
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.SESSION_ABSOLUTE_TIMEOUT_ADMIN_SECONDS).toBe(24 * 60 * 60);
    expect(config.SESSION_ABSOLUTE_TIMEOUT_USER_SECONDS).toBe(7 * 24 * 60 * 60);
    expect("SESSION_ABSOLUTE_TIMEOUT_SECONDS" in config).toBe(false);
  });

  it("operators can set the WARP-247 AAL2 posture back per role", async () => {
    process.env.SESSION_IDLE_TIMEOUT_ADMIN_SECONDS = "900";
    process.env.SESSION_ABSOLUTE_TIMEOUT_ADMIN_SECONDS = "28800";
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.SESSION_IDLE_TIMEOUT_ADMIN_SECONDS).toBe(900);
    expect(config.SESSION_ABSOLUTE_TIMEOUT_ADMIN_SECONDS).toBe(28800);
    // The other class is untouched.
    expect(config.SESSION_ABSOLUTE_TIMEOUT_USER_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});
