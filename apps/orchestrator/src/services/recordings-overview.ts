/**
 * WARP-3514 / ADR-070 — what the recordings allocation IS right now: a status,
 * a list of warnings and the `GET /api/storage/recordings` body, all derived
 * from one `RecordingsFacts` (collected once per read, tick or health check).
 *
 * Pure, so the API, the hourly health check and the allocator agree on what
 * "active" or "missing" means — and so each precedence rule has an exact test.
 * The rules encode product behaviour:
 *
 *   - LIVE TRUTH BEATS A STALE ROW. A row that says ACTIVE while the drive is
 *     gone is `missing`; a row that says MISSING while the drive is back is
 *     recovering, not missing (the allocator re-applies it on its next tick).
 *   - AN UNREACHABLE BRIDGE IS NOT "ALL CLEAR" AND NOT "ON THE OS DISK". With
 *     `host === null` the checks that need the host are skipped, never guessed;
 *     the row and the drive list still prove what they can.
 *   - ON THE SYSTEM DISK is a warning even with no cameras and no allocation:
 *     recordings never belong there (owner decision 2026-10-03), so the moment
 *     the target is the OS disk the owner is told.
 *
 * Nothing here ever puts a drive label, mount path or device path into a
 * warning (WARP-3466: they can carry text from a plugged-in disk, and the
 * messages become notification bodies). The API body itself is owner/admin-only
 * and does carry `drive.label` / `drive.mountPath`, as the contract says.
 */
import type {
  NvrHostStatus,
  RecordingsDriveCandidate,
  RecordingsFacts,
  RecordingsOverview,
  RecordingsStatus,
  RecordingsWarning,
  RecordingsWarningCode,
} from "./recordings.types.js";
import { isEligibleRecordingsDrive } from "./recordings-eligibility.js";
import { GROW_TRIGGER_RATIO, MIB, growthDecision } from "./recordings-sizing.js";

/**
 * The owner-facing sentence for each warning code. Plain language, no labels,
 * no paths, no device names — see the module header. They are also the
 * notification bodies of the hourly recordings-health check.
 */
export const RECORDINGS_WARNING_MESSAGES: Readonly<Record<RecordingsWarningCode, string>> = Object.freeze({
  drive_missing:
    "The drive that holds your camera recordings is not connected, so new footage cannot be saved. " +
    "Reconnect the drive to resume recording; footage is never written to the system disk in its place.",
  read_only:
    "The drive that holds your camera recordings is mounted read-only, so new footage cannot be saved. " +
    "Check the drive for errors, or disconnect and reconnect it.",
  near_full:
    "The space set aside for camera recordings is almost full. When it fills, the oldest footage is removed first, " +
    "so some days may be kept for less time than your retention setting.",
  cannot_grow:
    "Your cameras need more recording space than this drive can provide. " +
    "Free up space on the drive, shorten how long recordings are kept, or add a larger encrypted drive.",
  on_system_disk:
    "Camera recordings are currently being saved on the system disk. " +
    "Once an encrypted storage drive is ready, Droplet moves them there automatically; until then the system disk can fill up.",
  smart_failed:
    "The drive that holds your camera recordings reports that its own health check is failing. " +
    "Back up anything you need and replace the drive soon.",
  not_encrypted:
    "The drive that holds your camera recordings is not encrypted. " +
    "Droplet only keeps recordings on encrypted drives, so choose an encrypted drive for them.",
});

/** The warnings that make an otherwise healthy allocation `degraded`. */
const DEGRADING: ReadonlySet<RecordingsWarningCode> = new Set<RecordingsWarningCode>([
  "read_only",
  "smart_failed",
  "cannot_grow",
]);

/** The row's drive, when the bridge lists it mounted. */
function allocatedDrive(facts: RecordingsFacts): RecordingsDriveCandidate | undefined {
  const a = facts.allocation;
  return a ? facts.drives.find((d) => d.fsUuid === a.fsUuid && d.mounted) : undefined;
}

