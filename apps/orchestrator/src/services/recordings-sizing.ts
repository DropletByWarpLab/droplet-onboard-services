/**
 * WARP-3514 / ADR-070 — sizing for the camera-recordings allocation.
 *
 * ## What this decides
 *
 * Droplet measures every camera, works out how much disk the configured
 * retention window needs, and reserves exactly that on an encrypted bay drive
 * (an ext4 PROJECT QUOTA on `<mount>/nvr`, not a repartition). This module is
 * the arithmetic and nothing else: pure, deterministic, no I/O, so the allocator
 * (what to reserve and when to grow), the API (what `needBytes` to show) and the
 * health check (is the slice too small?) cannot disagree about a single number,
 * and every number is pinned by an exact-value test.
 *
 * ## The formula (WARP-3512 storage contract)
 *
 *   need(camera) = max(p95(MiB/h, last 72 h), latest sample)
 *                  x 24 h x retentionDays x 1.25 headroom x 1.02 snapshots/clips
 *   a camera with a single sample ("no history") = first measurement x 1.5
 *   needTotal    = sum of need, never below 20 GiB
 *
 * Why p95 AND the latest sample: p95 over three days ignores a one-off burst, so
 * the reservation does not balloon after one bad hour; the latest sample stops
 * the reservation lagging a camera whose rate just stepped up (a resolution or
 * codec change). Taking the larger errs on the side of reserving too much — an
 * under-sized slice silently shortens every camera's retention, an over-sized
 * one only holds back space the owner can reclaim.
 *
 * ## Units
 *
 * Frigate reports MiB (not MB) and `CameraBitrateSample.mbPerHour` keeps the
 * unit it was measured in, so `mbPerHour` below is MiB/hour and every byte count
 * is `x MIB`. Byte counts are plain JS numbers (a multi-TB drive is ~4e12, far
 * inside Number.MAX_SAFE_INTEGER); see recordings.types.ts.
 *
 * ## Rounding
 *
 * Byte counts are rounded UP (`Math.ceil`) so a reservation is never a hair
 * short of the need. The expressions are evaluated in the order the spec writes
 * them, left to right; for some round inputs the float product lands a hair
 * above the decimal answer (`ceil(100 GiB x 1.1)` is one byte more than
 * 110 GiB) — one byte, in the safe direction, deterministic.
 */
import type { AllocationModeName, CameraSizing, RecordingsSizing } from "./recordings.types.js";

export const MIB = 1_048_576;
export const GIB = 1_073_741_824;

/** The window the p95 is taken over. Three days smooths the day/night cycle without lagging a real change. */
export const SIZING_WINDOW_HOURS = 72;
/** Reservation = need x 1.25: room for rate drift between measurements and for Frigate's own bookkeeping. */
export const HEADROOM = 1.25;
/** A camera with one sample has not shown its day/night swing yet: size it generously until it has history. */
export const NEW_CAMERA_HEADROOM = 1.5;
/** Snapshots and event clips live in the same slice as the recordings (+2 %). */
export const SNAPSHOT_CLIP_OVERHEAD = 1.02;
/** A box with no cameras (or tiny ones) still reserves this much, so the first camera never starts on a sliver. */
export const NEED_FLOOR_BYTES = 20 * GIB;
/** Grow once the measured need passes this fraction of the reservation… */
export const GROW_TRIGGER_RATIO = 0.85;
/** …and grow to need x 1.1, so one step buys headroom instead of triggering again next hour. */
export const GROW_TARGET_FACTOR = 1.1;
/** A mode switch never lowers the quota below used x 1.1 (Frigate would hit EDQUOT mid-write). */
export const SHRINK_FLOOR_FACTOR = 1.1;
/** Samples older than this are pruned by the sampler. */
export const SAMPLE_RETENTION_DAYS = 14;
/** Fewer samples than this is "no history": the camera is sized from its first measurement alone. */
export const MIN_HISTORY_SAMPLES = 2;

const HOUR_MS = 3_600_000;

