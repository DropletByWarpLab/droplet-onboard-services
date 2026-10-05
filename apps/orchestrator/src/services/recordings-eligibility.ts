/**
 * WARP-3514 / ADR-070 — which drives may hold camera recordings.
 *
 * ## The rule (owner decision 2026-10-03)
 *
 * Camera recordings never go on the OS disk and never on a plain drive: an
 * eligible drive is ENCRYPTED (LUKS2) and PREPARED, mounted read-write, not the
 * system disk, SMART not failed, ext4 when the filesystem is reported, and with
 * at least 20 GiB free. Everything the bridge did not positively say is
 * "unknown", and an unknown is INELIGIBLE: on a box whose bridge does not report
 * `encryption` / `preparation` yet (WARP-3513 adds them), every drive is
 * ineligible and the status is `no_eligible_drive`. That is the safe answer —
 * never a guess that a drive is fine.
 *
 * The host re-validates all of it (`droplet-set-nvr-media.sh --apply` refuses a
 * drive that is unmounted, read-only, on the OS disk, unencrypted or without
 * project quota), so this is the first layer, not the only one.
 *
 * ## Input shape
 *
 * `normalizeBridgeDrive` reads one entry of the device-bridge `/drives` snapshot
 * (snake_case: `uuid`, `size_bytes`, `parent_disk`, `readonly`, …) and also the
 * camelCase / contract spellings WARP-3513 adds to the drive objects
 * (`encryption`, `preparation`, `isSystemDisk`, `readOnly`, …), tolerantly: one
 * bad drive must not hide the others, so junk is `null`, never a throw.
 *
 * `preparation` is NOT derived from `encryption`: a drive must SAY it is
 * "prepared". (WARP-3513's raw bridge entries carry `encryption`; whoever feeds
 * this function the raw snapshot must make sure `preparation` is on the object
 * too — recordings-eligibility.test.ts pins this on purpose.)
 */
import type { DriveEncryption, DrivePreparation, RecordingsDriveCandidate } from "./recordings.types.js";
import { NEED_FLOOR_BYTES } from "./recordings-sizing.js";

/**
 * A drive needs at least this much free space to be offered for recordings: the
 * same 20 GiB floor the sizing reserves, so a drive that passes can always take
 * the smallest reservation the allocator will ever make.
 */
export const MIN_RECORDINGS_FREE_BYTES = NEED_FLOOR_BYTES;

/** Stable machine reasons a drive is not eligible. */
export type IneligibleReason =
  | "not_mounted"
  | "read_only"
  | "not_encrypted"
  | "not_prepared"
  | "system_disk"
  | "smart_failed"
  | "not_ext4"
  | "too_small";

/**
 * Every reason this drive is not eligible, in a stable order (empty = eligible).
 * `fsType: null` passes the ext4 check — the bridge did not report one and the
 * host re-validates; an unreported SMART verdict passes for the same reason.
 */
export function ineligibleReasons(d: RecordingsDriveCandidate): IneligibleReason[] {
  const reasons: IneligibleReason[] = [];
  if (!d.mounted) reasons.push("not_mounted");
  if (d.readOnly) reasons.push("read_only");
  if (d.encryption !== "luks2") reasons.push("not_encrypted");
  if (d.preparation !== "prepared") reasons.push("not_prepared");
  if (d.isSystemDisk) reasons.push("system_disk");
  if (d.smart === "FAILED") reasons.push("smart_failed");
  if (d.fsType !== null && d.fsType.toLowerCase() !== "ext4") reasons.push("not_ext4");
  if (d.freeBytes < MIN_RECORDINGS_FREE_BYTES) reasons.push("too_small");
  return reasons;
}

export function isEligibleRecordingsDrive(d: RecordingsDriveCandidate): boolean {
  return ineligibleReasons(d).length === 0;
}

/** Most free space first, then the larger drive, then the lexicographically first filesystem uuid. */
function byPreference(a: RecordingsDriveCandidate, b: RecordingsDriveCandidate): number {
  if (a.freeBytes !== b.freeBytes) return b.freeBytes - a.freeBytes;
  if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes;
  return a.fsUuid < b.fsUuid ? -1 : a.fsUuid > b.fsUuid ? 1 : 0;
}

