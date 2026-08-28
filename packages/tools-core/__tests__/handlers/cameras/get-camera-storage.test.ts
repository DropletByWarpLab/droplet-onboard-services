/**
 * WARP-1850 — `get_camera_storage` LLM tool.
 *
 * Per-camera NVR disk usage via the orchestrator's
 * `GET /api/cameras/storage`. Tier-1 read — no writes, no confirmation.
 *
 * The behaviour worth pinning is what the tool does when it CAN'T measure.
 * Unlike `/api/cameras/system`, the storage route answers 503 rather than
 * degrading to an empty body, because "no cameras are using disk" is a
 * dangerously reassuring thing to tell an operator (or a model) when the
 * truth is "we couldn't look". Same reasoning that made WARP-1849's dead
 * purge invisible for its whole life.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getCameraStorage from "../../../src/handlers/cameras/get-camera-storage.js";
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

const MIB = 1024 * 1024;

const STORAGE = {
  volume: {
    path: "/media/frigate/recordings",
    totalBytes: 1000 * 1024 * MIB,
    usedBytes: 100 * 1024 * MIB,
    freeBytes: 900 * 1024 * MIB,
    usedPercent: 10,
  },
  cameras: [
    {
      camera: "front_door",
      usedBytes: 60 * 1024 * MIB,
      bytesPerHour: 500 * MIB,
      sharePercent: 6,
      daysAtCurrentRate: 5.1,
    },
    {
      camera: "new_cam",
      usedBytes: null,
      bytesPerHour: null,
      sharePercent: null,
      daysAtCurrentRate: null,
    },
  ],
  nearFull: false,
  totalBytesPerHour: 500 * MIB,
};

function ok(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

describe("get_camera_storage", () => {
  it("is a read-only tool needing no confirmation", () => {
    expect(getCameraStorage.requiresWrite).toBe(false);
    expect(getCameraStorage.requiresConfirmation).toBe(false);
  });

  it("reports per-camera usage from the orchestrator", async () => {
    const get = ok(STORAGE);
    const res = await getCameraStorage.handler({}, ctxWith(get));

    expect(get).toHaveBeenCalledWith("/api/cameras/storage", expect.anything());
    expect(res.ok).toBe(true);
    const data = (res as { data: any }).data;
    expect(data.type).toBe("get_camera_storage");
    expect(data.cameras[0].camera).toBe("front_door");
    expect(data.cameras[0].usedBytes).toBe(60 * 1024 * MIB);
    expect(data.volume.usedPercent).toBe(10);
  });

  it("passes null through instead of reporting a camera as using zero", async () => {
    const res = await getCameraStorage.handler({}, ctxWith(ok(STORAGE)));
    const data = (res as { data: any }).data;

    expect(data.cameras[1].usedBytes).toBeNull();
    expect(data.cameras[1].usedBytes).not.toBe(0);
    expect(data.cameras[1].bytesPerHour).toBeNull();
  });

  it("carries the near-full flag through", async () => {
    const res = await getCameraStorage.handler(
      {},
      ctxWith(ok({ ...STORAGE, nearFull: true })),
    );
    expect((res as { data: any }).data.nearFull).toBe(true);
  });

  it("errors — not an empty success — when storage is unavailable", async () => {
    const get = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const res = await getCameraStorage.handler({}, ctxWith(get));

    expect(res.ok).toBe(false);
    const err = (res as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("STORAGE_UNAVAILABLE");
    // The message must actively warn against the zero-usage misreading.
    expect(err.message).toMatch(/not a report that cameras are using no space/);
  });

  it("errors when the orchestrator is unreachable", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await getCameraStorage.handler({}, ctxWith(get));

    expect(res.ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("STORAGE_UNAVAILABLE");
  });

  it("errors on an unexpected response shape rather than inventing rows", async () => {
    const res = await getCameraStorage.handler({}, ctxWith(ok("not an object")));

    expect(res.ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("STORAGE_UNAVAILABLE");
  });

  it("returns an empty camera list when nothing is recording", async () => {
    const res = await getCameraStorage.handler(
      {},
      ctxWith(ok({ volume: null, cameras: [], nearFull: false, totalBytesPerHour: null })),
    );

    expect(res.ok).toBe(true);
    const data = (res as { data: any }).data;
    expect(data.cameras).toEqual([]);
    expect(data.totalBytesPerHour).toBeNull();
  });
});
