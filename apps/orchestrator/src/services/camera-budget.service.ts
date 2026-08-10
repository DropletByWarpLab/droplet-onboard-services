/**
 * WARP-1851 — storage allocation: a byte budget per camera, converted into
 * the retention window Frigate enforces.
 *
 * ## Why a budget derives days instead of capping bytes
 *
 * Frigate has no per-camera byte quota, and the orchestrator does not mount
 * the recordings volume. Enforcing a byte cap here would mean deleting
 * segment files behind Frigate's recordings DB — racing its own storage
 * maintainer and corrupting the index it serves playback from. So the
 * budget is not enforced by deletion; it is CONVERTED into the units
 * Frigate already enforces natively:
 *
 *     retention_days = budget_bytes / (measured_bytes_per_hour * 24)
 *
 * The operator thinks in gigabytes, Frigate expires in days, and this is
 * the seam between them. The UI states the conversion out loud ("200 GB ≈
 * 18 days at this camera's current bitrate") so nobody mistakes the budget
 * for a hard wall.
 *
 * ## What this module refuses to do
 *
 * Derivation is only as good as the measured bitrate. When the rate is
 * unknown or zero — a camera that has just been added, or one that hasn't
 * recorded a segment yet — the honest result is *no answer*, not a
 * division that yields Infinity or 0. Both would be written into Frigate
 * as a retention window: Infinity clamps to the 365-day cap and quietly
 * commits the appliance to a year of footage; 0 turns recording retention
 * off entirely and deletes everything. Neither is what the operator asked
 * for, and both look like a successful save.
 *
 * So: no rate → no write. The camera keeps whatever retention it has.
 */

import type { PrismaClient } from "@prisma/client";
import { getCameraStorage } from "./camera-storage.service.js";
import { getCameraSettings, updateCameraSettings } from "./camera-settings.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("camera-budget");

/**
 * Ceiling on a derived retention window, in days.
 *
 * Matches the range camera-settings.service.ts validates, so a derived
 * value can never be rejected by the very save it feeds.
 */
export const MAX_DERIVED_DAYS = 365;

/**
 * Floor on a derived retention window, in days.
 *
 * A budget too small for even a day of footage derives to a fraction. We
 * clamp UP to 1 rather than writing 0, because 0 means "keep nothing" to
 * Frigate — an operator who set a small budget wants a little footage, not
 * none. The over-budget condition is surfaced to the UI instead of being
 * silently resolved by deleting everything.
 */
export const MIN_DERIVED_DAYS = 1;

export interface DerivedRetention {
  /** Days of footage the budget buys at the measured rate. */
  days: number;
  /** True when the budget was too small for MIN_DERIVED_DAYS and clamped. */
  clampedUp: boolean;
  /** True when the budget exceeded what MAX_DERIVED_DAYS can express. */
  clampedDown: boolean;
}

/**
 * Convert a byte budget into a retention window.
 *
 * Returns `null` when the conversion cannot be made honestly — an absent,
 * zero, negative or non-finite rate, or a non-positive budget. Callers MUST
 * treat null as "leave this camera alone", never as a default.
 */
export function deriveRetentionDays(
  budgetBytes: number | bigint | null,
  bytesPerHour: number | null,
): DerivedRetention | null {
  if (budgetBytes === null || bytesPerHour === null) return null;

  const budget = typeof budgetBytes === "bigint" ? Number(budgetBytes) : budgetBytes;
  if (!Number.isFinite(budget) || budget <= 0) return null;
  if (!Number.isFinite(bytesPerHour) || bytesPerHour <= 0) return null;

  const raw = budget / (bytesPerHour * 24);
  if (!Number.isFinite(raw)) return null;

  const rounded = Math.round(raw * 10) / 10;
  if (rounded < MIN_DERIVED_DAYS) {
    return { days: MIN_DERIVED_DAYS, clampedUp: true, clampedDown: false };
  }
  if (rounded > MAX_DERIVED_DAYS) {
    return { days: MAX_DERIVED_DAYS, clampedUp: false, clampedDown: true };
  }
  return { days: rounded, clampedUp: false, clampedDown: false };
}

