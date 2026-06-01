import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// WARP-562 — config-level guard: mirror ai-gateway (main.py:125-129), which
// refuses CORS_ORIGINS=* when credentials are enabled. Loading config with a
// wildcard CORS allowlist must throw at startup so a misconfiguration fails
// loud instead of silently re-opening the credentialed-reflection hole.
describe("CORS allowlist config parsing (WARP-562)", () => {
  const ORIGINAL = process.env.CORS_ALLOWED_ORIGINS;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = ORIGINAL;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    vi.resetModules();
  });

  it("throws when the allowlist is a wildcard (credentials are enabled)", async () => {
    process.env.CORS_ALLOWED_ORIGINS = "*";
    await expect(import("../config.js")).rejects.toThrow(/wildcard|\*/i);
  });

  it("parses a comma-separated list, trimming and dropping empties", async () => {
    process.env.CORS_ALLOWED_ORIGINS =
      " https://a.example , ,https://b.example ";
    const { config } = await import("../config.js");
    expect(config.corsAllowedOrigins).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("defaults to the LAN dashboard origin when unset", async () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    const { config } = await import("../config.js");
    expect(config.corsAllowedOrigins).toContain("https://droplet-ai.local");
  });

  it("appends the dev dashboard origin only outside production", async () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    process.env.NODE_ENV = "development";
    const { config } = await import("../config.js");
    expect(config.corsAllowedOrigins).toContain("http://localhost:3001");
  });

  it("does NOT append the dev origin in production", async () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    process.env.NODE_ENV = "production";
    // production also requires a strong JWT_SECRET; set one so config parses.
    const prevJwt = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "x".repeat(64);
    try {
      const { config } = await import("../config.js");
      expect(config.corsAllowedOrigins).not.toContain("http://localhost:3001");
      expect(config.corsAllowedOrigins).toContain("https://droplet-ai.local");
    } finally {
      if (prevJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prevJwt;
    }
  });
});
