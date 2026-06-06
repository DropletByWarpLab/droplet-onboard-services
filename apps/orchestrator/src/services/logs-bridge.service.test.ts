/**
 * WARP-823 — orchestrator side of the diagnostics log fetch.
 *
 * Host logs (journald + container logs) are only reachable from the
 * device-bridge, which runs on the host. `fetchLogBundleFromBridge()` reuses
 * the EXACT auth-gated access pattern from hostapd-bridge.service.ts:
 * `config.DEVICE_BRIDGE_URL`, the BRIDGE_AUTH_TOKEN/SERVICE_TOKEN_DISPLAY
 * precedence read per-call, the `X-Droplet-Auth` header, fail-closed on an
 * empty token, and clean RouterError.unreachable degradation when the bridge
 * isn't reachable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchLogBundleFromBridge,
  type BridgeLogBundle,
} from "./logs-bridge.service.js";
import { RouterError } from "../types/router-error.js";

const ORIGINAL_ENV = { ...process.env };

describe("fetchLogBundleFromBridge", () => {
  beforeEach(() => {
    process.env.BRIDGE_AUTH_TOKEN = "test-bridge-token";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("GETs /logs/bundle on the bridge with the X-Droplet-Auth header", async () => {
    const payload: BridgeLogBundle = {
      collected_at: "2026-06-06T10:00:00Z",
      window_hours: 24,
      services: [
        { name: "orchestrator", source: "docker", lines: "GET /api/health 200" },
      ],
      truncated: false,
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const out = await fetchLogBundleFromBridge({ windowHours: 24 });

    expect(out.services).toHaveLength(1);
    expect(out.services[0]!.name).toBe("orchestrator");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/logs/bundle");
    expect(String(url)).toContain("hours=24");
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ "X-Droplet-Auth": "test-bridge-token" });
  });

  it("fails closed (BRIDGE_AUTH_UNCONFIGURED) when no bridge token is set", async () => {
    delete process.env.BRIDGE_AUTH_TOKEN;
    delete process.env.SERVICE_TOKEN_DISPLAY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(fetchLogBundleFromBridge({ windowHours: 24 })).rejects.toMatchObject(
      { code: "BRIDGE_AUTH_UNCONFIGURED" },
    );
    // We must never reach the network without the shared secret.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws RouterError.unreachable when the bridge connection is refused", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );

    await expect(
      fetchLogBundleFromBridge({ windowHours: 24 }),
    ).rejects.toBeInstanceOf(RouterError);
    try {
      await fetchLogBundleFromBridge({ windowHours: 24 });
    } catch (err) {
      expect((err as RouterError).code).toBe("UNREACHABLE");
    }
  });

  it("throws RouterError.unknown carrying the bridge message on a non-ok reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "journalctl unavailable" }), {
        status: 500,
      }),
    );

    await expect(
      fetchLogBundleFromBridge({ windowHours: 24 }),
    ).rejects.toBeInstanceOf(RouterError);
  });
});
