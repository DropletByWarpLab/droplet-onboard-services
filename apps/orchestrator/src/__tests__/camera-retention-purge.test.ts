/**
 * WARP-475 (G3) — camera retention purge service.
 *
 * Three concerns:
 *   1. loadCameraRetentionPolicy reads from WorkspaceSetting and
 *      coerces null/missing into the explicit `null` "forever" state.
 *   2. purgeCameraArtifacts hits Frigate's delete endpoints with the
 *      correct unix-second cutoff and respects null = skip semantics.
 *   3. ActivityRow row written for every run (audit trail of "we checked").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    // Romain on #292 round 2: the service now reads
    // `config.FRIGATE_URL` (not `process.env.FRIGATE_API_URL`), so the
    // test config needs a sensible value here too. Default matches
    // config.ts's Zod default.
    FRIGATE_URL: "http://frigate:5000",
  },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  loadCameraRetentionPolicy,
  purgeCameraArtifacts,
} from "../services/camera-retention-purge.service.js";

interface SettingRow {
  key: string;
  valueJson: unknown;
}

function createPrismaMock(rows: SettingRow[]) {
  return {
    workspaceSetting: {
      findMany: vi.fn(async () => rows),
    },
  };
}

beforeEach(() => {
  recordActivityMock.mockClear();
  vi.unstubAllGlobals();
});

describe("WARP-475 — loadCameraRetentionPolicy", () => {
  it("returns seeded defaults (14 / null) when both rows present", async () => {
    const prisma = createPrismaMock([
      { key: "hardware.camera_retention_days", valueJson: 14 },
      { key: "hardware.event_retention_days", valueJson: null },
    ]);
    const policy = await loadCameraRetentionPolicy(prisma as any);
    expect(policy).toEqual({ clipsDays: 14, eventsDays: null });
  });

  it("treats missing rows as null (forever) — first-boot race-safe", async () => {
    const prisma = createPrismaMock([]);
    const policy = await loadCameraRetentionPolicy(prisma as any);
    expect(policy).toEqual({ clipsDays: null, eventsDays: null });
  });

  it("treats 0 / negative as null (forever, not a sentinel)", async () => {
    const prisma = createPrismaMock([
      { key: "hardware.camera_retention_days", valueJson: 0 },
      { key: "hardware.event_retention_days", valueJson: -1 },
    ]);
    const policy = await loadCameraRetentionPolicy(prisma as any);
    expect(policy).toEqual({ clipsDays: null, eventsDays: null });
  });

  it("honors a non-default operator value (e.g. 90-day clips)", async () => {
    const prisma = createPrismaMock([
      { key: "hardware.camera_retention_days", valueJson: 90 },
      { key: "hardware.event_retention_days", valueJson: 365 },
    ]);
    const policy = await loadCameraRetentionPolicy(prisma as any);
    expect(policy).toEqual({ clipsDays: 90, eventsDays: 365 });
  });
});

describe("WARP-475 — purgeCameraArtifacts", () => {
  it("skips Frigate calls when retention is null", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const prisma = createPrismaMock([
      { key: "hardware.camera_retention_days", valueJson: null },
      { key: "hardware.event_retention_days", valueJson: null },
    ]);
    const result = await purgeCameraArtifacts(prisma as any);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.clipsSkipped).toBe(true);
    expect(result.eventsSkipped).toBe(true);
    expect(result.clipsDeleted).toBe(0);
    expect(result.eventsDeleted).toBe(0);
    // ActivityRow still emitted — operator audit trail of "we checked".
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const call = recordActivityMock.mock.calls[0][0];
    expect(call.kind).toBe("camera");
    expect(call.what).toBe("Camera retention purge");
  });

  it("posts the correct before=<unix-seconds> cutoff to Frigate", async () => {
    const now = new Date("2026-05-27T12:00:00Z");
    // This test pins clipsDays=14 in the prisma mock below; the
    // expected cutoff is therefore (now - 14d) in unix seconds.
    // 14 is the *test fixture* here, not the production policy —
    // production reads whatever `hardware.camera_retention_days`
    // currently holds in the WorkspaceSetting table.
    const expectedCutoff = Math.floor(
      (now.getTime() - 14 * 86400_000) / 1000,
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ deleted: 42 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const prisma = createPrismaMock([
      { key: "hardware.camera_retention_days", valueJson: 14 },
      { key: "hardware.event_retention_days", valueJson: null },
    ]);
    const result = await purgeCameraArtifacts(prisma as any, now);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`/api/recordings?before=${expectedCutoff}`);
    expect(result.clipsDeleted).toBe(42);
    expect(result.clipsSkipped).toBe(false);
    expect(result.eventsDeleted).toBe(0);
    expect(result.eventsSkipped).toBe(true);
  });

  it("treats a Frigate 404 as null (no count, no row) and still emits activity", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const prisma = createPrismaMock([
      { key: "hardware.camera_retention_days", valueJson: 14 },
      { key: "hardware.event_retention_days", valueJson: null },
    ]);
    const result = await purgeCameraArtifacts(prisma as any);
    expect(result.clipsDeleted).toBe(0);
    // skipped because the call failed — operator can read the activity
    // row's `clipsSkipped: true` to know nothing was actually deleted.
    expect(result.clipsSkipped).toBe(true);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });

  it("swallows fetch transport errors (cron MUST keep ticking)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    const prisma = createPrismaMock([
      { key: "hardware.camera_retention_days", valueJson: 14 },
      { key: "hardware.event_retention_days", valueJson: 30 },
    ]);
    // Must not throw — the cron handler wraps in try/catch too,
    // but the service-level swallow is the load-bearing contract.
    const result = await purgeCameraArtifacts(prisma as any);
    expect(result.clipsSkipped).toBe(true);
    expect(result.eventsSkipped).toBe(true);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });

  it("idempotent: re-running a moment later walks zero items", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ deleted: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const prisma = createPrismaMock([
      { key: "hardware.camera_retention_days", valueJson: 14 },
      { key: "hardware.event_retention_days", valueJson: null },
    ]);
    const first = await purgeCameraArtifacts(prisma as any);
    const second = await purgeCameraArtifacts(prisma as any);
    expect(first.clipsDeleted).toBe(0);
    expect(second.clipsDeleted).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordActivityMock).toHaveBeenCalledTimes(2);
  });
});
