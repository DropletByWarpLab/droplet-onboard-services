/**
 * WARP-3511 — `getCameras` carries a `recording` block per camera, and says so
 * when Frigate could not be read instead of silently reporting every camera
 * offline.
 *
 * Frigate and the cache are mocked at the module boundary; the DB is a stub.
 * What is under test is the assembly: which camera gets which reading, how
 * many Frigate calls a refresh costs, and what a failed reading turns into.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  fetchCameras: vi.fn(),
  fetchConfig: vi.fn(),
  fetchRecordingsStorage: vi.fn(),
  fetchLastRecordingEnd: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}));

vi.mock("./frigate.client.js", () => ({
  fetchCameras: h.fetchCameras,
  fetchConfig: h.fetchConfig,
  fetchRecordingsStorage: h.fetchRecordingsStorage,
  fetchLastRecordingEnd: h.fetchLastRecordingEnd,
}));

vi.mock("./cache.service.js", () => ({
  cacheGet: h.cacheGet,
  cacheSet: h.cacheSet,
  cacheDel: h.cacheDel,
}));

import { getCameras } from "./camera.service.js";

const MIB = 1024 * 1024;

function dbCam(name: string, over: Record<string, unknown> = {}) {
  return {
    id: `id-${name}`,
    name,
    displayName: name.replace(/_/g, " "),
    manufacturer: null,
    model: null,
    ipAddress: "192.168.20.10",
    macAddress: null,
    enabled: true,
    autoDiscovered: false,
    lastSeen: new Date("2026-10-03T10:00:00Z"),
    createdAt: new Date("2026-10-01T10:00:00Z"),
    ...over,
  };
}

function prismaWith(cams: ReturnType<typeof dbCam>[]) {
  return { camera: { findMany: vi.fn().mockResolvedValue(cams) } } as never;
}

/** Frigate 0.17's resolved `record` block, windows in days. */
function recordBlock(w: { c?: number; m?: number; a?: number; d?: number; enabled?: boolean }) {
  return {
    record: {
      enabled: w.enabled ?? true,
      continuous: { days: w.c ?? 0 },
      motion: { days: w.m ?? 0 },
      alerts: { retain: { days: w.a ?? 0 } },
      detections: { retain: { days: w.d ?? 0 } },
    },
  };
}

const STREAMING = { camera_fps: 5, detection_fps: 5 };

beforeEach(() => {
  vi.resetAllMocks();
  h.cacheGet.mockResolvedValue(null);
  h.cacheSet.mockResolvedValue(undefined);
  h.fetchRecordingsStorage.mockResolvedValue({});
  h.fetchLastRecordingEnd.mockResolvedValue(null);
});

describe("getCameras — the recording block", () => {
  it.each([
    ["continuous", { c: 3, m: 30, a: 14, d: 14 }],
    ["motion", { m: 30, a: 14, d: 14 }],
    ["events", { a: 14, d: 14 }],
    ["off", {}],
  ] as const)("mode %s comes from the camera's own retention windows", async (mode, windows) => {
    h.fetchCameras.mockResolvedValue({ front_door: STREAMING });
    h.fetchConfig.mockResolvedValue({ cameras: { front_door: recordBlock(windows) } });

    const [cam] = await getCameras(prismaWith([dbCam("front_door")]));

    expect(cam.recording.mode).toBe(mode);
    expect(cam.recording.degraded).toBe(false);
  });

  it("reports each window's days as configured, so the UI never has to hard-code them", async () => {
    h.fetchCameras.mockResolvedValue({ front_door: STREAMING });
    h.fetchConfig.mockResolvedValue({
      cameras: { front_door: recordBlock({ c: 7, m: 21, a: 10, d: 5 }) },
    });

    const [cam] = await getCameras(prismaWith([dbCam("front_door")]));

    expect(cam.recording.retentionDays).toEqual({ continuous: 7, motion: 21, alerts: 10, detections: 5 });
  });

  it("takes usage and the daily rate from Frigate's storage endpoint", async () => {
    h.fetchCameras.mockResolvedValue({ front_door: STREAMING });
    h.fetchConfig.mockResolvedValue({ cameras: { front_door: recordBlock({ c: 3 }) } });
    h.fetchRecordingsStorage.mockResolvedValue({
      front_door: { usage: 2048, bandwidth: 1000 },
    });

    const [cam] = await getCameras(prismaWith([dbCam("front_door")]));

    expect(cam.recording.usedBytes).toBe(2048 * MIB);
    expect(cam.recording.bytesPerDay).toBe(1000 * MIB * 24);
  });

  it("costs ONE storage call however many cameras there are", async () => {
    h.fetchCameras.mockResolvedValue({ a: STREAMING, b: STREAMING, c: STREAMING });
    h.fetchConfig.mockResolvedValue({
      cameras: { a: recordBlock({ c: 3 }), b: recordBlock({ c: 3 }), c: recordBlock({ c: 3 }) },
    });

    await getCameras(prismaWith([dbCam("a"), dbCam("b"), dbCam("c")]));

    expect(h.fetchRecordingsStorage).toHaveBeenCalledTimes(1);
  });

  it("resolves storage rows Frigate keyed by friendly_name, so that camera is not left blank", async () => {
    h.fetchCameras.mockResolvedValue({ front_door: STREAMING });
    h.fetchConfig.mockResolvedValue({
      cameras: { front_door: { ...recordBlock({ c: 3 }), friendly_name: "Front Door" } },
    });
    h.fetchRecordingsStorage.mockResolvedValue({ "Front Door": { usage: 10, bandwidth: 2 } });

    const [cam] = await getCameras(prismaWith([dbCam("front_door")]));

    expect(cam.recording.usedBytes).toBe(10 * MIB);
  });

  it("a camera with no segments yet has null usage — not zero", async () => {
    h.fetchCameras.mockResolvedValue({ front_door: STREAMING });
    h.fetchConfig.mockResolvedValue({ cameras: { front_door: recordBlock({ c: 3 }) } });
    h.fetchRecordingsStorage.mockResolvedValue({ front_door: { usage: null, bandwidth: 0 } });

    const [cam] = await getCameras(prismaWith([dbCam("front_door")]));

    expect(cam.recording.usedBytes).toBeNull();
    expect(cam.recording.bytesPerDay).toBeNull();
  });
});

