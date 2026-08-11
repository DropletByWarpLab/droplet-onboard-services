/**
 * WARP-1851 — storage allocation: give a camera an amount of disk and hold
 * it there.
 *
 * ## Why this is a feedback loop and not a formula
 *
 * The first cut of this feature divided a byte budget by a measured bitrate
 * to get a retention window, and wrote that into `record.continuous.days`.
 * That was wrong three ways, and an adversarial review caught all three:
 *
 *   1. `record.continuous.days` is **0** on a default box — "don't keep 24/7
 *      footage". Writing a derived window there did not cap storage, it
 *      SWITCHED 24/7 RECORDING ON and drove usage up.
 *   2. The bitrate came from Frigate's `bandwidth`, which is MiB/hr *while a
 *      segment is being written*. With continuous retention off, segments are
 *      only kept around review items, so wall-clock growth is a fraction of
 *      `bandwidth × 24`. The formula's baseline did not describe the box it
 *      was running on.
 *   3. Frigate keeps a segment if ANY window still covers it. Per
 *      `record/cleanup.py`, segments past `max(continuous, motion)` days are
 *      deletion *candidates*, but survive when they overlap a non-expired
 *      alert/detection review (subject to that review's retain `mode`). So
 *      bounding one window cannot bound total bytes.
 *
 * All three failure modes share a root cause: predicting bytes from a model
 * of how Frigate records. So this implementation does not predict. It
 * measures what the camera is actually using and adjusts, which converges
 * regardless of recording mode, motion levels or bitrate drift.
 *
 * ## The controller
 *
 * Nightly, per BUDGET-mode camera:
 *
 *   over budget   → scale every ENABLED window down toward the target
 *   well under    → grow back one step toward the operator's ceiling
 *   within band   → do nothing (no write, no camera restart)
 *
 * Two invariants make this safe:
 *
 *   - **A window the operator has at 0 is never raised.** Scaling is
 *     multiplicative over the stored ceiling, and 0 scales to 0. Enforcing a
 *     budget can never enable a recording mode that was off — the exact
 *     defect that sank the first design.
 *   - **The ceiling is remembered.** Without it the controller could not tell
 *     "I reduced this to fit" from "the operator wants it low", and could
 *     never restore retention after usage falls.
 *
 * Convergence is deliberately gradual: Frigate deletes on its own schedule,
 * so usage responds a day or so after a window changes. Steps are capped so
 * the loop damps instead of oscillating.
 */

import type { PrismaClient } from "@prisma/client";
import { getCameraStorage } from "./camera-storage.service.js";
import {
  getCameraSettings,
  updateCameraSettings,
  type CameraSettings,
  type CameraSettingsPatch,
} from "./camera-settings.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("camera-budget");

/** Retention windows the controller manages, in days. */
export interface RetentionWindows {
  continuous: number;
  motion: number;
  alerts: number;
  detections: number;
}

/** Cap matching camera-settings.service.ts's own validation, so a value this
 *  module produces can never be rejected by the save it feeds. */
export const MAX_WINDOW_DAYS = 365;

/** A managed window never drops below this while it is enabled. Going to 0
 *  would mean "keep nothing", which is a different instruction from "keep
 *  less" and is not what setting a budget asks for. */
export const MIN_WINDOW_DAYS = 1;

/**
 * Only act when usage is outside [LOW_WATER, 1.0] × budget.
 *
 * The dead band matters: every window change rewrites Frigate's config, and
 * every config write restarts the camera. A controller without hysteresis
 * would bounce cameras nightly chasing noise in a measurement that only
 * updates as Frigate deletes.
 */
export const LOW_WATER = 0.8;

/** Largest single-pass reduction. Usage lags window changes by a day or so,
 *  so an unclamped correction would overshoot and then have to grow back. */
export const MAX_SHRINK_STEP = 0.5;

/** Largest single-pass growth back toward the ceiling. Slower than shrinking
 *  — overshooting downward wastes retention, overshooting upward blows the
 *  budget the operator set. */
export const MAX_GROW_STEP = 1.25;

