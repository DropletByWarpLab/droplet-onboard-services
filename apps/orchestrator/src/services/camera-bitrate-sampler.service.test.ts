/**
 * WARP-3514 / ADR-070 — the hourly camera bitrate sampler.
 *
 * It feeds the allocator's sizing (p95 over 72 h), so what matters here is:
 *   - the unit: Frigate reports MiB/h and `CameraBitrateSample.mbPerHour` keeps
 *     MiB/h, so `bytesPerHour / MIB` — a /1_000_000 or an x1 would under- or
 *     over-reserve a customer's drive by 5 % or 1 048 576x;
 *   - "unknown is not zero": a camera with no measured rate (null) records
 *     NOTHING rather than a 0 that would drag the p95 down;
 *   - an unreachable Frigate THROWS (the cron canary counts it) and writes
 *     nothing — a silent empty hour would starve the sizing of history.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraStorageSummary } from "./camera-storage.service.js";

const getCameraStorageMock = vi.fn();
vi.mock("./camera-storage.service.js", () => ({
  getCameraStorage: (...args: unknown[]) => getCameraStorageMock(...args),
}));

import { loadSamplesByCamera, sampleCameraBitrates } from "./camera-bitrate-sampler.service.js";
import { MIB, SAMPLE_RETENTION_DAYS, computeSizing, NEED_FLOOR_BYTES } from "./recordings-sizing.js";

const DAY = 24 * 3_600_000;
const NOW = new Date("2026-10-03T12:00:00.000Z");

function storage(cameras: Array<{ camera: string; bytesPerHour: number | null }>): CameraStorageSummary {
  return {
    volume: null,
    cameras: cameras.map((c) => ({ ...c, usedBytes: null, sharePercent: null, daysAtCurrentRate: null })),
    nearFull: false,
    recordingsOnBootDisk: null,
    totalBytesPerHour: null,
  };
}

interface SampleRow {
  camera: string;
  sampledAt: Date;
  mbPerHour: number;
}

function fakePrisma(opts: { pruned?: number; rows?: SampleRow[] } = {}) {
  const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
  const deleteMany = vi.fn(async (_args: unknown) => ({ count: opts.pruned ?? 0 }));
  const findMany = vi.fn(async (_args: unknown) => opts.rows ?? []);
  return {
    prisma: { cameraBitrateSample: { createMany, deleteMany, findMany } } as never,
    createMany,
    deleteMany,
    findMany,
  };
}

beforeEach(() => {
  getCameraStorageMock.mockReset();
});

describe("sampleCameraBitrates", () => {
  it("records one sample per camera with a measured rate, converting bytes/hour to MiB/hour", async () => {
    const { prisma, createMany } = fakePrisma();
    const out = await sampleCameraBitrates(prisma, {
      getStorage: async () =>
        storage([
          { camera: "front_door", bytesPerHour: 500 * MIB },
          { camera: "garage", bytesPerHour: 250.5 * MIB },
        ]),
      now: () => NOW,
    });

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0]).toEqual({
      data: [
        { camera: "front_door", sampledAt: NOW, mbPerHour: 500 },
        { camera: "garage", sampledAt: NOW, mbPerHour: 250.5 },
      ],
    });
    expect(out.recorded).toBe(2);
  });

  it("a camera with NO measured rate records nothing — null is not 0", async () => {
    const { prisma, createMany } = fakePrisma();
    const out = await sampleCameraBitrates(prisma, {
      getStorage: async () =>
        storage([
          { camera: "front_door", bytesPerHour: 100 * MIB },
          { camera: "just_added", bytesPerHour: null },
        ]),
      now: () => NOW,
    });
    expect(createMany.mock.calls[0][0].data).toEqual([{ camera: "front_door", sampledAt: NOW, mbPerHour: 100 }]);
    expect(out.recorded).toBe(1);
  });

  it("never records a zero, non-finite or negative rate (Frigate seeds bandwidth to 0 until it has measured)", async () => {
    const { prisma, createMany } = fakePrisma();
    const out = await sampleCameraBitrates(prisma, {
      getStorage: async () =>
        storage([
          { camera: "zero_cam", bytesPerHour: 0 },
          { camera: "nan_cam", bytesPerHour: Number.NaN },
          { camera: "inf_cam", bytesPerHour: Number.POSITIVE_INFINITY },
          { camera: "neg_cam", bytesPerHour: -1 },
          { camera: "ok_cam", bytesPerHour: 10 * MIB },
        ]),
      now: () => NOW,
    });
    expect(createMany.mock.calls[0][0].data).toEqual([{ camera: "ok_cam", sampledAt: NOW, mbPerHour: 10 }]);
    expect(out.recorded).toBe(1);
  });

  it("prunes samples older than the 14-day retention and reports how many", async () => {
    const { prisma, deleteMany } = fakePrisma({ pruned: 7 });
    const out = await sampleCameraBitrates(prisma, {
      getStorage: async () => storage([{ camera: "a", bytesPerHour: MIB }]),
      now: () => NOW,
    });
    expect(SAMPLE_RETENTION_DAYS).toBe(14);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { sampledAt: { lt: new Date(NOW.getTime() - 14 * DAY) } } });
    expect(out.pruned).toBe(7);
  });

  it("prunes AFTER recording, so a failed insert never leaves the table shorter than before", async () => {
    const { prisma, createMany, deleteMany } = fakePrisma();
    await sampleCameraBitrates(prisma, { getStorage: async () => storage([{ camera: "a", bytesPerHour: MIB }]), now: () => NOW });
    expect(createMany.mock.invocationCallOrder[0]).toBeLessThan(deleteMany.mock.invocationCallOrder[0]);
  });

  it("no camera has a rate yet: nothing is inserted (no empty createMany), but old rows are still pruned", async () => {
    const { prisma, createMany, deleteMany } = fakePrisma({ pruned: 3 });
    const out = await sampleCameraBitrates(prisma, {
      getStorage: async () => storage([{ camera: "a", bytesPerHour: null }]),
      now: () => NOW,
    });
    expect(createMany).not.toHaveBeenCalled();
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ recorded: 0, pruned: 3 });
  });

  it("no cameras at all behaves the same", async () => {
    const { prisma, createMany } = fakePrisma();
    const out = await sampleCameraBitrates(prisma, { getStorage: async () => storage([]), now: () => NOW });
    expect(createMany).not.toHaveBeenCalled();
    expect(out).toEqual({ recorded: 0, pruned: 0 });
  });

  it("Frigate unreachable: the call THROWS (cron canary) and nothing is written or pruned", async () => {
    const { prisma, createMany, deleteMany } = fakePrisma();
    await expect(
      sampleCameraBitrates(prisma, {
        getStorage: async () => {
          throw new Error("Frigate recordings storage: 502");
        },
        now: () => NOW,
      }),
    ).rejects.toThrow(/502/);
    expect(createMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("a failing insert propagates too (never reports success it did not achieve)", async () => {
    const { prisma, createMany, deleteMany } = fakePrisma();
    createMany.mockRejectedValueOnce(new Error("db down"));
    await expect(
      sampleCameraBitrates(prisma, { getStorage: async () => storage([{ camera: "a", bytesPerHour: MIB }]), now: () => NOW }),
    ).rejects.toThrow(/db down/);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  describe("defaults", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("uses the shared getCameraStorage() (which already maps friendly names to camera names) and the wall clock", async () => {
      getCameraStorageMock.mockResolvedValue(storage([{ camera: "front_door", bytesPerHour: 64 * MIB }]));
      const { prisma, createMany } = fakePrisma();
      const out = await sampleCameraBitrates(prisma);
      expect(getCameraStorageMock).toHaveBeenCalledTimes(1);
      expect(createMany.mock.calls[0][0].data).toEqual([{ camera: "front_door", sampledAt: NOW, mbPerHour: 64 }]);
      expect(out.recorded).toBe(1);
    });
  });
});

describe("loadSamplesByCamera", () => {
  it("returns the last 14 days grouped by camera, as plain {sampledAt, mbPerHour} samples", async () => {
    const t1 = new Date("2026-10-03T10:00:00Z");
    const t2 = new Date("2026-10-03T11:00:00Z");
    const { prisma } = fakePrisma({
      rows: [
        { camera: "front_door", sampledAt: t1, mbPerHour: 500 },
        { camera: "front_door", sampledAt: t2, mbPerHour: 510 },
        { camera: "garage", sampledAt: t1, mbPerHour: 250 },
      ],
    });
    const out = await loadSamplesByCamera(prisma, NOW);
    expect([...out.keys()]).toEqual(["front_door", "garage"]);
    expect(out.get("front_door")).toEqual([
      { sampledAt: t1, mbPerHour: 500 },
      { sampledAt: t2, mbPerHour: 510 },
    ]);
    expect(out.get("garage")).toEqual([{ sampledAt: t1, mbPerHour: 250 }]);
  });

  it("asks for exactly the 14-day window, in camera/time order, selecting only what it needs", async () => {
    const { prisma, findMany } = fakePrisma();
    await loadSamplesByCamera(prisma, NOW);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { sampledAt: { gte: new Date(NOW.getTime() - 14 * DAY) } },
      orderBy: [{ camera: "asc" }, { sampledAt: "asc" }],
      select: { camera: true, sampledAt: true, mbPerHour: true },
    });
  });

  it("an empty table is an empty map", async () => {
    const { prisma } = fakePrisma();
    expect((await loadSamplesByCamera(prisma, NOW)).size).toBe(0);
  });

  it("a camera named like an Object.prototype member is just a key (the result is a Map)", async () => {
    const { prisma } = fakePrisma({ rows: [{ camera: "constructor", sampledAt: NOW, mbPerHour: 1 }] });
    const out = await loadSamplesByCamera(prisma, NOW);
    expect(out.get("constructor")).toHaveLength(1);
  });

  it("feeds computeSizing directly: what the sampler stored is what the sizing reads", async () => {
    const H = 3_600_000;
    const rows: SampleRow[] = [
      { camera: "front_door", sampledAt: new Date(NOW.getTime() - 2 * H), mbPerHour: 1000 },
      { camera: "front_door", sampledAt: new Date(NOW.getTime() - 1 * H), mbPerHour: 1000 },
    ];
    const { prisma } = fakePrisma({ rows });
    const sizing = computeSizing(await loadSamplesByCamera(prisma, NOW), NOW, 7, ["front_door"]);
    expect(sizing.cameras).toEqual([{ name: "front_door", mbPerHour: 1000, needBytes: 224_604_979_200, basis: "history" }]);
    expect(sizing.needTotalBytes).toBeGreaterThan(NEED_FLOOR_BYTES);
  });
});