describe("getCameras — when the last segment landed", () => {
  it("asks Frigate for the newest segment of a camera that is streaming and keeping footage", async () => {
    h.fetchCameras.mockResolvedValue({ front_door: STREAMING });
    h.fetchConfig.mockResolvedValue({ cameras: { front_door: recordBlock({ c: 3 }) } });
    h.fetchLastRecordingEnd.mockResolvedValue(1_791_000_000);

    const [cam] = await getCameras(prismaWith([dbCam("front_door")]));

    expect(h.fetchLastRecordingEnd).toHaveBeenCalledWith("front_door", expect.any(Object));
    expect(cam.recording.lastSegmentAt).toBe(new Date(1_791_000_000 * 1000).toISOString());
  });

  it("does not probe cameras it can tell are not writing: offline, or keeping nothing", async () => {
    h.fetchCameras.mockResolvedValue({ keeps: STREAMING, nothing: STREAMING });
    h.fetchConfig.mockResolvedValue({
      cameras: {
        keeps: recordBlock({ c: 3 }),
        nothing: recordBlock({}),
        gone: recordBlock({ c: 3 }),
      },
    });

    await getCameras(prismaWith([dbCam("keeps"), dbCam("nothing"), dbCam("gone")]));

    expect(h.fetchLastRecordingEnd.mock.calls.map((c) => c[0])).toEqual(["keeps"]);
  });

  it("a failed probe leaves that camera's time unknown — it does not fail or degrade the list", async () => {
    h.fetchCameras.mockResolvedValue({ a: STREAMING, b: STREAMING });
    h.fetchConfig.mockResolvedValue({
      cameras: { a: recordBlock({ c: 3 }), b: recordBlock({ c: 3 }) },
    });
    h.fetchLastRecordingEnd.mockImplementation(async (name: string) => {
      if (name === "a") throw new Error("Frigate recordings: 500");
      return 1_791_000_000;
    });

    const cams = await getCameras(prismaWith([dbCam("a"), dbCam("b")]));

    expect(cams[0].recording.lastSegmentAt).toBeNull();
    expect(cams[0].recording.lastSegmentReadFailed).toBe(true);
    expect(cams[0].recording.degraded).toBe(false);
    expect(cams[1].recording.lastSegmentAt).not.toBeNull();
    expect(cams[1].recording.lastSegmentReadFailed).not.toBe(true);
  });

  it("a failed storage read leaves usage unknown — it does not degrade the block", async () => {
    h.fetchCameras.mockResolvedValue({ front_door: STREAMING });
    h.fetchConfig.mockResolvedValue({ cameras: { front_door: recordBlock({ c: 3 }) } });
    h.fetchRecordingsStorage.mockRejectedValue(new Error("Frigate recordings storage: 500"));

    const [cam] = await getCameras(prismaWith([dbCam("front_door")]));

    expect(cam.recording.usedBytes).toBeNull();
    expect(cam.recording.degraded).toBe(false);
    expect(cam.recording.mode).toBe("continuous");
  });
});

