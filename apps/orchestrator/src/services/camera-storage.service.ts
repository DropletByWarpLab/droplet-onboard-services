/**
 * WARP-1850 — NVR storage accounting.
 *
 * Answers the question the dashboard could not previously answer: *which
 * camera is filling the disk, and how long until it's full?*
 *
 * Source of truth is Frigate, via two endpoints:
 *   - `/api/stats`              → volume totals for the recordings mount
 *   - `/api/recordings/storage` → per-camera usage + measured MiB/hr
 *
 * The orchestrator does NOT mount the NVR volume (docker-compose.yml mounts
 * `${NVR_MEDIA_SOURCE}` into `frigate` only), so there is no filesystem path
 * to `du` here — and there shouldn't be. Frigate owns the recordings index;
 * reading bytes behind its back would be a second source of truth, which is
 * the failure mode WARP-1849 was created by.
 *
 * Everything in this module is READ-ONLY. Deletion and expiry belong to
 * Frigate (`record/cleanup.py`, `storage.py`).
 *
 * Units: Frigate reports MiB throughout. We convert to bytes exactly once,
 * at the boundary here, so nothing downstream has to remember the unit.
 */

import { fetchStats, fetchRecordingsStorage, fetchConfig } from "./frigate.client.js";
import { extractStorage, recordingsOnBootDisk } from "./camera-system.service.js";
import { recordActivity } from "./activity.singleton.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("camera-storage");

/** Frigate's own tag for the recordings volume in the stats payload. */
const RECORDINGS_MOUNT_HINT = "recordings";

const MIB = 1024 * 1024;

/**
 * Fraction of the recordings volume in use at which we warn the operator.
 *
 * Frigate starts evicting oldest-first when less than one hour of headroom
 * remains (`check_storage_needs_cleanup`), so a full disk is not data loss —
 * it is *silent shortening of every camera's retention*. The operator asked
 * for 30 days and starts getting 9. That is worth a warning well before the
 * volume is actually full, which is why this sits at 85% rather than 95%.
 */
export const NEAR_FULL_RATIO = 0.85;

export interface CameraStorageRow {
  /** Frigate camera name — the key the rest of the API uses. */
  camera: string;
  /**
   * Bytes this camera's recordings occupy, or `null` when Frigate has no
   * segments for it yet. `null` is NOT 0: "nothing recorded yet" and
   * "recorded nothing measurable" are different facts and the UI renders
   * them differently.
   */
  usedBytes: number | null;
  /** Measured recording rate in bytes/hour, or `null` when not yet known. */
  bytesPerHour: number | null;
  /** This camera's share of the recordings volume, 0–100, when computable. */
  sharePercent: number | null;
  /**
   * Days of footage this camera's current budget of space would cover at the
   * measured rate. `null` when the rate is unknown or zero — deriving a
   * retention from a zero rate yields Infinity, which must never reach the
   * operator or a config write (see WARP-1851).
   */
  daysAtCurrentRate: number | null;
}

export interface CameraStorageSummary {
  /** Recordings volume totals, or `null` when Frigate reports no mount. */
  volume: {
    path: string;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPercent: number;
  } | null;
  /** Per-camera rows, largest consumer first. */
  cameras: CameraStorageRow[];
  /** True when the volume has crossed NEAR_FULL_RATIO. */
  nearFull: boolean;
  /**
   * WARP-1963 — is footage landing on the BOOT DISK instead of the
   * dedicated recordings drive?
   *
   * `true` means the `${NVR_MEDIA_SOURCE:-nvrdata}` mount fell back to the
   * named volume on the system disk: nothing validates that target, so an
   * unset variable or a filesystem that failed to mount is silently
   * absorbed and Frigate records to `/` instead. That is how this box's
   * 1.8 TB RAID1 sat empty for a month while the boot drive filled.
   *
   * `null` = cannot tell (Frigate reported no cache mount to compare
   * against). Reported as unknown rather than guessed either way — a false
   * "all clear" here is the failure mode being fixed.
   */
  recordingsOnBootDisk: boolean | null;
  /**
   * Sum of every camera's measured rate, bytes/hour — how fast the volume
   * fills with all cameras recording. `null` when no camera reports a rate.
   */
  totalBytesPerHour: number | null;
}

