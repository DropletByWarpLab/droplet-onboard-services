/**
 * WARP-1851 — storage allocation as a measured feedback controller.
 *
 * The first design divided a budget by a bitrate and wrote the result into
 * `record.continuous.days`. An adversarial review killed it:
 *
 *   - `record.continuous.days` is 0 by default, so a "storage cap" TURNED
 *     24/7 RECORDING ON and increased usage.
 *   - Frigate's `bandwidth` is MiB/hr while writing, not wall-clock growth,
 *     so with continuous off the baseline described a different box.
 *   - Frigate keeps a segment if ANY window covers it, so bounding one
 *     window cannot bound bytes.
 *
 * The invariants below are what stop each of those coming back. The most
 * important one — and the first test here — is that enforcing a budget can
 * never enable a recording mode the operator has switched off.
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
  scaleWindows,
  decideBudgetAction,
  parseCeiling,
  windowsToPatch,
  checkOverAllocation,
  reconcileCameraBudgets,
  LOW_WATER,
  MIN_WINDOW_DAYS,
  type RetentionWindows,
} from "./camera-budget.service.js";

const GB = 1024 * 1024 * 1024;

const W = (
  continuous: number,
  motion: number,
  alerts: number,
  detections: number,
): RetentionWindows => ({ continuous, motion, alerts, detections });

describe("a budget never enables a window the operator has off", () => {
  it("leaves continuous at 0 when the ceiling has it at 0", () => {
    // THE regression. Default box: continuous = 0 ("don't keep 24/7").
    // The old code wrote a derived window here and switched it on.
    const ceiling = W(0, 0, 14, 14);
    const out = scaleWindows(ceiling, ceiling, 0.5);

    expect(out.continuous).toBe(0);
    expect(out.motion).toBe(0);
  });

  it("holds a disabled window at 0 even when growing", () => {
    const ceiling = W(0, 0, 14, 14);
    const out = scaleWindows(ceiling, W(0, 0, 7, 7), 2);

    expect(out.continuous).toBe(0);
    expect(out.alerts).toBe(14); // grows, but only up to the ceiling
  });

  it("scales the windows that ARE enabled", () => {
    const ceiling = W(0, 0, 20, 10);
    const out = scaleWindows(ceiling, ceiling, 0.5);

    expect(out.alerts).toBe(10);
    expect(out.detections).toBe(5);
  });
});

describe("scaleWindows clamps", () => {
  it("never exceeds the operator's ceiling", () => {
    const out = scaleWindows(W(0, 0, 14, 14), W(0, 0, 14, 14), 10);
    expect(out.alerts).toBe(14);
  });

  it("never drops an enabled window to zero", () => {
    // 0 means "keep nothing", a different instruction from "keep less".
    const out = scaleWindows(W(0, 0, 14, 14), W(0, 0, 14, 14), 0.001);
    expect(out.alerts).toBe(MIN_WINDOW_DAYS);
    expect(out.alerts).toBeGreaterThan(0);
  });
});

describe("decideBudgetAction", () => {
  const ceiling = W(0, 0, 20, 20);

  it("shrinks when over budget", () => {
    const d = decideBudgetAction(200 * GB, 100 * GB, ceiling, ceiling);
    expect(d.action).toBe("shrink");
    expect(d.windows!.alerts).toBeLessThan(ceiling.alerts);
  });

  it("holds inside the dead band rather than restarting the camera", () => {
    // Every write restarts the camera; chasing noise would bounce cameras
    // nightly for no benefit.
    const d = decideBudgetAction(90 * GB, 100 * GB, ceiling, ceiling);
    expect(d.action).toBe("hold");
  });

  it("grows back toward the ceiling when well under budget", () => {
    const current = W(0, 0, 5, 5);
    const d = decideBudgetAction(10 * GB, 100 * GB, ceiling, current);

    expect(d.action).toBe("grow");
    expect(d.windows!.alerts).toBeGreaterThan(current.alerts);
    expect(d.windows!.alerts).toBeLessThanOrEqual(ceiling.alerts);
  });

  it("holds when already at the ceiling, however far under budget", () => {
    const d = decideBudgetAction(1 * GB, 100 * GB, ceiling, ceiling);
    expect(d.action).toBe("hold");
  });

  it("holds when usage is not measurable — never treats unknown as zero", () => {
    // Unknown usage read as 0 would look "way under budget" and grow
    // retention on a camera nobody has measured.
    const d = decideBudgetAction(null, 100 * GB, ceiling, W(0, 0, 5, 5));
    expect(d.action).toBe("hold");
    expect(d.reason).toMatch(/not measurable/);
  });

  it("holds on a non-positive budget instead of computing a window", () => {
    expect(decideBudgetAction(50 * GB, 0, ceiling, ceiling).action).toBe("hold");
    expect(decideBudgetAction(50 * GB, -1, ceiling, ceiling).action).toBe("hold");
  });

  it("holds when over budget but every enabled window is already at the floor", () => {
    const floor = W(0, 0, MIN_WINDOW_DAYS, MIN_WINDOW_DAYS);
    const d = decideBudgetAction(500 * GB, 1 * GB, ceiling, floor);

    expect(d.action).toBe("hold");
    expect(d.reason).toMatch(/floor/);
  });

  it("converges rather than oscillating across repeated passes", () => {
    // Drive the loop with a usage model proportional to the alerts window,
    // and assert it settles inside the band instead of ping-ponging.
    let current = ceiling;
    const bytesPerDay = 10 * GB;
    const budget = 100 * GB;
    const seen: number[] = [];

    for (let i = 0; i < 12; i++) {
      const usage = current.alerts * bytesPerDay;
      const d = decideBudgetAction(usage, budget, ceiling, current);
      if (d.action === "hold") break;
      current = d.windows!;
      seen.push(current.alerts);
    }

    const finalUsage = current.alerts * bytesPerDay;
    expect(finalUsage).toBeLessThanOrEqual(budget);
    expect(finalUsage).toBeGreaterThanOrEqual(budget * LOW_WATER);
  });
});

describe("parseCeiling", () => {
  it("round-trips a stored ceiling", () => {
    expect(parseCeiling({ continuous: 0, motion: 0, alerts: 14, detections: 7 }))
      .toEqual(W(0, 0, 14, 7));
  });

  it("returns null for malformed input rather than guessing", () => {
    // A guessed ceiling could raise a window the operator had off.
    expect(parseCeiling(null)).toBeNull();
    expect(parseCeiling("14")).toBeNull();
    expect(parseCeiling({ continuous: 0 })).toBeNull();
    expect(parseCeiling({ continuous: -1, motion: 0, alerts: 1, detections: 1 })).toBeNull();
  });
});

describe("windowsToPatch", () => {
  it("writes all four windows, not just continuous", () => {
    // Bounding one window cannot bound storage — Frigate keeps a segment if
    // ANY window still covers it.
    const patch = windowsToPatch(W(1, 2, 3, 4));
    expect(patch).toEqual({
      continuousRetainDays: 1,
      motionRetainDays: 2,
      alertsRetainDays: 3,
      detectionsRetainDays: 4,
    });
  });
});

describe("checkOverAllocation", () => {
  it("flags budgets promising more than the drive holds", () => {
    const r = checkOverAllocation([2000 * GB, 1500 * GB], 2000 * GB);
    expect(r!.overAllocated).toBe(true);
  });

  it("ignores unset budgets", () => {
    expect(checkOverAllocation([500 * GB, null], 2000 * GB)!.allocatedBytes).toBe(500 * GB);
  });

  it("returns null when capacity is unknown", () => {
    expect(checkOverAllocation([500 * GB], null)).toBeNull();
  });
});

describe("reconcileCameraBudgets", () => {
  const CEILING = { continuous: 0, motion: 0, alerts: 20, detections: 20 };

  function prismaWith(cameras: unknown[]) {
    return {
      camera: {
        findMany: vi.fn().mockResolvedValue(cameras),
        update: vi.fn().mockResolvedValue({}),
      },
    } as never;
  }

  beforeEach(() => {
    getCameraStorageMock.mockReset();
    getCameraSettingsMock.mockReset().mockResolvedValue({
      continuousRetainDays: 0,
      motionRetainDays: 0,
      alertsRetainDays: 20,
      detectionsRetainDays: 20,
    });
    updateCameraSettingsMock.mockReset().mockResolvedValue({});
  });

  it("does nothing, and costs nothing, when no camera is budgeted", async () => {
    const r = await reconcileCameraBudgets(prismaWith([]));

    expect(r.applied).toEqual([]);
    expect(getCameraStorageMock).not.toHaveBeenCalled();
  });

  it("shrinks an over-budget camera across all enabled windows", async () => {
    getCameraStorageMock.mockResolvedValue({
      cameras: [{ camera: "front_door", usedBytes: 200 * GB }],
    });

    const r = await reconcileCameraBudgets(
      prismaWith([
        {
          name: "front_door",
          storageBudgetBytes: BigInt(100 * GB),
          retentionCeiling: CEILING,
        },
      ]),
    );

    expect(r.applied[0].action).toBe("shrink");
    const patch = updateCameraSettingsMock.mock.calls[0][1];
    expect(patch.alertsRetainDays).toBeLessThan(20);
    // The invariant that matters: continuous stays off.
    expect(patch.continuousRetainDays).toBe(0);
  });

  it("writes nothing when the camera is inside the dead band", async () => {
    getCameraStorageMock.mockResolvedValue({
      cameras: [{ camera: "front_door", usedBytes: 90 * GB }],
    });

    const r = await reconcileCameraBudgets(
      prismaWith([
        { name: "front_door", storageBudgetBytes: BigInt(100 * GB), retentionCeiling: CEILING },
      ]),
    );

    expect(updateCameraSettingsMock).not.toHaveBeenCalled();
    expect(r.held).toHaveLength(1);
  });

  it("captures a missing ceiling from live config instead of assuming one", async () => {
    getCameraStorageMock.mockResolvedValue({
      cameras: [{ camera: "front_door", usedBytes: 50 * GB }],
    });
    const prisma = prismaWith([
      { name: "front_door", storageBudgetBytes: BigInt(100 * GB), retentionCeiling: null },
    ]);

    await reconcileCameraBudgets(prisma);

    const update = (prisma as never as { camera: { update: ReturnType<typeof vi.fn> } })
      .camera.update;
    expect(update).toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.retentionCeiling).toEqual({
      continuous: 0,
      motion: 0,
      alerts: 20,
      detections: 20,
    });
  });

  it("holds a camera Frigate reports no usage for", async () => {
    getCameraStorageMock.mockResolvedValue({
      cameras: [{ camera: "front_door", usedBytes: null }],
    });

    const r = await reconcileCameraBudgets(
      prismaWith([
        { name: "front_door", storageBudgetBytes: BigInt(100 * GB), retentionCeiling: CEILING },
      ]),
    );

    expect(updateCameraSettingsMock).not.toHaveBeenCalled();
    expect(r.held[0].reason).toMatch(/not measurable/);
  });

  it("reports per-camera failures instead of returning a quiet success", async () => {
    // The absence of this channel WAS a defect: an all-failed pass used to be
    // byte-identical to a nothing-to-do pass.
    getCameraStorageMock.mockResolvedValue({
      cameras: [
        { camera: "broken", usedBytes: 200 * GB },
        { camera: "healthy", usedBytes: 200 * GB },
      ],
    });
    getCameraSettingsMock.mockImplementation(async (name: string) => {
      if (name === "broken") throw new Error("camera broken not found");
      return {
        continuousRetainDays: 0,
        motionRetainDays: 0,
        alertsRetainDays: 20,
        detectionsRetainDays: 20,
      };
    });

    const r = await reconcileCameraBudgets(
      prismaWith([
        { name: "broken", storageBudgetBytes: BigInt(100 * GB), retentionCeiling: CEILING },
        { name: "healthy", storageBudgetBytes: BigInt(100 * GB), retentionCeiling: CEILING },
      ]),
    );

    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].camera).toBe("broken");
    // and the healthy camera still converged
    expect(r.applied.map((a) => a.camera)).toEqual(["healthy"]);
  });

  it("reads storage once for the whole pass", async () => {
    getCameraStorageMock.mockResolvedValue({
      cameras: [
        { camera: "a", usedBytes: 200 * GB },
        { camera: "b", usedBytes: 200 * GB },
      ],
    });

    await reconcileCameraBudgets(
      prismaWith([
        { name: "a", storageBudgetBytes: BigInt(100 * GB), retentionCeiling: CEILING },
        { name: "b", storageBudgetBytes: BigInt(100 * GB), retentionCeiling: CEILING },
      ]),
    );

    expect(getCameraStorageMock).toHaveBeenCalledTimes(1);
  });
});
