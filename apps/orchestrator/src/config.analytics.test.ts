/**
 * WARP-615 — fleet-analytics agent config (`ANALYTICS_*`).
 *
 * The analytics agent is fail-open and OFF by default: a box that never heard
 * of the fleet portal must parse config cleanly and run exactly as before.
 * Pin the documented defaults (ticket scope + portal contract E6: local
 * portal URL) and the explicit string→bool idiom for ANALYTICS_ENABLED —
 * `z.coerce.boolean()` would treat the non-empty strings "0"/"false" as true
 * and silently enable telemetry (same foot-gun as DROPLET_CLAIM_GATE_ENABLED).
 *
 * Loading config.ts is environment-sensitive, so each case imports it in an
 * isolated module registry with a controlled process.env (same approach as
 * config.shared-folder.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const VARS = [
  "ANALYTICS_ENABLED",
  "ANALYTICS_URL",
  "ANALYTICS_INGEST_TOKEN",
  "ANALYTICS_PROVISIONING_CODE",
  "ANALYTICS_MACHINE_TIER",
  "ANALYTICS_HEARTBEAT_INTERVAL_S",
  "ANALYTICS_METRICS_FLUSH_S",
  "ANALYTICS_EVENTS_FLUSH_S",
  "ANALYTICS_ERROR_DEDUP_WINDOW_S",
] as const;

describe("WARP-615 — ANALYTICS_* config", () => {
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

  it("defaults: disabled, local portal URL, empty credentials, home tier, documented cadences", async () => {
    const { config } = await import("./config.js");
    expect(config.ANALYTICS_ENABLED).toBe(false);
    expect(config.ANALYTICS_URL).toBe(
      "http://host.docker.internal:3000/api/v1",
    );
    expect(config.ANALYTICS_INGEST_TOKEN).toBe("");
    expect(config.ANALYTICS_PROVISIONING_CODE).toBe("");
    expect(config.ANALYTICS_MACHINE_TIER).toBe("home");
    expect(config.ANALYTICS_HEARTBEAT_INTERVAL_S).toBe(30);
    expect(config.ANALYTICS_METRICS_FLUSH_S).toBe(60);
    expect(config.ANALYTICS_EVENTS_FLUSH_S).toBe(5);
    expect(config.ANALYTICS_ERROR_DEDUP_WINDOW_S).toBe(60);
  });

  it('ANALYTICS_ENABLED stays OFF for the explicit falsey strings "0" and "false"', async () => {
    process.env.ANALYTICS_ENABLED = "0";
    vi.resetModules();
    let { config } = await import("./config.js");
    expect(config.ANALYTICS_ENABLED).toBe(false);

    process.env.ANALYTICS_ENABLED = "false";
    vi.resetModules();
    ({ config } = await import("./config.js"));
    expect(config.ANALYTICS_ENABLED).toBe(false);
  });

  it('ANALYTICS_ENABLED turns ON only for "1"/"true"', async () => {
    process.env.ANALYTICS_ENABLED = "1";
    vi.resetModules();
    let { config } = await import("./config.js");
    expect(config.ANALYTICS_ENABLED).toBe(true);

    process.env.ANALYTICS_ENABLED = "true";
    vi.resetModules();
    ({ config } = await import("./config.js"));
    expect(config.ANALYTICS_ENABLED).toBe(true);
  });

  it("honours explicit overrides for URL, credentials, and cadences", async () => {
    process.env.ANALYTICS_URL = "https://analytics.warp-lab.ai/api/v1";
    process.env.ANALYTICS_INGEST_TOKEN = "dpl_01J9MZ_secret";
    process.env.ANALYTICS_PROVISIONING_CODE = "prov-123";
    process.env.ANALYTICS_MACHINE_TIER = "business";
    process.env.ANALYTICS_HEARTBEAT_INTERVAL_S = "45";
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.ANALYTICS_URL).toBe("https://analytics.warp-lab.ai/api/v1");
    expect(config.ANALYTICS_INGEST_TOKEN).toBe("dpl_01J9MZ_secret");
    expect(config.ANALYTICS_PROVISIONING_CODE).toBe("prov-123");
    expect(config.ANALYTICS_MACHINE_TIER).toBe("business");
    expect(config.ANALYTICS_HEARTBEAT_INTERVAL_S).toBe(45);
  });
});
