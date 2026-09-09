/**
 * WARP-1440 — `get_camera_health` LLM tool.
 *
 * Camera-system health via the orchestrator's `GET /api/cameras/system`
 * (typed wrapper over Frigate /api/stats + /api/version): per-camera
 * stream fps/status plus detector/GPU/uptime. Tier-1 read — no writes,
 * no confirmation.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getCameraHealth from "../../../src/handlers/cameras/get-camera-health.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(orchestratorGet: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: {
        get: orchestratorGet,
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

// CameraSystemStatus as served by GET /api/cameras/system (the route
// wraps it as { status: ... }).
const SYSTEM_STATUS = {
  version: "0.14.1-f3a8b2",
  uptimeSec: 86400,
  cameraCount: 2,
  camerasLive: 1,
  cameraFps: [
    { name: "front_door", cameraFps: 5.1, detectionFps: 5.0, skippedFps: 0 },
    { name: "garage", cameraFps: 0, detectionFps: 0, skippedFps: 0 },
  ],
  detectors: [{ name: "tensorrt", inferenceSpeedMs: 8.2, pid: 423 }],
  gpus: [{ name: "nvidia-0", gpuPct: 17.5, memPct: 31.2, tempC: 54 }],
  storage: [
    {
      path: "/media/frigate/recordings",
      totalBytes: 2_000_000_000_000,
      usedBytes: 500_000_000_000,
      freeBytes: 1_500_000_000_000,
      mountType: "recordings",
    },
  ],
  cpuPct: 42.7,
};

function jsonGet(body: unknown, status = 200): Mock {
  // Fresh Response per call — a Response body can only be read once.
  return vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
    );
}

function expectError(
  res: Awaited<ReturnType<typeof getCameraHealth.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("get_camera_health", () => {
  it("fetches /api/cameras/system and shapes per-camera + system health", async () => {
    const get = jsonGet({ status: SYSTEM_STATUS });
    const ctx = ctxWith(get);

    const res = await getCameraHealth.handler({}, ctx);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/cameras/system", {
      headers: { Accept: "application/json" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "get_camera_health",
        cameras: [
          {
            name: "front_door",
            status: "streaming",
            cameraFps: 5.1,
            detectionFps: 5.0,
            skippedFps: 0,
          },
          {
            name: "garage",
            status: "no_signal",
            cameraFps: 0,
            detectionFps: 0,
            skippedFps: 0,
          },
        ],
        system: {
          version: SYSTEM_STATUS.version,
          uptimeSec: SYSTEM_STATUS.uptimeSec,
          cameraCount: SYSTEM_STATUS.cameraCount,
          camerasLive: SYSTEM_STATUS.camerasLive,
          cpuPct: SYSTEM_STATUS.cpuPct,
          detectors: SYSTEM_STATUS.detectors,
          gpus: SYSTEM_STATUS.gpus,
          storage: SYSTEM_STATUS.storage,
        },
      });
    }
  });

  it("filters to a single camera when `camera` is given", async () => {
    const get = jsonGet({ status: SYSTEM_STATUS });
    const res = await getCameraHealth.handler(
      { camera: "garage" },
      ctxWith(get),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { cameras: Array<{ name: string; status: string }> };
      expect(data.cameras).toHaveLength(1);
      expect(data.cameras[0]).toEqual({
        name: "garage",
        status: "no_signal",
        cameraFps: 0,
        detectionFps: 0,
        skippedFps: 0,
      });
    }
  });

  it("returns CAMERA_NOT_FOUND for an unknown camera without a second round-trip", async () => {
    const get = jsonGet({ status: SYSTEM_STATUS });
    const res = await getCameraHealth.handler(
      { camera: "backyard" },
      ctxWith(get),
    );
    expectError(res, "CAMERA_NOT_FOUND");
    expect(get).toHaveBeenCalledTimes(1);
    if (!res.ok) {
      expect(res.error.message).toContain("backyard");
    }
  });

  it("maps a non-OK response to HEALTH_UNAVAILABLE", async () => {
    const get = jsonGet({ error: "boom" }, 502);
    const res = await getCameraHealth.handler({}, ctxWith(get));
    expectError(res, "HEALTH_UNAVAILABLE");
  });

  it("maps a thrown fetch error to HEALTH_UNAVAILABLE", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await getCameraHealth.handler({}, ctxWith(get));
    expectError(res, "HEALTH_UNAVAILABLE");
  });

  it("maps a payload with no `status` block to HEALTH_UNAVAILABLE", async () => {
    const get = jsonGet({ nope: true });
    const res = await getCameraHealth.handler({}, ctxWith(get));
    expectError(res, "HEALTH_UNAVAILABLE");
  });

  it("rejects a non-string camera with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await getCameraHealth.handler({ camera: 42 }, ctxWith(get));
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects an empty camera with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await getCameraHealth.handler({ camera: "  " }, ctxWith(get));
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects an invalid camera name with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await getCameraHealth.handler(
      { camera: "front door!" },
      ctxWith(get),
    );
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("get_camera_health — tool metadata", () => {
  it("is named get_camera_health and is Tier-1 (no write, no confirm)", () => {
    expect(getCameraHealth.name).toBe("get_camera_health");
    expect(getCameraHealth.requiresWrite).toBe(false);
    expect(getCameraHealth.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false schema with only the optional camera", () => {
    const schema = getCameraHealth.inputSchema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toBeUndefined();
    expect(Object.keys(schema.properties ?? {})).toEqual(["camera"]);
  });
});
