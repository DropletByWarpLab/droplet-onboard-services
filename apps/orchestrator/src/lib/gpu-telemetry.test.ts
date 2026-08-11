/**
 * WARP-1861 — the orchestrator's device-bridge GPU client.
 *
 * Two properties matter more than the happy path:
 *
 *   1. It NEVER throws. The bridge is profile-gated, so "not running" is an
 *      ordinary state (WARP-645), and this is called from the models page —
 *      an exception here would take down a page that has nothing to do with
 *      the GPU.
 *   2. Absent is null, never zero. A card that cannot be read and a card
 *      sitting at 0% are different facts. On this appliance the first is the
 *      common case: with nothing holding the card, amdgpu runtime-suspends it
 *      and the sysfs reads return EBUSY. A fabricated 0 would sail through
 *      every threshold check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const loggerWarn = vi.hoisted(() => vi.fn());
const loggerDebug = vi.hoisted(() => vi.fn());
vi.mock("pino", () => ({
  default: () => ({
    info: vi.fn(),
    warn: loggerWarn,
    error: vi.fn(),
    debug: loggerDebug,
  }),
}));

vi.mock("../config.js", () => ({
  config: { DEVICE_BRIDGE_URL: "http://bridge.test:9090" },
}));

const bridgeAuthToken = vi.hoisted(() => vi.fn());
vi.mock("./bridge-errors.js", () => ({
  bridgeAuthToken,
  isBridgeConnectionError: (e: unknown) =>
    String((e as Error)?.message).includes("ECONNREFUSED"),
  isTimeoutOrAbort: (e: unknown) => String((e as Error)?.name) === "TimeoutError",
}));

import { bytesToGib, fetchGpuTelemetry } from "./gpu-telemetry.js";

const realFetch = global.fetch;

const SNAPSHOT = {
  available: true,
  card: "card1",
  reason: null,
  busy_percent: 97,
  vram_total_bytes: 17095983104,
  vram_used_bytes: 14190886912,
  vram_used_fraction: 0.83,
  power_watts: 164.0,
  temp_c: 62.0,
  processes: [
    {
      pid: 2325005,
      comm: "llama-server",
      cmdline: "/app/llama-server -ngl 999",
      container_id: "3f9a2b1c4d5e",
    },
  ],
};

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

beforeEach(() => {
  loggerWarn.mockReset();
  loggerDebug.mockReset();
  bridgeAuthToken.mockReturnValue("tok");
});
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("fetchGpuTelemetry", () => {
  it("normalises the bridge's snake_case snapshot", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonRes(SNAPSHOT)) as unknown as typeof fetch;
    const t = await fetchGpuTelemetry();
    expect(t?.available).toBe(true);
    expect(t?.card).toBe("card1");
    expect(t?.busyPercent).toBe(97);
    expect(t?.vramTotalBytes).toBe(17095983104);
    expect(t?.powerWatts).toBe(164);
    expect(t?.tempC).toBe(62);
    expect(t?.processes[0]).toEqual({
      pid: 2325005,
      comm: "llama-server",
      cmdline: "/app/llama-server -ngl 999",
      containerId: "3f9a2b1c4d5e",
    });
  });

  it("sends the bridge token on the documented header", async () => {
    const f = vi.fn().mockResolvedValue(jsonRes(SNAPSHOT));
    global.fetch = f as unknown as typeof fetch;
    await fetchGpuTelemetry();
    expect(f).toHaveBeenCalledWith(
      "http://bridge.test:9090/gpu",
      expect.objectContaining({ headers: { "X-Droplet-Auth": "tok" } }),
    );
  });

  it("returns null without a token instead of calling the bridge", async () => {
    bridgeAuthToken.mockReturnValue("");
    const f = vi.fn();
    global.fetch = f as unknown as typeof fetch;
    await expect(fetchGpuTelemetry()).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("treats an unreachable bridge as ordinary, not an error", async () => {
    // Profile-gated: a box without the bridge is a supported shape, so this
    // must not log at warn level and must not throw.
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("connect ECONNREFUSED")) as unknown as typeof fetch;
    await expect(fetchGpuTelemetry()).resolves.toBeNull();
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(loggerDebug).toHaveBeenCalled();
  });

  it("returns null on a non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonRes({}, false, 503)) as unknown as typeof fetch;
    await expect(fetchGpuTelemetry()).resolves.toBeNull();
  });

  it("returns null on a malformed body rather than a half-built object", async () => {
    // No `available` boolean — we cannot tell what this is, so we say so.
    global.fetch = vi.fn().mockResolvedValue(jsonRes({ card: "card1" })) as unknown as typeof fetch;
    await expect(fetchGpuTelemetry()).resolves.toBeNull();
  });

  it("keeps unreadable counters as null, never coerced to 0", async () => {
    // The runtime-suspended card: present and available, but the driver
    // refuses the reads. 0% here would be a lie every threshold check passes.
    global.fetch = vi.fn().mockResolvedValue(
      jsonRes({ ...SNAPSHOT, busy_percent: null, temp_c: null, power_watts: null }),
    ) as unknown as typeof fetch;
    const t = await fetchGpuTelemetry();
    expect(t?.available).toBe(true);
    expect(t?.busyPercent).toBeNull();
    expect(t?.tempC).toBeNull();
    expect(t?.powerWatts).toBeNull();
  });

  it("carries available:false with its reason", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonRes({ ...SNAPSHOT, available: false, card: null, reason: "no DRM card" }),
    ) as unknown as typeof fetch;
    const t = await fetchGpuTelemetry();
    expect(t?.available).toBe(false);
    expect(t?.reason).toBe("no DRM card");
  });

  it("drops a process row with no pid rather than surfacing a half-null entry", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonRes({ ...SNAPSHOT, processes: [{ comm: "ghost" }, SNAPSHOT.processes[0]] }),
    ) as unknown as typeof fetch;
    const t = await fetchGpuTelemetry();
    expect(t?.processes).toHaveLength(1);
    expect(t?.processes[0].pid).toBe(2325005);
  });

  it("reports a host process as containerId null, not an empty string", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonRes({ ...SNAPSHOT, processes: [{ pid: 42, comm: "rocm-smi", cmdline: "", container_id: null }] }),
    ) as unknown as typeof fetch;
    const t = await fetchGpuTelemetry();
    expect(t?.processes[0].containerId).toBeNull();
  });

  it("tolerates processes missing entirely", async () => {
    const { processes: _drop, ...noProcs } = SNAPSHOT;
    global.fetch = vi.fn().mockResolvedValue(jsonRes(noProcs)) as unknown as typeof fetch;
    const t = await fetchGpuTelemetry();
    expect(t?.processes).toEqual([]);
  });
});

describe("bytesToGib", () => {
  it("converts to 1dp", () => {
    expect(bytesToGib(17095983104)).toBe(15.9);
  });
  it("is null-preserving — an unknown size must not become 0 GB", () => {
    expect(bytesToGib(null)).toBeNull();
  });
});