/** One hourly reading of a camera's recording rate (a `CameraBitrateSample` row, minus the key). */
export interface BitrateSample {
  sampledAt: Date;
  /** MiB per hour, as Frigate measured it. */
  mbPerHour: number;
}

/** What `cameraNeedBytes` knows about ONE camera; `computeSizing` adds the name. */
export type CameraNeed = Omit<CameraSizing, "name">;

/** The four retention windows the sizing looks at (`CameraRetentionDefaults` satisfies this). */
export interface SizingRetentionWindows {
  continuousDays: number;
  motionDays: number;
  alertsRetainDays: number;
  detectionsRetainDays: number;
}

/** A finite, non-negative number — the only kind of figure the maths accepts as a fact. */
function isKnown(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * Nearest-rank percentile: sort ascending, take the value at rank
 * `ceil(p/100 x n)` (1-based), clamped to the list. Always a real sample, never
 * an interpolation. An empty list is 0 — "no data" must not read as NaN.
 *
 * The rank is computed as `ceil(p x n / 100 - 1e-9)`: for integer p the
 * product is an exact integer and the nudge changes nothing, but for a
 * non-integer p the naive `p / 100 x n` can land a hair above an integer
 * (99.9 / 100 x 1000 = 999.0000000000001) and select the NEXT rank — the
 * maximum, i.e. p100. Non-finite values are ignored; `values` is not mutated.
 */
export function percentile(values: readonly number[], p: number): number {
  if (!Number.isFinite(p)) throw new RangeError("percentile: p must be a finite number");
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p * sorted.length) / 100 - 1e-9);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** A sample the maths may use: a finite, non-negative rate and a real timestamp. */
function isUsableSample(s: BitrateSample): boolean {
  return isKnown(s.mbPerHour) && Number.isFinite(s.sampledAt.getTime());
}

/**
 * The newest (or oldest) sample. Samples sharing that instant resolve to the
 * HIGHER rate, so the answer never depends on the order the rows arrived in and
 * errs towards reserving more. `samples` must not be empty.
 */
function extremeSample(samples: readonly BitrateSample[], newest: boolean): BitrateSample {
  let best = samples[0];
  for (const s of samples) {
    const dt = s.sampledAt.getTime() - best.sampledAt.getTime();
    const moreExtreme = newest ? dt > 0 : dt < 0;
    if (moreExtreme || (dt === 0 && s.mbPerHour > best.mbPerHour)) best = s;
  }
  return best;
}

function bytesFor(mbPerHour: number, retentionDays: number, headroom: number): number {
  return Math.ceil(mbPerHour * MIB * 24 * retentionDays * headroom * SNAPSHOT_CLIP_OVERHEAD);
}

/**
 * One camera's need, in bytes, from its samples (any order, any age up to the
 * 14-day retention).
 *
 *   no usable sample          → { 0, "none", null }
 *   fewer than 2 samples      → "first_measurement": the earliest sample x 1.5
 *   otherwise                 → "history": max(p95 over the last 72 h, latest) x 1.25
 *
 * When NO sample falls inside the 72 h window (a camera that has been off for
 * days) the p95 is taken over every sample instead — stale data beats none.
 * Unusable rows (NaN, negative or infinite rate, invalid date) are dropped
 * rather than allowed to turn the whole reservation into NaN.
 */
export function cameraNeedBytes(samples: readonly BitrateSample[], now: Date, retentionDays: number): CameraNeed {
  if (!(Number.isFinite(retentionDays) && retentionDays > 0)) {
    throw new RangeError("cameraNeedBytes: retentionDays must be a positive, finite number");
  }
  const usable = samples.filter(isUsableSample);
  if (usable.length === 0) return { needBytes: 0, basis: "none", mbPerHour: null };

  if (usable.length < MIN_HISTORY_SAMPLES) {
    const first = extremeSample(usable, false).mbPerHour;
    return {
      needBytes: bytesFor(first, retentionDays, NEW_CAMERA_HEADROOM),
      basis: "first_measurement",
      mbPerHour: first,
    };
  }

  const windowStart = now.getTime() - SIZING_WINDOW_HOURS * HOUR_MS;
  const inWindow = usable.filter((s) => s.sampledAt.getTime() >= windowStart);
  const pool = inWindow.length > 0 ? inWindow : usable;
  const base = Math.max(
    percentile(
      pool.map((s) => s.mbPerHour),
      95,
    ),
    extremeSample(usable, true).mbPerHour,
  );
  return { needBytes: bytesFor(base, retentionDays, HEADROOM), basis: "history", mbPerHour: base };
}

