/**
 * WARP-3515 — what a drive object says about its encryption and its job.
 *
 * WARP-3513 (ADR-070) adds `encryption`, `preparation`, `usage` and
 * `isSystemDisk` to the objects GET /api/storage/drives returns. They land
 * separately from the dashboard, so every helper has a third answer for "the
 * orchestrator did not say": `unreported`. The UI then says nothing about
 * encryption — it never guesses a drive is plain, and above all never claims a
 * drive is encrypted it has not been told is.
 *
 * Pure (no React, no fetch): shared by the Storage panel's drive cards, the
 * Prepare drive gate and the Danger zone's reformat picker.
 */
import type { DriveInfo } from "@/lib/types";
import { drivePoolName } from "./drive-display";

/** The fields these helpers read; a full DriveInfo satisfies it. */
type EncryptionFields = Pick<DriveInfo, "encryption" | "preparation">;
type UsageFields = Pick<DriveInfo, "usage">;

export type DriveEncryptionState =
  | "encrypted"
  | "needs_preparing"
  | "unknown"
  /** The orchestrator said nothing about encryption (predates WARP-3513). */
  | "unreported";

export function driveEncryptionState(d: EncryptionFields): DriveEncryptionState {
  const { encryption, preparation } = d;
  if (encryption === undefined && preparation === undefined) return "unreported";
  // The explicit enum is authoritative: it is the state the backend branches on,
  // and "needs preparing" must never be talked down by a stale `encryption`.
  if (preparation === "needs_preparing") return "needs_preparing";
  if (preparation === "prepared") {
    // `prepared` means encrypted and ready — unless `encryption` flatly says
    // none, in which case the two disagree and we claim neither.
    return encryption === "none" ? "unknown" : "encrypted";
  }
  if (encryption === "luks2") return "encrypted";
  if (encryption === "none") return "needs_preparing";
  return "unknown";
}

/** True when any drive carries either field — i.e. the orchestrator is new
 *  enough that "encrypted"/"prepare" wording is truthful on this box. */
export function isEncryptionReported(drives: ReadonlyArray<EncryptionFields>): boolean {
  return drives.some((d) => d.encryption !== undefined || d.preparation !== undefined);
}

/** The active camera-recordings drive. */
export function isRecordingsDrive(d: UsageFields): boolean {
  return d.usage?.role === "recordings";
}

/** Bytes set aside for recordings on this drive, or null (not the recordings
 *  drive, or no reservation). */
export function recordingsReservedBytes(d: UsageFields): number | null {
  if (!isRecordingsDrive(d)) return null;
  return d.usage?.reservedBytes ?? null;
}

/**
 * Whether the "Prepare drive" action (erase + set up encrypted) may be offered
 * on a MOUNTED drive. `wholeDisk` is the whole-disk kernel name the caller
 * resolved (`parent_disk`, else `wholeDiskName(device)`); "" means it is not a
 * disk the host script can act on (a mapper node, a loop device, …).
 *
 * The orchestrator and the host script are the real gates (owner/admin role,
 * OS-disk refusal, the active-recordings-drive 409); this is the front-line
 * "don't even offer it":
 *   - only a drive KNOWN to be plain (an orchestrator that reports nothing
 *     gets no Prepare button — we would be guessing),
 *   - never the install disk,
 *   - never the drive recordings are being written to,
 *   - never a pool-backed volume (a pool is prepared from its own card).
 */
export function canPrepareDrive(
  d: EncryptionFields &
    UsageFields &
    Pick<DriveInfo, "isSystemDisk" | "device" | "pool">,
  wholeDisk: string,
): boolean {
  if (driveEncryptionState(d) !== "needs_preparing") return false;
  if (d.isSystemDisk === true) return false;
  if (isRecordingsDrive(d)) return false;
  if (drivePoolName(d)) return false;
  return wholeDisk !== "";
}

/**
 * Which drive did a Prepare / pool format just create?
 *
 * The recovery key is requested by drive id, and the id is the NEW filesystem's
 * UUID (erasing a drive gives it a fresh one), so after the wipe the panel has
 * to find it in the refreshed list. Preference order:
 *
 *   1. one NEW encrypted drive on the pool array or disk that was just prepared (the
 *      orchestrator's `pool` annotation / the bridge's `parent_disk`);
 *   2. otherwise the ONE new encrypted drive with no source identity. A
 *      mapper node has no recognisable whole-disk name, so older bridges leave
 *      `parent_disk` unset.
 *
 * Several candidates and no way to tell them apart returns `undefined`: handing
 * the owner another drive's recovery key would be worse than asking them to try
 * again.
 */
export function pickPreparedDrive(
  drives: readonly DriveInfo[],
  query: { diskName?: string; poolDevice?: string; knownUuids: ReadonlySet<string> },
): DriveInfo | undefined {
  const candidates = drives.filter(
    (d) => d.uuid && !query.knownUuids.has(d.uuid) && driveEncryptionState(d) === "encrypted",
  );
  const matches = candidates.filter((d) =>
    query.poolDevice
      ? drivePoolName(d) === query.poolDevice
      : query.diskName && !drivePoolName(d) && d.parent_disk === query.diskName,
  );
  if (matches.length > 0) return matches.length === 1 ? matches[0] : undefined;
  // An explicit different identity must never become the fallback: its key
  // belongs to another source even while the requested source's listing lags.
  const unidentified = candidates.filter((d) => !drivePoolName(d) && !d.parent_disk);
  return unidentified.length === 1 ? unidentified[0] : undefined;
}

/**
 * Resolve the id of a drive that is still appearing. The host mounts the new
 * filesystem as the last step of the op, but the bridge caches its drive
 * snapshot for a few seconds, so the first refresh can miss it: retry, spaced
 * out, before telling the owner it is "not visible yet". A failing refresh is
 * "not yet", never an error; the dialog that awaits this has its own retry.
 */
export async function resolveNewDriveId({
  refresh,
  pick,
  current,
  attempts = 3,
  delayMs = 1500,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  isCancelled = () => false,
}: {
  refresh: () => Promise<{ drives?: DriveInfo[] } | undefined>;
  pick: (drives: DriveInfo[]) => DriveInfo | undefined;
  /** The panel's latest list, used when a refresh hands back nothing. */
  current: () => DriveInfo[];
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Checked before every attempt: a lookup whose panel has gone away stops
   *  polling instead of refreshing a list nobody is looking at. */
  isCancelled?: () => boolean;
}): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (isCancelled()) return null;
    let fresh: DriveInfo[] | undefined;
    try {
      fresh = (await refresh())?.drives;
    } catch {
      fresh = undefined;
    }
    const found = pick(fresh ?? current());
    if (found?.uuid) return found.uuid;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return null;
}
