/**
 * DROPLET_OTA_RELEASES_URL — a bare `KEY=` line must not crash the boot.
 *
 * This was the only `.url()` key in the whole schema until WARP-3430 added
 * DROPLET_OTA_DOWNLOAD_BASE (covered at the bottom). Zod's `.default()` fires
 * on `undefined` only, so an explicit empty string reaches `.url()` and the
 * hard `envSchema.parse()` throws — the orchestrator never boots. Compose
 * hands fleet-agent exactly that shape (`${DROPLET_OTA_RELEASES_URL:-}`,
 * docker-compose.yml:3431) and services/fleet-agent/README.md documents the
 * key as an operator knob, so an operator setting it in the root `.env` — which
 * the orchestrator inherits via `env_file: ../.env` — can brick the box while
 * fleet-agent's own config.py:157 shrugs the same value off.
 *
 * The schema comment for ANALYTICS_URL states the house rule this restores:
 * "an operator-mangled value must degrade to the no-op façade, never crash the
 * orchestrator boot."
 *
 * Isolated module registry per case, as in config.analytics.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEY = "DROPLET_OTA_RELEASES_URL";
const CANONICAL =
  "https://api.github.com/repos/DropletByWarpLab/droplet-onboard-services/releases/latest";

describe("DROPLET_OTA_RELEASES_URL — empty value degrades to the default", () => {
  let saved: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    saved = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("unset → canonical GitHub releases endpoint", async () => {
    const { config } = await import("./config.js");
    expect(config.DROPLET_OTA_RELEASES_URL).toBe(CANONICAL);
  });

  it("bare `KEY=` (empty) → default, not a boot crash", async () => {
    process.env[KEY] = "";
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.DROPLET_OTA_RELEASES_URL).toBe(CANONICAL);
  });

  it("whitespace-only → default, not a boot crash", async () => {
    process.env[KEY] = "   ";
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.DROPLET_OTA_RELEASES_URL).toBe(CANONICAL);
  });

  it("an explicit override is still honored", async () => {
    process.env[KEY] = "https://example.invalid/repos/x/y/releases/latest";
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.DROPLET_OTA_RELEASES_URL).toBe(
      "https://example.invalid/repos/x/y/releases/latest",
    );
  });
});

/**
 * WARP-3430 — DROPLET_OTA_DOWNLOAD_BASE is the schema's second `.url()` and has
 * the same trap, worse: docker-compose.yml hands the orchestrator
 * `${DROPLET_OTA_DOWNLOAD_BASE:-}`, a defined-but-empty string on EVERY box
 * that never set it — i.e. the whole fleet. A bare value must resolve to the
 * canonical publisher, not kill the boot.
 */
describe("DROPLET_OTA_DOWNLOAD_BASE — empty value degrades to the default (WARP-3430)", () => {
  const DL_KEY = "DROPLET_OTA_DOWNLOAD_BASE";
  const DL_CANONICAL =
    "https://github.com/DropletByWarpLab/droplet-onboard-services/releases/download";
  let saved: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    saved = process.env[DL_KEY];
    delete process.env[DL_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[DL_KEY];
    else process.env[DL_KEY] = saved;
  });

  it("unset → the canonical release-download base", async () => {
    const { config } = await import("./config.js");
    expect(config.DROPLET_OTA_DOWNLOAD_BASE).toBe(DL_CANONICAL);
  });

  it("compose's `${KEY:-}` (empty) → default, not a boot crash", async () => {
    process.env[DL_KEY] = "";
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.DROPLET_OTA_DOWNLOAD_BASE).toBe(DL_CANONICAL);
  });

  it("whitespace-only → default, not a boot crash", async () => {
    process.env[DL_KEY] = "   ";
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.DROPLET_OTA_DOWNLOAD_BASE).toBe(DL_CANONICAL);
  });

  it("an explicit mirror is honored", async () => {
    process.env[DL_KEY] = "https://mirror.example.invalid/ota/download";
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.DROPLET_OTA_DOWNLOAD_BASE).toBe("https://mirror.example.invalid/ota/download");
  });

  it("a non-URL value is still refused at boot (validated, not just defaulted)", async () => {
    process.env[DL_KEY] = "not a url";
    vi.resetModules();
    await expect(import("./config.js")).rejects.toThrow();
  });
});