/**
 * The whole box: every camera's need, their sum, and the total with the 20 GiB
 * floor applied.
 *
 * When `configuredCameras` is given, samples of any OTHER name are ignored — a
 * camera deleted mid-window must not keep reserving space for footage that will
 * never be recorded. (An empty list is still a list: no cameras are configured,
 * so the floor applies.) A camera appears in the result if it has an entry in
 * `samplesByCamera`; the order is the map's (the loader sorts by name).
 */
export function computeSizing(
  samplesByCamera: ReadonlyMap<string, readonly BitrateSample[]>,
  now: Date,
  retentionDays: number,
  configuredCameras?: Iterable<string>,
  retentionDaysByCamera?: ReadonlyMap<string, number>,
  retentionKnown = true,
): RecordingsSizing {
  const configured = configuredCameras === undefined ? null : new Set(configuredCameras);
  const cameras: CameraSizing[] = [];
  let overviewRetentionDays = retentionDaysByCamera === undefined ? retentionDays : 0;
  if (retentionDaysByCamera !== undefined && configured !== null) {
    for (const name of configured) {
      overviewRetentionDays = Math.max(overviewRetentionDays, retentionDaysByCamera.get(name) ?? retentionDays);
    }
  }
  for (const [name, samples] of samplesByCamera) {
    if (configured !== null && !configured.has(name)) continue;
    const cameraRetentionDays = retentionDaysByCamera?.get(name) ?? retentionDays;
    overviewRetentionDays = Math.max(overviewRetentionDays, cameraRetentionDays);
    cameras.push({ name, ...cameraNeedBytes(samples, now, cameraRetentionDays) });
  }
  const sumBytes = cameras.reduce((sum, c) => sum + c.needBytes, 0);
  return {
    retentionDays: Math.max(1, overviewRetentionDays),
    ...(retentionKnown ? {} : { retentionKnown: false }),
    cameras,
    sumBytes,
    needTotalBytes: Math.max(sumBytes, NEED_FLOOR_BYTES),
  };
}

/**
 * How many days of footage the slice must hold: the LONGEST of the four
 * retention windows (Frigate keeps a segment while any window still covers it),
 * and at least 1. Snapshots are covered by the 2 % overhead.
 */
export function sizingRetentionDays(defaults: SizingRetentionWindows): number {
  const windows = [
    defaults.continuousDays,
    defaults.motionDays,
    defaults.alertsRetainDays,
    defaults.detectionsRetainDays,
  ].filter(Number.isFinite);
  return Math.max(1, ...windows);
}

export type GrowthAction = "none" | "grow" | "degrade";

export interface GrowthDecision {
  action: GrowthAction;
  /** The new reserved size, set only when `action` is "grow". */
  targetBytes?: number;
  /** Set only when `action` is "grow": the drive cannot give the full need, so the caller also marks DEGRADED. */
  partial?: boolean;
  /** For logs only — never shown to the owner and never carries a label or path. */
  reason: string;
}

export interface GrowthInput {
  mode: AllocationModeName;
  reservedBytes: number;
  needTotalBytes: number;
  /** Bytes the slice holds now. */
  usedBytes: number | null | undefined;
  /** Free bytes on the filesystem (the quota does not limit this figure). */
  fsFreeBytes: number | null | undefined;
  fsSizeBytes: number | null | undefined;
}

/** Everything the slice could ever hold: what it holds now plus all the filesystem has free, never above its size. */
function holdableBytes(usedBytes: number, fsFreeBytes: number, fsSizeBytes: number): number {
  return Math.min(fsSizeBytes, usedBytes + fsFreeBytes);
}