/**
 * The drive the allocator reserves on: among the eligible ones, the most free
 * space. Total order, so the choice never depends on the order the bridge listed
 * the drives in. `null` when none is eligible.
 */
export function pickRecordingsDrive(drives: readonly RecordingsDriveCandidate[]): RecordingsDriveCandidate | null {
  const eligible = drives.filter(isEligibleRecordingsDrive);
  if (eligible.length === 0) return null;
  return eligible.sort(byPreference)[0];
}

/** What `normalizeBridgeDrive` may know about the host beyond the one drive entry. */
export interface BridgeDriveContext {
  /** Whole-disk kernel name backing the OS (`os_disk` of the snapshot); "" or absent = unknown. */
  osDisk?: string;
  /** The snapshot's physical-disk inventory (`disks[]`) keyed by kernel name — the source of `model`. */
  disksByName?: ReadonlyMap<string, { model?: string }>;
}

/** The first of `keys` that is present (not undefined) on `raw` — the bridge's spelling or the contract's. */
function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined) return raw[key];
  }
  return undefined;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const bytes = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const flag = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/**
 * One entry of the bridge `/drives` snapshot → a `RecordingsDriveCandidate`, or
 * null when it cannot be one (not an object, or no filesystem uuid to target).
 *
 * Missing or unrecognised fields take the CONSERVATIVE value, the one that can
 * only make the drive ineligible: `encryption` / `preparation` "unknown",
 * `mounted` false, `readOnly` true (the bridge's own fail-safe: an unknown mount
 * state must not present as writable), sizes 0. `fsType` and `smart` stay null
 * ("not reported") — the host re-validates the filesystem, and no verdict is not
 * a failing verdict.
 *
 * The drive is the system disk when it says so, OR when its parent disk is the
 * OS disk the snapshot reported. The enums match EXACTLY (`"luks2"`,
 * `"prepared"`): only the contract's own spelling is a positive claim.
 */
export function normalizeBridgeDrive(raw: unknown, ctx: BridgeDriveContext = {}): RecordingsDriveCandidate | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const fsUuid = text(pick(r, "uuid", "fsUuid", "fs_uuid")).trim();
  if (fsUuid === "") return null;

  const parentDisk = text(pick(r, "parent_disk", "parentDisk")).trim() || null;
  const fsType = text(pick(r, "fs", "fsType", "fs_type")).trim() || null;

  const smartVerdict = text(pick(r, "smart")).trim().toUpperCase();
  const smart = smartVerdict === "FAILED" ? "FAILED" : smartVerdict === "PASSED" ? "PASSED" : null;

  const encryptionRaw = pick(r, "encryption");
  const encryption: DriveEncryption = encryptionRaw === "luks2" || encryptionRaw === "none" ? encryptionRaw : "unknown";
  const preparationRaw = pick(r, "preparation");
  const preparation: DrivePreparation =
    preparationRaw === "prepared" || preparationRaw === "needs_preparing" ? preparationRaw : "unknown";

  const onOsDisk = parentDisk !== null && !!ctx.osDisk && parentDisk === ctx.osDisk;

  return {
    fsUuid,
    label: text(pick(r, "label")),
    model: parentDisk !== null ? text(ctx.disksByName?.get(parentDisk)?.model) : "",
    sizeBytes: bytes(pick(r, "size_bytes", "sizeBytes")),
    usedBytes: bytes(pick(r, "used_bytes", "usedBytes")),
    freeBytes: bytes(pick(r, "free_bytes", "freeBytes")),
    mountPath: text(pick(r, "mount", "mountPath", "mount_path")),
    mounted: flag(pick(r, "mounted")) ?? false,
    readOnly: flag(pick(r, "readonly", "readOnly", "read_only")) ?? true,
    fsType,
    encryption,
    preparation,
    isSystemDisk: flag(pick(r, "isSystemDisk", "is_system_disk")) === true || onOsDisk,
    smart,
    parentDisk,
  };
}