/** The host record when Frigate records onto a bay PATH that is not mounted — an unmounted bay resolves onto `/` host-side. */
function hostPathUnmounted(host: NvrHostStatus | null): boolean {
  return host !== null && host.kind === "path" && !host.mounted;
}

/** The host record, but only when Frigate records onto a MOUNTED bay path (the filesystem figures are then the bay's). */
function mountedBayHost(host: NvrHostStatus | null): NvrHostStatus | null {
  return host !== null && host.kind === "path" && host.mounted ? host : null;
}

/** Bytes the recordings hold now: the host's quota usage, else Frigate's own volume figure, else unknown. */
function usedBytesOf(facts: RecordingsFacts): number | null {
  return facts.host?.usedBytes ?? facts.frigate?.volume?.usedBytes ?? null;
}

/**
 * Can the slice not reach the measured need? Either the growth maths says there
 * is no room (or only partial room) on the drive, or the move itself failed for
 * lack of space. Never guessed: with any figure unknown the answer is no.
 */
function cannotGrow(facts: RecordingsFacts, drive: RecordingsDriveCandidate | undefined): boolean {
  const a = facts.allocation;
  if (!a) return false;
  const m = facts.migration;
  if (m !== null && m.state === "failed" && m.errorCode === "insufficient_space") return true;
  if (a.mode !== "AUTO_RESERVED") return false;

  const bay = mountedBayHost(facts.host);
  const decision = growthDecision({
    mode: a.mode,
    reservedBytes: a.reservedBytes,
    needTotalBytes: facts.sizing.needTotalBytes,
    usedBytes: usedBytesOf(facts),
    fsFreeBytes: bay?.fsFreeBytes ?? drive?.freeBytes ?? null,
    fsSizeBytes: bay?.fsSizeBytes ?? drive?.sizeBytes ?? null,
  });
  return decision.action === "degrade" || (decision.action === "grow" && decision.partial === true);
}

/** Is the slice at 85 % of what it may hold? (FULL: of the filesystem; otherwise of the reservation.) */
function nearFull(facts: RecordingsFacts, drive: RecordingsDriveCandidate | undefined): boolean {
  const a = facts.allocation;
  if (!a) return false;
  const used = usedBytesOf(facts);
  if (used === null) return false;
  const capacity =
    a.mode === "FULL"
      ? (mountedBayHost(facts.host)?.fsSizeBytes ?? drive?.sizeBytes ?? a.reservedBytes)
      : a.reservedBytes;
  return capacity > 0 && used / capacity >= GROW_TRIGGER_RATIO;
}

/**
 * Every warning that applies, in a stable order:
 * drive_missing, read_only, smart_failed, not_encrypted, on_system_disk,
 * cannot_grow, near_full.
 */
export function deriveRecordingsWarnings(facts: RecordingsFacts): RecordingsWarning[] {
  const a = facts.allocation;
  const host = facts.host;
  const d = allocatedDrive(facts);
  const bay = mountedBayHost(host);
  const codes: RecordingsWarningCode[] = [];

  if (a && (!d || hostPathUnmounted(host))) codes.push("drive_missing");
  if (d?.readOnly || (bay !== null && !bay.rw)) codes.push("read_only");
  if (d?.smart === "FAILED") codes.push("smart_failed");
  if (a && ((d !== undefined && d.encryption !== "luks2") || (bay !== null && !bay.encrypted))) codes.push("not_encrypted");
  if (host !== null && (host.kind === "volume" || host.isSystemDisk) && !hostPathUnmounted(host)) codes.push("on_system_disk");
  if (cannotGrow(facts, d)) codes.push("cannot_grow");
  if (nearFull(facts, d)) codes.push("near_full");

  return codes.map((code) => ({ code, message: RECORDINGS_WARNING_MESSAGES[code] }));
}

