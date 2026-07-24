/**
 * WARP-1509 — DROPLET_MATTER_WIFI_SSID_FILE defaults to /etc/droplet/ap-ssid.
 *
 * Live-box triage (2026-07-23): the AP renamed itself to "Warp", but every
 * Matter commission still handed devices the stale "WarpLab" from
 * DROPLET_MATTER_WIFI_SSID. resolveWifiSsid() (controller.ts) already
 * resolves file-first — see the WARP-1363 coverage in controller.test.ts —
 * but only when it's HANDED a file path. That path came exclusively from
 * DROPLET_MATTER_WIFI_SSID_FILE, which only lands in .env when
 * scripts/lib/single-box.sh's configure_single_box_env has (re-)run since
 * WARP-1363 shipped. A box updated by `git pull` + rebuild without a fresh
 * `setup.sh --single-box` never gets that key — and docker-compose's
 * `${DROPLET_MATTER_WIFI_SSID_FILE:-}` interpolation still hands the
 * container an explicitly-EMPTY env var (not an absent one) in that case,
 * so the file-first logic never even attempts the read.
 *
 * The fix defaults the resolved path to /etc/droplet/ap-ssid in code —
 * the compose mount (`/etc/droplet:/etc/droplet:ro`) already exposes that
 * file read-only, so no new env var or setup.sh dependency is needed — while
 * still honouring an explicit override. Loading config.ts is
 * environment-sensitive, so each case imports it in an isolated module
 * registry with a controlled process.env (same approach
 * apps/orchestrator/src/config.shared-folder.test.ts uses).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("WARP-1509 — DROPLET_MATTER_WIFI_SSID_FILE default", () => {
  const original = process.env.DROPLET_MATTER_WIFI_SSID_FILE;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.DROPLET_MATTER_WIFI_SSID_FILE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.DROPLET_MATTER_WIFI_SSID_FILE;
    else process.env.DROPLET_MATTER_WIFI_SSID_FILE = original;
  });

  it("defaults to /etc/droplet/ap-ssid when the env var is unset", async () => {
    const { config } = await import("../src/config.js");
    expect(config.DROPLET_MATTER_WIFI_SSID_FILE).toBe("/etc/droplet/ap-ssid");
  });

  it("defaults to /etc/droplet/ap-ssid when the env var is an explicit empty string (the shape docker-compose's ${VAR:-} interpolation produces when .env never set it)", async () => {
    process.env.DROPLET_MATTER_WIFI_SSID_FILE = "";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.DROPLET_MATTER_WIFI_SSID_FILE).toBe("/etc/droplet/ap-ssid");
  });

  it("defaults to /etc/droplet/ap-ssid when the env var is whitespace-only", async () => {
    process.env.DROPLET_MATTER_WIFI_SSID_FILE = "   ";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.DROPLET_MATTER_WIFI_SSID_FILE).toBe("/etc/droplet/ap-ssid");
  });

  it("honours an explicit non-empty override", async () => {
    process.env.DROPLET_MATTER_WIFI_SSID_FILE = "/custom/ap-ssid";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.DROPLET_MATTER_WIFI_SSID_FILE).toBe("/custom/ap-ssid");
  });
});
