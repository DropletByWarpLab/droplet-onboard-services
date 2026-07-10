/**
 * WARP-1122 (§8.2/§5-11) — BUSINESS_PROFILE_REVIEW_DAYS config schema.
 *
 * The reviewer-notes DoD verifies the nudge interval by booting with
 * BUSINESS_PROFILE_REVIEW_DAYS=0 (0 = review on every daily check /
 * immediate). config.ts calls envSchema.parse() (not safeParse), so a
 * rejected value throws a Zod error and CRASHES orchestrator boot — the
 * schema MUST accept 0. Negative values stay rejected (a negative interval
 * would push the staleness cutoff into the future and never fire). Loading
 * config.ts is environment-sensitive, so each case imports it in an isolated
 * module registry with a controlled process.env (same approach the rest of
 * the suite uses).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("WARP-1122 — BUSINESS_PROFILE_REVIEW_DAYS config", () => {
  const original = process.env.BUSINESS_PROFILE_REVIEW_DAYS;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.BUSINESS_PROFILE_REVIEW_DAYS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.BUSINESS_PROFILE_REVIEW_DAYS;
    else process.env.BUSINESS_PROFILE_REVIEW_DAYS = original;
  });

  it("defaults to 90 when unset", async () => {
    const { config } = await import("./config.js");
    expect(config.BUSINESS_PROFILE_REVIEW_DAYS).toBe(90);
  });

  it("accepts 0 without crashing boot (documented verification value)", async () => {
    process.env.BUSINESS_PROFILE_REVIEW_DAYS = "0";
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.BUSINESS_PROFILE_REVIEW_DAYS).toBe(0);
  });

  it("honours a positive override", async () => {
    process.env.BUSINESS_PROFILE_REVIEW_DAYS = "30";
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.BUSINESS_PROFILE_REVIEW_DAYS).toBe(30);
  });

  it("rejects a negative interval", async () => {
    process.env.BUSINESS_PROFILE_REVIEW_DAYS = "-1";
    vi.resetModules();
    await expect(import("./config.js")).rejects.toThrow();
  });
});
