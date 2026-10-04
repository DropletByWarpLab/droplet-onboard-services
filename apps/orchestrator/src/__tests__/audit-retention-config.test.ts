import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// WARP-586 — config-level guard for the audit/log retention window.
// `DROPLET_AUDIT_RETENTION_DAYS` is documented (config.ts) and implemented
// (audit-retention-purge.service.ts: `olderThanDays <= 0 → skipped`) so that
// setting it to 0 disables the purge ("keep forever"). The Zod schema MUST
// therefore accept 0 — otherwise an operator who follows the documented
// disable instruction crashes the orchestrator at envSchema.parse() →
// process.exit(1) (index.ts) → boot-crash-loop, and the service's disable
// path is unreachable in production. These tests pin the end-to-end contract:
// 0 parses (disable reaches the service), while sub-day floats, Infinity, and
// negatives are still rejected loud at config (finding-1/#4 validation).
describe("DROPLET_AUDIT_RETENTION_DAYS config parsing (WARP-586)", () => {
  const ORIGINAL = process.env.DROPLET_AUDIT_RETENTION_DAYS;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DROPLET_AUDIT_RETENTION_DAYS;
    else process.env.DROPLET_AUDIT_RETENTION_DAYS = ORIGINAL;
    vi.resetModules();
  });

  it("accepts 0 as the documented disable value (no boot-crash)", async () => {
    process.env.DROPLET_AUDIT_RETENTION_DAYS = "0";
    const { config } = await import("../config.js");
    expect(config.DROPLET_AUDIT_RETENTION_DAYS).toBe(0);
  });

  // WARP-3639: twelve months of retrievable security logs by default.
  it("defaults to 365 days when unset", async () => {
    delete process.env.DROPLET_AUDIT_RETENTION_DAYS;
    const { config } = await import("../config.js");
    expect(config.DROPLET_AUDIT_RETENTION_DAYS).toBe(365);
  });

  it("accepts a positive integer window at or above the minimum", async () => {
    process.env.DROPLET_AUDIT_RETENTION_DAYS = "120";
    const { config } = await import("../config.js");
    expect(config.DROPLET_AUDIT_RETENTION_DAYS).toBe(120);
  });

  it("raises a window below the 90-day minimum to the minimum", async () => {
    process.env.DROPLET_AUDIT_RETENTION_DAYS = "30";
    const { config } = await import("../config.js");
    expect(config.DROPLET_AUDIT_RETENTION_DAYS).toBe(90);
  });

  it("resolveAuditRetentionDays warns on the raise and passes 0 and values at the floor through", async () => {
    const { resolveAuditRetentionDays, AUDIT_RETENTION_MIN_DAYS } = await import("../config.js");
    const warn = vi.fn();
    expect(resolveAuditRetentionDays(1, warn)).toBe(AUDIT_RETENTION_MIN_DAYS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(resolveAuditRetentionDays(0, warn)).toBe(0);
    expect(resolveAuditRetentionDays(AUDIT_RETENTION_MIN_DAYS, warn)).toBe(AUDIT_RETENTION_MIN_DAYS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rejects a sub-day float window (no fractional days)", async () => {
    process.env.DROPLET_AUDIT_RETENTION_DAYS = "1.5";
    await expect(import("../config.js")).rejects.toThrow();
  });

  it("rejects Infinity", async () => {
    process.env.DROPLET_AUDIT_RETENTION_DAYS = "Infinity";
    await expect(import("../config.js")).rejects.toThrow();
  });

  it("rejects a negative window (nonsensical input fails fast)", async () => {
    process.env.DROPLET_AUDIT_RETENTION_DAYS = "-5";
    await expect(import("../config.js")).rejects.toThrow();
  });
});