export function windowsFromSettings(s: CameraSettings): RetentionWindows {
  return {
    continuous: s.continuousRetainDays,
    motion: s.motionRetainDays,
    alerts: s.alertsRetainDays,
    detections: s.detectionsRetainDays,
  };
}

/** Parse a stored ceiling. Returns null for anything malformed rather than
 *  guessing — the caller re-captures from live config instead. */
export function parseCeiling(raw: unknown): RetentionWindows | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = ["continuous", "motion", "alerts", "detections"] as const;
  const out = {} as RetentionWindows;
  for (const k of keys) {
    const v = Number(o[k]);
    if (!Number.isFinite(v) || v < 0) return null;
    out[k] = v;
  }
  return out;
}

/**
 * Scale the enabled windows toward a target ratio.
 *
 * `ratio` < 1 shrinks, > 1 grows. A window whose CEILING is 0 stays 0 — the
 * operator has that recording mode off and a storage budget must not turn it
 * on. Results are clamped to [MIN_WINDOW_DAYS, ceiling] so the controller
 * can never exceed what the operator asked for.
 */
export function scaleWindows(
  ceiling: RetentionWindows,
  current: RetentionWindows,
  ratio: number,
): RetentionWindows {
  const next = {} as RetentionWindows;
  for (const k of ["continuous", "motion", "alerts", "detections"] as const) {
    const cap = ceiling[k];
    if (!(cap > 0)) {
      // Disabled at the ceiling — stays disabled, whatever the ratio.
      next[k] = 0;
      continue;
    }
    const base = current[k] > 0 ? current[k] : cap;
    const scaled = Math.round(base * ratio);
    next[k] = Math.min(cap, Math.max(MIN_WINDOW_DAYS, Math.min(MAX_WINDOW_DAYS, scaled)));
  }
  return next;
}

export type BudgetAction = "shrink" | "grow" | "hold";

export interface BudgetDecision {
  action: BudgetAction;
  /** Windows to write. Undefined when action is "hold". */
  windows?: RetentionWindows;
  /** Human-readable reason, surfaced in logs and the activity trail. */
  reason: string;
}

/**
 * Decide what to do for one camera.
 *
 * Returns "hold" — writing nothing — whenever usage is unknown or inside the
 * dead band. Unknown usage is NOT treated as zero: a camera Frigate has no
 * measurement for must keep the retention it has, exactly as an unmeasurable
 * bitrate did in the previous design.
 */
export function decideBudgetAction(
  usedBytes: number | null,
  budgetBytes: number,
  ceiling: RetentionWindows,
  current: RetentionWindows,
): BudgetDecision {
  if (usedBytes === null || !Number.isFinite(usedBytes) || usedBytes < 0) {
    return { action: "hold", reason: "usage not measurable yet" };
  }
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    return { action: "hold", reason: "budget is not a positive size" };
  }

  const ratio = usedBytes / budgetBytes;

  if (ratio > 1) {
    // Shrink toward the budget, but not by more than one step.
    const target = Math.max(MAX_SHRINK_STEP, 1 / ratio);
    const windows = scaleWindows(ceiling, current, target);
    if (sameWindows(windows, current)) {
      return {
        action: "hold",
        reason: "over budget but every managed window is already at its floor",
      };
    }
    return {
      action: "shrink",
      windows,
      reason: `using ${pct(ratio)} of budget`,
    };
  }

  if (ratio < LOW_WATER && !sameWindows(current, ceiling)) {
    const target = Math.min(MAX_GROW_STEP, LOW_WATER / Math.max(ratio, 0.01));
    const windows = scaleWindows(ceiling, current, target);
    if (sameWindows(windows, current)) {
      return { action: "hold", reason: "already at the operator's ceiling" };
    }
    return {
      action: "grow",
      windows,
      reason: `using ${pct(ratio)} of budget, restoring retention`,
    };
  }

  return { action: "hold", reason: `using ${pct(ratio)} of budget` };
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function sameWindows(a: RetentionWindows, b: RetentionWindows): boolean {
  return (
    a.continuous === b.continuous &&
    a.motion === b.motion &&
    a.alerts === b.alerts &&
    a.detections === b.detections
  );
}