/**
 * Build the camera→storage-key mapping.
 *
 * Frigate keys `/api/recordings/storage` by `friendly_name` when a camera
 * defines one, falling back to the camera name. Reversing that here means a
 * camera with a friendly name still resolves to its real name — without
 * this, such cameras vanish from the breakdown entirely.
 *
 * Falls back to identity mapping if the config can't be read; the caller
 * still gets usable rows keyed by whatever Frigate returned.
 */
async function buildStorageKeyToCamera(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const config = (await fetchConfig()) as Record<string, unknown>;
    const cameras = (config.cameras ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, cam] of Object.entries(cameras)) {
      const friendly = typeof cam?.friendly_name === "string" ? cam.friendly_name : null;
      map.set(friendly || name, name);
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "could not read Frigate config to resolve friendly names; using storage keys as-is",
    );
  }
  return map;
}

/** Pull the recordings mount out of Frigate's stats payload. */
function extractVolume(
  stats: Record<string, unknown>,
): CameraStorageSummary["volume"] {
  const service = (stats.service ?? {}) as Record<string, unknown>;
  const storage = (service.storage ?? {}) as Record<string, Record<string, unknown>>;

  // Frigate keys this by mount path. Prefer the recordings mount; fall back
  // to the single entry when there's only one, so an unusual mount layout
  // still reports something rather than silently nothing.
  const entries = Object.entries(storage);
  if (entries.length === 0) return null;

  const match =
    entries.find(([path]) => path.includes(RECORDINGS_MOUNT_HINT)) ??
    (entries.length === 1 ? entries[0] : undefined);
  if (!match) return null;

  const [path, raw] = match;
  const totalMib = Number(raw.total ?? 0);
  const usedMib = Number(raw.used ?? 0);
  const freeMib = Number(raw.free ?? 0);
  if (!Number.isFinite(totalMib) || totalMib <= 0) return null;

  return {
    path,
    totalBytes: Math.round(totalMib * MIB),
    usedBytes: Math.round(usedMib * MIB),
    freeBytes: Math.round(freeMib * MIB),
    usedPercent: Math.round((usedMib / totalMib) * 1000) / 10,
  };
}

/**
 * Read the current storage picture.
 *
 * Throws if Frigate is unreachable — callers must surface that as a degraded
 * state rather than rendering zeros. A zeroed breakdown is indistinguishable
 * from "nothing is using disk", which is exactly the misreading that let
 * WARP-1849's dead purge look healthy for its entire life.
 */
