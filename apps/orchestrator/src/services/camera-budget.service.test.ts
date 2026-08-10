/**
 * WARP-1851 — budget → retention derivation.
 *
 * The interesting cases here are the REFUSALS. Derivation divides by a
 * measured bitrate, and every degenerate input has a plausible-looking
 * wrong answer that would be written straight into Frigate's config:
 *
 *   rate = 0      → Infinity → clamps to 365 days → a year of footage
 *                   nobody asked for
 *   rate = null   → NaN → written as a retention window
 *   budget = 0    → 0 days → Frigate keeps NOTHING and deletes the lot
 *
 * All three must produce "no answer" and leave the camera alone. A wrong
 * retention that saves successfully is worse than an obvious failure —
 * that is the whole lesson of WARP-1849.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate:5000" },
}));

const getCameraStorageMock = vi.fn();
vi.mock("./camera-storage.service.js", () => ({
  getCameraStorage: () => getCameraStorageMock(),
}));

const getCameraSettingsMock = vi.fn();
const updateCameraSettingsMock = vi.fn();
vi.mock("./camera-settings.service.js", () => ({
  getCameraSettings: (n: string) => getCameraSettingsMock(n),
  updateCameraSettings: (n: string, p: unknown) => updateCameraSettingsMock(n, p),
}));

import {
  deriveRetentionDays,
  checkOverAllocation,
  reconcileCameraBudgets,
  MAX_DERIVED_DAYS,
  MIN_DERIVED_DAYS,
} from "./camera-budget.service.js";

const GB = 1024 * 1024 * 1024;

describe("deriveRetentionDays", () => {
  it("converts a budget into days at the measured rate", () => {
    // 240 GB at 1 GB/hr = 240 hours = 10 days.
    const d = deriveRetentionDays(240 * GB, GB);
    expect(d).not.toBeNull();
    expect(d!.days).toBe(10);
    expect(d!.clampedUp).toBe(false);
    expect(d!.clampedDown).toBe(false);
  });

  it("accepts a bigint budget (the Prisma column type)", () => {
    const d = deriveRetentionDays(BigInt(240 * GB), GB);
    expect(d!.days).toBe(10);
  });

  it("refuses when the rate has not been measured", () => {
    expect(deriveRetentionDays(240 * GB, null)).toBeNull();
  });

  it("refuses a zero rate rather than deriving Infinity", () => {
    // 240 GB / 0 = Infinity, which would clamp to the 365-day maximum and
    // silently commit the appliance to a year of recordings.
    expect(deriveRetentionDays(240 * GB, 0)).toBeNull();
  });

  it("refuses a negative rate", () => {
    expect(deriveRetentionDays(240 * GB, -5)).toBeNull();
  });

  it("refuses a zero budget rather than deriving 0 days", () => {
    // 0 days means "keep nothing" to Frigate — it would delete everything
    // this camera has recorded.
    expect(deriveRetentionDays(0, GB)).toBeNull();
  });

  it("refuses a negative budget", () => {
    expect(deriveRetentionDays(-1 * GB, GB)).toBeNull();
  });

  it("refuses a non-finite budget", () => {
    expect(deriveRetentionDays(Number.NaN, GB)).toBeNull();
    expect(deriveRetentionDays(Number.POSITIVE_INFINITY, GB)).toBeNull();
  });

  it("clamps up to one day rather than writing zero for a tiny budget", () => {
    // 1 GB at 1 GB/hr is under an hour of footage. The operator wants a
    // little, not none.
    const d = deriveRetentionDays(1 * GB, GB);
    expect(d!.days).toBe(MIN_DERIVED_DAYS);
    expect(d!.clampedUp).toBe(true);
  });

  it("clamps down to the maximum the settings API will accept", () => {
    const d = deriveRetentionDays(100_000 * GB, GB);
    expect(d!.days).toBe(MAX_DERIVED_DAYS);
    expect(d!.clampedDown).toBe(true);
  });
});

describe("checkOverAllocation", () => {
  it("flags budgets that promise more than the drive holds", () => {
    const r = checkOverAllocation([2000 * GB, 1500 * GB], 2000 * GB);
    expect(r!.overAllocated).toBe(true);
    expect(r!.allocatedBytes).toBe(3500 * GB);
  });

  it("is quiet when budgets fit", () => {
    const r = checkOverAllocation([500 * GB, 500 * GB], 2000 * GB);
    expect(r!.overAllocated).toBe(false);
  });

  it("ignores unset budgets rather than counting them as zero-or-error", () => {
    const r = checkOverAllocation([500 * GB, null, null], 2000 * GB);
    expect(r!.allocatedBytes).toBe(500 * GB);
  });

  it("returns null when the volume capacity is unknown", () => {
    expect(checkOverAllocation([500 * GB], null)).toBeNull();
  });
});

describe("reconcileCameraBudgets", () => {
  const prismaWith = (cameras: unknown[]) =>
    ({ camera: { findMany: vi.fn().mockResolvedValue(cameras) } }) as never;

  beforeEach(() => {
    getCameraStorageMock.mockReset();
    getCameraSettingsMock.mockReset();
    updateCameraSettingsMock.mockReset().mockResolvedValue({});
  });

  it("does nothing when no camera is budget-managed", async () => {
    const r = await reconcileCameraBudgets(prismaWith([]));

    expect(r.applied).toEqual([]);
    // Must not even ask Frigate — a no-op pass should cost nothing.
    expect(getCameraStorageMock).not.toHaveBeenCalled();
  });

  it("writes the derived window into Frigate", async () => {
    getCameraStorageMock.mockResolvedValue({
      cameras: [{ camera: "front_door", bytesPerHour: GB }],
    });
    getCameraSettingsMock.mockResolvedValue({ continuousRetainDays: 3 });

    const r = await reconcileCameraBudgets(
      prismaWith([{ name: "front_door", storageBudgetBytes: BigInt(240 * GB) }]),
    );

    expect(updateCameraSettingsMock).toHaveBeenCalledWith("front_door", {
      continuousRetainDays: 10,
    });
    expect(r.applied).toEqual([{ camera: "front_door", days: 10 }]);
  });

  it("is idempotent — no write when already at the derived value", async () => {
    getCameraStorageMock.mockResolvedValue({
      cameras: [{ camera: "front_door", bytesPerHour: GB }],
    });
    getCameraSettingsMock.mockResolvedValue({ continuousRetainDays: 10 });

    const r = await reconcileCameraBudgets(
      prismaWith([{ name: "front_door", storageBudgetBytes: BigInt(240 * GB) }]),
    );

    // Every config write restarts the camera; re-saving an unchanged value
    // would bounce every budgeted camera on every tick.
    expect(updateCameraSettingsMock).not.toHaveBeenCalled();
    expect(r.alreadyCorrect).toEqual(["front_door"]);
  });

  it("leaves a camera alone when its bitrate is not yet measurable", async () => {
    getCameraStorageMock.mockResolvedValue({
      cameras: [{ camera: "new_cam", bytesPerHour: null }],
    });

    const r = await reconcileCameraBudgets(
      prismaWith([{ name: "new_cam", storageBudgetBytes: BigInt(240 * GB) }]),
    );

    expect(updateCameraSettingsMock).not.toHaveBeenCalled();
    expect(r.skippedNoRate).toEqual(["new_cam"]);
  });

  it("leaves a camera alone when Frigate reports no row for it at all", async () => {
    getCameraStorageMock.mockResolvedValue({ cameras: [] });

    const r = await reconcileCameraBudgets(
      prismaWith([{ name: "ghost_cam", storageBudgetBytes: BigInt(240 * GB) }]),
    );

    expect(updateCameraSettingsMock).not.toHaveBeenCalled();
    expect(r.skippedNoRate).toEqual(["ghost_cam"]);
  });

  it("keeps converging the other cameras when one fails", async () => {
    getCameraStorageMock.mockResolvedValue({
      cameras: [
        { camera: "broken", bytesPerHour: GB },
        { camera: "healthy", bytesPerHour: GB },
      ],
    });
    getCameraSettingsMock.mockImplementation(async (name: string) => {
      if (name === "broken") throw new Error("camera broken not found");
      return { continuousRetainDays: 3 };
    });

    const r = await reconcileCameraBudgets(
      prismaWith([
        { name: "broken", storageBudgetBytes: BigInt(240 * GB) },
        { name: "healthy", storageBudgetBytes: BigInt(240 * GB) },
      ]),
    );

    expect(r.applied).toEqual([{ camera: "healthy", days: 10 }]);
  });

  it("reads storage once for the whole pass", async () => {
    getCameraStorageMock.mockResolvedValue({
      cameras: [
        { camera: "a", bytesPerHour: GB },
        { camera: "b", bytesPerHour: GB },
      ],
    });
    getCameraSettingsMock.mockResolvedValue({ continuousRetainDays: 1 });

    await reconcileCameraBudgets(
      prismaWith([
        { name: "a", storageBudgetBytes: BigInt(240 * GB) },
        { name: "b", storageBudgetBytes: BigInt(240 * GB) },
      ]),
    );

    expect(getCameraStorageMock).toHaveBeenCalledTimes(1);
  });
});
