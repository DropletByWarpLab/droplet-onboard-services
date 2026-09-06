/**
 * DROPLET_OTA_RELEASES_URL — a bare `KEY=` line must not crash the boot.
 *
 * This is the only `.url()` key in the whole schema. Zod's `.default()` fires
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