describe("getCameras — Frigate cannot be read", () => {
  it("flags every camera degraded instead of silently reporting them offline", async () => {
    h.fetchCameras.mockRejectedValue(new Error("fetch failed"));
    h.fetchConfig.mockRejectedValue(new Error("fetch failed"));

    const cams = await getCameras(prismaWith([dbCam("a"), dbCam("b")]));

    expect(cams).toHaveLength(2);
    for (const cam of cams) {
      expect(cam.status).toBe("offline");
      expect(cam.recording).toMatchObject({ degraded: true, mode: null, retentionDays: null });
    }
  });

  it("does not cache a degraded list, so it heals on the next poll", async () => {
    h.fetchCameras.mockRejectedValue(new Error("fetch failed"));
    h.fetchConfig.mockRejectedValue(new Error("fetch failed"));

    await getCameras(prismaWith([dbCam("a")]));

    expect(h.cacheSet).not.toHaveBeenCalled();
  });

  it("a config-only failure is degraded too, and does NOT invent 'live · not saving'", async () => {
    // With no config, retention is unknown. The old code read "unknown" as
    // "keeps nothing" and put a false amber warning on a healthy camera.
    h.fetchCameras.mockResolvedValue({ front_door: STREAMING });
    h.fetchConfig.mockRejectedValue(new Error("Frigate config: 503"));

    const [cam] = await getCameras(prismaWith([dbCam("front_door")]));

    expect(cam.recording.degraded).toBe(true);
    expect(cam.status).not.toBe("live");
    expect(h.cacheSet).not.toHaveBeenCalled();
  });

  it("a stats-only failure is degraded too", async () => {
    h.fetchCameras.mockRejectedValue(new Error("Frigate stats: 502"));
    h.fetchConfig.mockResolvedValue({ cameras: { front_door: recordBlock({ c: 3 }) } });

    const [cam] = await getCameras(prismaWith([dbCam("front_door")]));

    expect(cam.recording.degraded).toBe(true);
    expect(cam.status).toBe("offline");
  });

  it("makes no per-camera probes or storage reads it cannot interpret", async () => {
    h.fetchCameras.mockRejectedValue(new Error("fetch failed"));
    h.fetchConfig.mockRejectedValue(new Error("fetch failed"));

    await getCameras(prismaWith([dbCam("a")]));

    expect(h.fetchLastRecordingEnd).not.toHaveBeenCalled();
  });
});

describe("getCameras — caching and the cameras Frigate knows that the DB does not", () => {
  it("caches a healthy list for the usual five seconds", async () => {
    h.fetchCameras.mockResolvedValue({ front_door: STREAMING });
    h.fetchConfig.mockResolvedValue({ cameras: { front_door: recordBlock({ c: 3 }) } });

    await getCameras(prismaWith([dbCam("front_door")]));

    expect(h.cacheSet).toHaveBeenCalledWith("cameras:list", expect.any(Array), 5);
  });

  it("serves the cache without touching Frigate", async () => {
    h.cacheGet.mockResolvedValue([{ name: "cached" }]);

    const cams = await getCameras(prismaWith([]));

    expect(cams).toEqual([{ name: "cached" }]);
    expect(h.fetchCameras).not.toHaveBeenCalled();
    expect(h.fetchRecordingsStorage).not.toHaveBeenCalled();
  });

  it("a Frigate-only camera (not in the DB) gets a recording block as well", async () => {
    h.fetchCameras.mockResolvedValue({ stray: STREAMING });
    h.fetchConfig.mockResolvedValue({ cameras: { stray: recordBlock({ m: 10 }) } });

    const cams = await getCameras(prismaWith([]));

    expect(cams).toHaveLength(1);
    expect(cams[0].recording.mode).toBe("motion");
  });
});

describe("getCameras — status derivation is unchanged (WARP-1974)", () => {
  it.each([
    ["keeps footage, objects tracked", { camera_fps: 5, detection_fps: 5 }, { c: 3 }, "detecting"],
    ["keeps footage, no detection", { camera_fps: 5, detection_fps: 0 }, { c: 3 }, "recording"],
    ["streams but keeps nothing", { camera_fps: 5, detection_fps: 5 }, {}, "live"],
    ["connected, no frames", { camera_fps: 0, detection_fps: 0 }, { c: 3 }, "idle"],
  ] as const)("%s → %s", async (_label, stats, windows, expected) => {
    h.fetchCameras.mockResolvedValue({ front_door: stats });
    h.fetchConfig.mockResolvedValue({ cameras: { front_door: recordBlock(windows) } });

    const [cam] = await getCameras(prismaWith([dbCam("front_door")]));

    expect(cam.status).toBe(expected);
  });

  it("a camera Frigate does not see is offline", async () => {
    h.fetchCameras.mockResolvedValue({});
    h.fetchConfig.mockResolvedValue({ cameras: { front_door: recordBlock({ c: 3 }) } });

    const [cam] = await getCameras(prismaWith([dbCam("front_door")]));

    expect(cam.status).toBe("offline");
    expect(cam.recording.degraded).toBe(false);
  });
});