/** First match wins; see `deriveRecordingsStatus`. */
function statusFrom(facts: RecordingsFacts, warnings: readonly RecordingsWarning[]): RecordingsStatus {
  const a = facts.allocation;
  const host = facts.host;
  // Frigate records onto the OS disk (a named volume, or a bay path that resolved onto `/`
  // is NOT this: an unmounted bay path is `missing`, see hostPathUnmounted).
  const onOsDisk = host !== null && (host.kind === "volume" || host.isSystemDisk) && !hostPathUnmounted(host);
  const eligible = facts.drives.some(isEligibleRecordingsDrive);

  // No row yet. With somewhere to move them, recordings on the OS disk are
  // `on_system_disk`; a drive that qualifies but has no row is about to get one
  // (`pending`); with nothing eligible there is nothing to move to.
  if (!a) {
    if (onOsDisk && eligible) return "on_system_disk";
    return eligible ? "pending" : "no_eligible_drive";
  }

  // 1. The drive is gone — whatever the row says. (A MISSING row whose drive is
  //    back is recovering: it falls through to the live checks below.)
  if (!allocatedDrive(facts) || hostPathUnmounted(host)) return "missing";

  // 2. A move in flight (a FAILED move is `degraded` until it is retried).
  if (a.status === "MIGRATING") {
    const m = facts.migration;
    return m !== null && m.state === "failed" && m.job === "migrate" ? "degraded" : "migrating";
  }

  // 3. Recording (or trying to), with something that needs the owner. A failing
  //    or read-only drive is NEVER auto-moved: it stays `degraded` + a warning.
  if (a.status === "DEGRADED" || warnings.some((w) => DEGRADING.has(w.code))) return "degraded";

  // 4. The row says bay drive, the host says OS disk (the allocator re-applies;
  //    after the retries are exhausted the row stays PENDING and this is what the
  //    owner sees, together with the on_system_disk warning).
  if (onOsDisk) return "on_system_disk";

  // 5-6. Not applied yet / recording on the slice.
  return a.status === "PENDING" ? "pending" : "active";
}

/**
 * The one status word for the recordings allocation. Precedence (WARP-3514,
 * settled 2026-10-04):
 *
 *   missing > migrating > degraded > on_system_disk > pending > active > no_eligible_drive
 *
 * concretely, first match wins:
 *
 *   no row  → `on_system_disk` if Frigate records on the OS disk AND a drive qualifies,
 *             else `pending` if a drive qualifies, else `no_eligible_drive`
 *   1. the drive is gone                                     → `missing`
 *   2. MIGRATING                                             → `degraded` if the move failed, else `migrating`
 *   3. DEGRADED, or read-only / SMART failed / cannot grow   → `degraded`
 *   4. the host records on the OS disk                       → `on_system_disk`
 *   5. PENDING                                               → `pending`
 *   6. otherwise                                             → `active`
 *
 * With `host === null` (bridge down) the checks that need the host are skipped.
 */
