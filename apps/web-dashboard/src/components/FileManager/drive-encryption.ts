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