export interface OverAllocation {
  /** Sum of every BUDGET camera's budget, bytes. */
  allocatedBytes: number;
  /** Capacity of the recordings volume, bytes. */
  capacityBytes: number;
  /** True when budgets promise more space than the volume has. */
  overAllocated: boolean;
}

/**
 * Compare the sum of budgets against the volume.
 *
 * Over-allocation is a warning, not an error: budgets are targets, and
 * Frigate's oldest-first eviction means the disk filling is survivable.
 * But an operator who has promised 3 TB on a 2 TB drive should be told,
 * because the retention they see per camera will not be the retention they
 * get once the drive fills.
 */
export function checkOverAllocation(
  budgets: Array<number | bigint | null>,
  capacityBytes: number | null,
): OverAllocation | null {
  if (capacityBytes === null || capacityBytes <= 0) return null;

  const allocatedBytes = budgets.reduce<number>((sum, b) => {
    if (b === null) return sum;
    const n = typeof b === "bigint" ? Number(b) : b;
    return Number.isFinite(n) && n > 0 ? sum + n : sum;
  }, 0);

  return {
    allocatedBytes,
    capacityBytes,
    overAllocated: allocatedBytes > capacityBytes,
  };
}

export interface ReconcileResult {
  /** Cameras whose Frigate retention was rewritten this pass. */
  applied: Array<{ camera: string; days: number }>;
  /** Cameras skipped because their bitrate isn't measurable yet. */
  skippedNoRate: string[];
  /** Cameras already at their derived value — no write issued. */
  alreadyCorrect: string[];
}

/**
 * One reconciliation pass over every BUDGET-mode camera.
 *
 * Idempotent by construction: a camera already sitting at its derived
 * window is skipped rather than re-saved. That matters because every write
 * to Frigate's config triggers a camera restart — a reconciler that wrote
 * unconditionally would bounce every budgeted camera on every tick.
 *
 * Per-camera failures are logged and do not abort the pass; one
 * misconfigured camera must not stop the others from converging.
 */
export async function reconcileCameraBudgets(
  prisma: PrismaClient,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    applied: [],
    skippedNoRate: [],
    alreadyCorrect: [],
  };

  const budgeted = (await prisma.camera.findMany({
    where: { retentionMode: "BUDGET" },
    select: { name: true, storageBudgetBytes: true },
  })) as Array<{ name: string; storageBudgetBytes: bigint | null }>;

  if (budgeted.length === 0) return result;

  // One storage read for the whole pass — the per-camera rates all come
  // from the same snapshot, so N cameras cost one Frigate round-trip.
  const storage = await getCameraStorage();
  const rateByCamera = new Map(
    storage.cameras.map((c) => [c.camera, c.bytesPerHour]),
  );

  for (const cam of budgeted) {
    const rate = rateByCamera.get(cam.name) ?? null;
    const derived = deriveRetentionDays(cam.storageBudgetBytes, rate);

    if (derived === null) {
      // No measurable rate yet. Leave the camera's current retention
      // untouched — see the module docstring on why a default is worse.
      result.skippedNoRate.push(cam.name);
      continue;
    }

    try {
      const current = await getCameraSettings(cam.name);
      if (current.continuousRetainDays === derived.days) {
        result.alreadyCorrect.push(cam.name);
        continue;
      }

      await updateCameraSettings(cam.name, {
        continuousRetainDays: derived.days,
      });
      result.applied.push({ camera: cam.name, days: derived.days });

      logger.info(
        {
          camera: cam.name,
          days: derived.days,
          budgetBytes: cam.storageBudgetBytes?.toString() ?? null,
          bytesPerHour: rate,
          clampedUp: derived.clampedUp,
          clampedDown: derived.clampedDown,
        },
        "derived camera retention from storage budget",
      );
    } catch (err) {
      // One camera failing must not strand the rest.
      logger.warn(
        { camera: cam.name, err: (err as Error).message },
        "could not apply derived retention for camera",
      );
    }
  }

  return result;
}