export function deriveRecordingsStatus(facts: RecordingsFacts): RecordingsStatus {
  return statusFrom(facts, deriveRecordingsWarnings(facts));
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The customer-facing name of a camera, falling back to its own name; an inherited property is never a display name. */
function displayNameOf(names: Readonly<Record<string, string>>, camera: string): string {
  const v = Object.prototype.hasOwnProperty.call(names, camera) ? names[camera] : undefined;
  return typeof v === "string" && v !== "" ? v : camera;
}

/** Room left: in the slice, or in the whole drive for FULL, or — with no slice — on the volume Frigate records onto. */
function freeBytesOf(facts: RecordingsFacts, usedBytes: number): number {
  const a = facts.allocation;
  if (!a) return facts.frigate?.volume?.freeBytes ?? 0;
  const sliceFree = Math.max(0, a.reservedBytes - usedBytes);
  return a.mode === "FULL" ? (mountedBayHost(facts.host)?.fsFreeBytes ?? sliceFree) : sliceFree;
}

/** `GET /api/storage/recordings` — the WARP-3512 storage contract, field for field. */
export function buildRecordingsOverview(facts: RecordingsFacts): RecordingsOverview {
  const a = facts.allocation;
  const host = facts.host;
  const d = allocatedDrive(facts);
  const warnings = deriveRecordingsWarnings(facts);

  // The row's drive; failing that, the drive the host says Frigate records onto.
  const hostFsUuid = host?.fsUuid ?? null;
  const driveRow = d ?? (hostFsUuid !== null ? facts.drives.find((x) => x.fsUuid === hostFsUuid) : undefined);

  const reservedBytes = a?.reservedBytes ?? 0;
  const usedBytes = usedBytesOf(facts) ?? 0;
  const freeBytes = freeBytesOf(facts, usedBytes);

  const totalBytesPerHour = facts.frigate?.totalBytesPerHour ?? 0;
  const daysStored = totalBytesPerHour > 0 ? round1(usedBytes / (totalBytesPerHour * 24)) : 0;

  // Every camera Frigate or the sizing knows about; the rate is Frigate's current one when it has it,
  // else the sizing's measured one, else 0 (never null/NaN — "unknown" reads as 0 in the contract).
  const frigateByName = new Map((facts.frigate?.cameras ?? []).map((c) => [c.camera, c] as const));
  const sizingByName = new Map(facts.sizing.cameras.map((c) => [c.name, c] as const));
  const cameras = [...new Set([...frigateByName.keys(), ...sizingByName.keys()])]
    .map((name) => {
      const f = frigateByName.get(name);
      const s = sizingByName.get(name);
      const rate = f?.bytesPerHour;
      const mbPerHour = typeof rate === "number" && Number.isFinite(rate) ? rate / MIB : (s?.mbPerHour ?? 0);
      return {
        name,
        displayName: displayNameOf(facts.cameraNames, name),
        mbPerHour: round2(mbPerHour),
        gbPerDay: round2((mbPerHour * 24) / 1024),
        needBytes: s?.needBytes ?? 0,
        usedBytes: f?.usedBytes ?? 0,
      };
    })
    .sort((x, y) => y.usedBytes - x.usedBytes || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));

  // A delete-old job is not a migration: its progress must not read as one.
  const m = facts.migration;
  const migration: RecordingsOverview["migration"] =
    m === null || m.job === "delete_old"
      ? { state: "idle", progressPct: 0, bytesCopied: 0, bytesTotal: 0, startedAt: null, error: null }
      : {
          state: m.state,
          progressPct: m.progressPct,
          bytesCopied: m.bytesCopied,
          bytesTotal: m.bytesTotal,
          startedAt: m.startedAt,
          error: m.error,
        };

  const old = m?.oldSource ?? null;

  return {
    status: statusFrom(facts, warnings),
    mode: a ? (a.mode === "FULL" ? "full" : "auto_reserved") : null,
    drive: driveRow
      ? {
          fsUuid: driveRow.fsUuid,
          label: driveRow.label,
          model: driveRow.model,
          sizeBytes: driveRow.sizeBytes,
          encrypted: driveRow.encryption === "luks2",
          mountPath: driveRow.mountPath,
        }
      : null,
    reservedBytes,
    usedBytes,
    freeBytes,
    needBytes: facts.sizing.needTotalBytes,
    retentionDays: facts.sizing.retentionDays,
    daysStored,
    cameras,
    migration,
    oldFootage: {
      present: old !== null && !old.deleted,
      bytes: old?.bytes ?? 0,
      location: old?.kind === "path" ? "other_drive" : "system_disk",
    },
    warnings,
    eligibleDrives: facts.drives.filter(isEligibleRecordingsDrive).map((e) => ({
      fsUuid: e.fsUuid,
      label: e.label,
      sizeBytes: e.sizeBytes,
      freeBytes: e.freeBytes,
      encrypted: true,
    })),
  };
}