/** Turn a window set into the settings patch that writes it. */
export function windowsToPatch(w: RetentionWindows): CameraSettingsPatch {
  return {
    continuousRetainDays: w.continuous,
    motionRetainDays: w.motion,
    alertsRetainDays: w.alerts,
    detectionsRetainDays: w.detections,
  };
}

export interface OverAllocation {
  allocatedBytes: number;
  capacityBytes: number;
  overAllocated: boolean;
}

/**
 * Compare the sum of budgets against the volume.
 *
 * Over-allocation is a warning, not an error — budgets are targets and
 * Frigate evicts oldest-first — but an operator who has promised 3 TB on a
 * 2 TB drive should be told, because the per-camera retention they see is
 * not what they will get once the drive fills.
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
  return { allocatedBytes, capacityBytes, overAllocated: allocatedBytes > capacityBytes };
}

export interface ReconcileResult {
  applied: Array<{ camera: string; action: BudgetAction; windows: RetentionWindows }>;
  held: Array<{ camera: string; reason: string }>;
  /**
   * Cameras whose pass FAILED.
   *
   * This field exists because its absence was itself a defect: without it a
   * pass where every camera errored was byte-identical to a pass where
   * nothing needed doing, and the caller's "log only if something happened"
   * guard suppressed even that. Reporting success never achieved is the
   * failure mode this whole epic was created by (WARP-1849).
   */
  failed: Array<{ camera: string; error: string }>;
}

/**
 * One reconciliation pass over every BUDGET-mode camera.
 *
 * Idempotent: a camera inside the dead band is not written, so a steady
 * system issues no config writes and restarts no cameras.
 *
 * Per-camera failures are collected rather than thrown, so one broken camera
 * cannot strand the rest — but they are RETURNED, and the caller escalates.
 */
export async function reconcileCameraBudgets(
  prisma: PrismaClient,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { applied: [], held: [], failed: [] };

  const budgeted = (await prisma.camera.findMany({
    where: { retentionMode: "BUDGET" },
    select: { name: true, storageBudgetBytes: true, retentionCeiling: true },
  })) as Array<{
    name: string;
    storageBudgetBytes: bigint | null;
    retentionCeiling: unknown;
  }>;

  if (budgeted.length === 0) return result;

  // One storage read for the whole pass.
  const storage = await getCameraStorage();
  const usageByCamera = new Map(storage.cameras.map((c) => [c.camera, c.usedBytes]));

  for (const cam of budgeted) {
    try {
      const budget = cam.storageBudgetBytes === null ? 0 : Number(cam.storageBudgetBytes);
      const current = windowsFromSettings(await getCameraSettings(cam.name));

      // A camera switched to BUDGET before this column existed has no stored
      // ceiling. Capture its live windows as the ceiling rather than assuming
      // one — an assumed ceiling could raise a window the operator had off.
      let ceiling = parseCeiling(cam.retentionCeiling);
      if (ceiling === null) {
        ceiling = current;
        await prisma.camera.update({
          where: { name: cam.name },
          data: { retentionCeiling: ceiling as unknown as object },
        });
        logger.info(
          { camera: cam.name, ceiling },
          "captured retention ceiling from live config",
        );
      }

      const decision = decideBudgetAction(
        usageByCamera.get(cam.name) ?? null,
        budget,
        ceiling,
        current,
      );

      if (decision.action === "hold" || !decision.windows) {
        result.held.push({ camera: cam.name, reason: decision.reason });
        continue;
      }

      await updateCameraSettings(cam.name, windowsToPatch(decision.windows));
      result.applied.push({
        camera: cam.name,
        action: decision.action,
        windows: decision.windows,
      });
      logger.info(
        { camera: cam.name, action: decision.action, windows: decision.windows, reason: decision.reason },
        "adjusted camera retention to track its storage budget",
      );
    } catch (err) {
      result.failed.push({ camera: cam.name, error: (err as Error).message });
      logger.warn(
        { camera: cam.name, err: (err as Error).message },
        "camera storage budget pass failed",
      );
    }
  }

  return result;
}