export async function getCameraStorage(): Promise<CameraStorageSummary> {
  const [stats, usage, keyToCamera] = await Promise.all([
    fetchStats(),
    fetchRecordingsStorage(),
    buildStorageKeyToCamera(),
  ]);

  const volume = extractVolume(stats);

  const cameras: CameraStorageRow[] = Object.entries(usage).map(([key, raw]) => {
    const camera = keyToCamera.get(key) ?? key;

    // `usage` is null for a camera with no segments — preserve that.
    const usedMib =
      raw?.usage === null || raw?.usage === undefined ? null : Number(raw.usage);
    const usedBytes =
      usedMib === null || !Number.isFinite(usedMib) ? null : Math.round(usedMib * MIB);

    const bwMib = Number(raw?.bandwidth ?? 0);
    // A rate of 0 means "not measured yet", not "uses no space" — Frigate
    // seeds bandwidth to 0 before it has segments to average.
    const bytesPerHour =
      Number.isFinite(bwMib) && bwMib > 0 ? Math.round(bwMib * MIB) : null;

    const sharePercent =
      volume && usedBytes !== null && volume.totalBytes > 0
        ? Math.round((usedBytes / volume.totalBytes) * 1000) / 10
        : null;

    const daysAtCurrentRate =
      usedBytes !== null && bytesPerHour !== null && bytesPerHour > 0
        ? Math.round((usedBytes / (bytesPerHour * 24)) * 10) / 10
        : null;

    return { camera, usedBytes, bytesPerHour, sharePercent, daysAtCurrentRate };
  });

  // Largest consumer first — the operator's question is "what do I trim?".
  // Unknown usage sorts last rather than as zero.
  cameras.sort((a, b) => (b.usedBytes ?? -1) - (a.usedBytes ?? -1));

  const rates = cameras
    .map((c) => c.bytesPerHour)
    .filter((r): r is number => r !== null);
  const totalBytesPerHour = rates.length
    ? rates.reduce((sum, r) => sum + r, 0)
    : null;

  // Reuse the typed, deduplicated volume list rather than re-parsing the
  // stats blob: the boot-disk check compares the recordings mount against
  // the cache mount, and that comparison is only meaningful on rows that
  // already agree on units and role.
  const onBootDisk = recordingsOnBootDisk(
    extractStorage((stats.service ?? {}) as Record<string, unknown>),
  );

  return {
    volume,
    cameras,
    nearFull: volume ? volume.usedPercent >= NEAR_FULL_RATIO * 100 : false,
    recordingsOnBootDisk: onBootDisk,
    totalBytesPerHour,
  };
}

/**
 * Edge state for the near-full warning.
 *
 * The warning is EDGE-triggered: one ActivityRow when the volume crosses
 * the threshold, and nothing further until it drops back below. A
 * level-triggered check would post a row on every tick, and an operator
 * who sees the same warning hourly stops reading it — which is how the
 * signal dies exactly when it starts mattering.
 *
 * Deliberately in-process, not persisted. A restart re-arms the warning,
 * so a still-full volume warns once more after a reboot. That is the safe
 * direction to be wrong in: the alternative (a persisted "already warned"
 * flag) can silently swallow the warning forever if it is ever written
 * without the matching clear.
 */
let lastNearFull: boolean | null = null;

/** Test seam — reset the edge state between cases. */
export function __resetNearFullState(): void {
  lastNearFull = null;
}

export interface NearFullCheck {
  nearFull: boolean;
  /** True when this tick actually emitted a warning. */
  warned: boolean;
}

/**
 * One near-full check. Records an ActivityRow only on the transition into
 * the near-full state.
 *
 * Frigate being unreachable is NOT reported as "fine" — the tick throws so
 * the cron canary counts it, and the edge state is left untouched so a
 * transient outage can't silently consume the crossing.
 */
export async function checkStorageNearFull(): Promise<NearFullCheck> {
  const summary = await getCameraStorage();
  const { nearFull, volume } = summary;

  const crossed = nearFull && lastNearFull !== true;
  lastNearFull = nearFull;

  if (!crossed) return { nearFull, warned: false };

  const biggest = summary.cameras.find((c) => c.usedBytes !== null);
  await recordActivity({
    kind: "camera",
    severity: "warn",
    sourceIcon: "video",
    what: "Camera storage is nearly full",
    actor: { type: "system" },
    sub: volume
      ? `${volume.usedPercent}% of the recording drive is in use`
      : "recording drive is nearly full",
    refs: {
      usedPercent: volume?.usedPercent ?? null,
      freeBytes: volume?.freeBytes ?? null,
      thresholdPercent: NEAR_FULL_RATIO * 100,
      largestCamera: biggest?.camera ?? null,
      largestCameraBytes: biggest?.usedBytes ?? null,
    },
  });

  logger.warn(
    { usedPercent: volume?.usedPercent, largestCamera: biggest?.camera },
    "camera storage crossed the near-full threshold",
  );

  return { nearFull, warned: true };
}
