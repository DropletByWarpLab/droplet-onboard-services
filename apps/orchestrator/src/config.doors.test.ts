/**
 * ADR-055 (P4a) — `DOORS_ENABLED` and `DOORS_EVENT_RETENTION_DAYS`.
 *
 * DOORS_ENABLED is the EXPLICIT switch that makes the doors module present or
 * absent, following DOCS_ENABLED: never derived from another variable's
 * emptiness, and `z.coerce.boolean()` would read the string "0" as true and
 * switch a dark module on. It defaults OFF (the module ships dark).
 *
 * Loading config.ts is environment-sensitive, so each case imports it in an
 * isolated module registry with a controlled process.env (the approach of
 * config.analytics.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const VARS = ["DOORS_ENABLED", "DOORS_EVENT_RETENTION_DAYS"] as const;

describe("ADR-055 — DOORS_* config", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  async function load() {
    vi.resetModules();
    return (await import("./config.js")).config;
  }

  it("defaults: dark, and 365 days of events (Stefan, 2026-09-29)", async () => {
    const config = await load();
    expect(config.DOORS_ENABLED).toBe(false);
    expect(config.DOORS_EVENT_RETENTION_DAYS).toBe(365);
  });

  it.each(["1", "true", "TRUE", " True "])("DOORS_ENABLED=%j turns it on", async (value) => {
    process.env.DOORS_ENABLED = value;
    expect((await load()).DOORS_ENABLED).toBe(true);
  });

  it.each(["0", "false", "no", "off", "", "  ", "yes", "on", "2", "enabled"])(
    "DOORS_ENABLED=%j stays OFF — only 1 / true enable (an explicit switch, never a guess)",
    async (value) => {
      process.env.DOORS_ENABLED = value;
      expect((await load()).DOORS_ENABLED).toBe(false);
    },
  );

  it("is not derived from any other variable: setting DOORS_EVENT_RETENTION_DAYS does not enable it", async () => {
    process.env.DOORS_EVENT_RETENTION_DAYS = "30";
    const config = await load();
    expect(config.DOORS_ENABLED).toBe(false);
    expect(config.DOORS_EVENT_RETENTION_DAYS).toBe(30);
  });

  it("a blank retention (compose's `${VAR:-}`) is the default, not zero days", async () => {
    process.env.DOORS_EVENT_RETENTION_DAYS = "";
    expect((await load()).DOORS_EVENT_RETENTION_DAYS).toBe(365);
  });

  it.each(["0", "-5", "1.5", "abc", "3651"])(
    "DOORS_EVENT_RETENTION_DAYS=%j is refused at startup, not silently 'keep forever' or 'delete now'",
    async (value) => {
      process.env.DOORS_EVENT_RETENTION_DAYS = value;
      await expect(load()).rejects.toThrow();
    },
  );
});