/**
 * Should the quota grow, and to what?
 *
 *   FULL                           → none (the slice already is the filesystem)
 *   need <= 85 % of reserved       → none
 *   target = ceil(need x 1.1) <= reserved → none   (a quota is NEVER shrunk on this path)
 *   room = min(target, holdable) <= reserved → degrade (the drive cannot give more)
 *   otherwise                      → grow to min(target, holdable);
 *                                    `partial` when even that is below the need
 *
 * Figures the host did not report (null / NaN / negative) are not guessed at:
 * the answer is `none`, with a reason. The caller takes no state change on it.
 */
export function growthDecision(input: GrowthInput): GrowthDecision {
  if (input.mode === "FULL") {
    return { action: "none", reason: "whole-drive mode: the slice already is the filesystem" };
  }
  const { reservedBytes, needTotalBytes } = input;
  if (!isKnown(reservedBytes) || !isKnown(needTotalBytes)) {
    return { action: "none", reason: "reserved size or measured need unavailable" };
  }
  if (needTotalBytes <= GROW_TRIGGER_RATIO * reservedBytes) {
    return { action: "none", reason: "the measured need fits within the reserved size" };
  }
  const targetBytes = Math.ceil(needTotalBytes * GROW_TARGET_FACTOR);
  if (targetBytes <= reservedBytes) {
    return { action: "none", reason: "the grow target is not above the reserved size; a quota is never shrunk here" };
  }
  const { usedBytes, fsFreeBytes, fsSizeBytes } = input;
  if (!isKnown(usedBytes) || !isKnown(fsFreeBytes) || !isKnown(fsSizeBytes)) {
    return { action: "none", reason: "filesystem figures unavailable" };
  }
  const reachable = Math.min(targetBytes, holdableBytes(usedBytes, fsFreeBytes, fsSizeBytes));
  if (reachable <= reservedBytes) {
    return { action: "degrade", reason: "the drive has no room to grow the reserved size" };
  }
  const partial = reachable < needTotalBytes;
  return {
    action: "grow",
    targetBytes: reachable,
    partial,
    reason: partial
      ? "growing as far as the drive allows; still below the measured need"
      : "growing to the measured need plus headroom",
  };
}

export interface ReservedForModeInput {
  needTotalBytes: number;
  usedBytes: number;
  fsSizeBytes: number;
  fsFreeBytes: number;
}

function assertKnown(fn: string, figures: Record<string, number>): void {
  for (const [name, value] of Object.entries(figures)) {
    if (!isKnown(value)) throw new RangeError(`${fn}: ${name} must be a finite, non-negative number`);
  }
}

/**
 * What a mode switch reserves.
 *
 *   FULL           → the whole filesystem
 *   AUTO_RESERVED  → min(what the drive can hold, max(need, used x 1.1))
 *
 * Never below used x 1.1 — a quota under the data already there would make
 * Frigate hit EDQUOT mid-write — EXCEPT when the drive itself has no room for
 * that headroom: then it is what the drive can hold, which is still never below
 * what is already there (used + free >= used). Throws on a figure that is not a
 * finite, non-negative number: a NaN quota must never reach the host.
 */
export function reservedForMode(mode: AllocationModeName, input: ReservedForModeInput): number {
  if (mode === "FULL") {
    assertKnown("reservedForMode", { fsSizeBytes: input.fsSizeBytes });
    return input.fsSizeBytes;
  }
  assertKnown("reservedForMode", { ...input });
  const { needTotalBytes, usedBytes, fsSizeBytes, fsFreeBytes } = input;
  const wanted = Math.max(needTotalBytes, Math.ceil(usedBytes * SHRINK_FLOOR_FACTOR));
  // holdableBytes already caps at the filesystem size.
  return Math.min(holdableBytes(usedBytes, fsFreeBytes, fsSizeBytes), wanted);
}

/** The first reservation on a fresh drive: the measured need, or all the drive has free. */
export function initialReservedBytes(needTotalBytes: number, driveFreeBytes: number): number {
  assertKnown("initialReservedBytes", { needTotalBytes, driveFreeBytes });
  return Math.min(needTotalBytes, driveFreeBytes);
}
