/**
 * WARP-3514 / ADR-070 — types shared by the recordings-allocation services,
 * the bridge client, the routes and the tests.
 *
 * Three groups, in the order data flows:
 *
 *   1. HOST FACTS   what the device-bridge (`/host/nvr-storage*`, `/drives`)
 *                   and Frigate report. Wire shapes — see
 *                   docs/mobile-api-contract.md and the bridge handlers.
 *   2. DERIVED      the allocator's inputs/outputs (`RecordingsFacts`, sizing).
 *   3. API          `GET /api/storage/recordings` — exactly the WARP-3512
 *                   storage contract. Do NOT add or rename fields here without
 *                   changing that contract (WARP-3515's dashboard codes to it).
 *
 * Units: every `*Bytes` field is a plain JS number of BYTES (a multi-TB drive is
 * ~4e12, far inside Number.MAX_SAFE_INTEGER). The DB column is BIGINT; convert
 * once at the repository boundary, never inside the maths.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. HOST FACTS
// ─────────────────────────────────────────────────────────────────────────────

export type DriveEncryption = "luks2" | "none" | "unknown";
export type DrivePreparation = "prepared" | "needs_preparing" | "unknown";

/**
 * One mounted data drive, normalised from the device-bridge `/drives` snapshot
 * (`normalizeBridgeDrive`). WARP-3513 adds `encryption` / `preparation` /
 * `isSystemDisk` to the drive objects; until it lands those are absent on the
 * wire and normalise to "unknown" — which is INELIGIBLE, so on a box with no
 * prepared drive the status is `no_eligible_drive`, never a guess.
 */
export interface RecordingsDriveCandidate {
  /** Filesystem UUID — the key of StorageAllocation and of `Drive`. */
  fsUuid: string;
  label: string;
  model: string;
  sizeBytes: number;
  usedBytes: number;
  freeBytes: number;
  mountPath: string;
  mounted: boolean;
  readOnly: boolean;
  /** e.g. "ext4"; null when the bridge did not report one. */
  fsType: string | null;
  encryption: DriveEncryption;
  preparation: DrivePreparation;
  isSystemDisk: boolean;
  /** Bridge SMART verdict; null when unknown / smartctl disabled. */
  smart: "PASSED" | "FAILED" | null;
  /** Whole-disk kernel name backing the drive (`parent_disk`), when known. */
  parentDisk: string | null;
}

/** `GET /host/nvr-storage` (device-bridge) — the ground truth of where Frigate records. */
export interface NvrHostStatus {
  /** `NVR_MEDIA_SOURCE` as the host sees it (`nvrdata` when unset). */
  source: string;
  kind: "volume" | "path";
  fsUuid: string | null;
  mountPath: string | null;
  /** Physical disk kernel name(s), comma-joined; null when unresolvable. */
  physicalDisk: string | null;
  /** Every kernel/mapper name in the source's device chain (disk, part, crypt, md, …). */
  backingDevices: string[];
  isSystemDisk: boolean;
  encrypted: boolean;
  mounted: boolean;
  rw: boolean;
  projectId: number | null;
  limitBytes: number | null;
  usedBytes: number | null;
  fsSizeBytes: number | null;
  fsFreeBytes: number | null;
}

export type MigrationJobState = "idle" | "running" | "done" | "failed";

/** `GET /host/nvr-storage/migrate`. */
export interface NvrMigrationStatus {
  state: MigrationJobState;
  /** Which job the state belongs to; null when idle. */
  job: "migrate" | "delete_old" | null;
  phase: string | null;
  progressPct: number;
  bytesCopied: number;
  bytesTotal: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** insufficient_space | rsync_missing | docker_unavailable | target_not_applied | bad_source |
   *  copy_failed | verify_failed | flip_failed | interrupted | no_old_footage | delete_failed | internal */
  errorCode: string | null;
  /** The previous recordings source, kept after a migration until the owner deletes it. */
  oldSource: { kind: "volume" | "path"; source: string; bytes: number; deleted: boolean } | null;
}

export type NvrApplyMode = "reserved" | "full";

// ─────────────────────────────────────────────────────────────────────────────
// 2. DERIVED
// ─────────────────────────────────────────────────────────────────────────────

export type AllocationModeName = "AUTO_RESERVED" | "FULL";
export type AllocationStatusName = "PENDING" | "MIGRATING" | "ACTIVE" | "DEGRADED" | "MISSING";

/** A StorageAllocation row with BIGINT converted to number. */
export interface AllocationRecord {
  id: string;
  fsUuid: string;
  mode: AllocationModeName;
  reservedBytes: number;
  status: AllocationStatusName;
  /** Failed moves onto this drive since it was last confirmed (drives the 1 h / 6 h / 24 h retry schedule). */
  migrationFailures: number;
  /** When the most recent failed move ended — the retry clock; null until one failed. */
  lastFailureAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SizingBasis = "history" | "first_measurement" | "none";

export interface CameraSizing {
  name: string;
  /** The rate the need was computed from (MiB/h); null when no sample exists. */
  mbPerHour: number | null;
  needBytes: number;
  basis: SizingBasis;
}

export interface RecordingsSizing {
  retentionDays: number;
  /** False when the resolved Frigate policy was unavailable or omitted a configured camera. */
  retentionKnown?: boolean;
  cameras: CameraSizing[];
  /** Σ per-camera need, before the floor. */
  sumBytes: number;
  /** max(sumBytes, 20 GiB). */
  needTotalBytes: number;
}

/** What Frigate says right now. `null` on RecordingsFacts when Frigate is unreachable. */
export interface RecordingsFrigateFacts {
  volume: {
    path: string;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPercent: number;
  } | null;
  cameras: Array<{ camera: string; usedBytes: number | null; bytesPerHour: number | null }>;
  totalBytesPerHour: number | null;
  recordingsOnBootDisk: boolean | null;
  /** Internal resolved policy used for sizing; omitted by legacy injected fixtures. */
  effectiveRetentionByCamera?: Record<string, import("./camera-recording-state.js").FrigateRetention> | null;
}

/**
 * Everything one allocator tick / one API read / one health check decides from,
 * collected once (`collectRecordingsFacts`) so all three agree.
 *
 * `host === null` means the bridge could not be asked (see `hostError`): callers
 * must NOT treat that as "recordings are fine" nor as "on the OS disk" — the
 * allocator takes no action, the API reports what the DB row alone supports.
 */
export interface RecordingsFacts {
  at: Date;
  /**
   * The row the API and the status are ABOUT: while a move onto another drive is
   * in flight (PUT to a different drive, or the first allocation) that is the
   * TARGET row; otherwise the row Frigate records onto. See `selectSubjectAllocation`.
   */
  allocation: AllocationRecord | null;
  /** Every RECORDINGS row. Two exist only while a drive switch is in flight (target + the live row). */
  allocations: AllocationRecord[];
  host: NvrHostStatus | null;
  hostError: string | null;
  migration: NvrMigrationStatus | null;
  /** Every mounted data drive the bridge reports (eligible or not). */
  drives: RecordingsDriveCandidate[];
  drivesError: string | null;
  frigate: RecordingsFrigateFacts | null;
  sizing: RecordingsSizing;
  /** Camera name → customer-facing display name. */
  cameraNames: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. API — GET /api/storage/recordings (WARP-3512 storage contract, verbatim)
// ─────────────────────────────────────────────────────────────────────────────

export type RecordingsStatus =
  | "active"
  | "pending"
  | "migrating"
  | "degraded"
  | "missing"
  | "no_eligible_drive"
  | "on_system_disk";

export type RecordingsMode = "auto_reserved" | "full";

export type RecordingsWarningCode =
  | "drive_missing"
  | "read_only"
  | "near_full"
  | "cannot_grow"
  | "on_system_disk"
  | "smart_failed"
  | "not_encrypted";

export interface RecordingsWarning {
  code: RecordingsWarningCode;
  message: string;
}

export interface RecordingsOverview {
  status: RecordingsStatus;
  mode: RecordingsMode | null;
  drive: {
    fsUuid: string;
    label: string;
    model: string;
    sizeBytes: number;
    encrypted: boolean;
    mountPath: string;
  } | null;
  reservedBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** False when Frigate's resolved retention is unavailable; omitted by older servers. */
  retentionKnown?: boolean;
  needBytes: number;
  retentionDays: number;
  daysStored: number;
  cameras: Array<{
    name: string;
    displayName: string;
    mbPerHour: number;
    gbPerDay: number;
    needBytes: number;
    usedBytes: number;
  }>;
  migration: {
    state: MigrationJobState;
    progressPct: number;
    bytesCopied: number;
    bytesTotal: number;
    startedAt: string | null;
    error: string | null;
  };
  oldFootage: {
    present: boolean;
    bytes: number;
    location: "system_disk" | "other_drive";
  };
  warnings: RecordingsWarning[];
  eligibleDrives: Array<{
    fsUuid: string;
    label: string;
    sizeBytes: number;
    freeBytes: number;
    encrypted: boolean;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Allocator surface (implemented by recordings-allocator.service.ts, consumed by
// the routes through recordings-allocator.singleton.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** The actor recorded on the audit row. Same shape as the activity recorder's. */
export type RecordingsActor = { type: "user"; id: string } | { type: "system" };

export interface SetAllocationRequest {
  mode?: RecordingsMode;
  fsUuid?: string;
}

/** Machine codes the routes translate to HTTP statuses. */
export type RecordingsErrorCode =
  | "not_eligible" // the chosen drive is not an eligible recordings drive → 422
  | "no_change" // nothing to do → 400
  | "no_allocation" // a mode switch with no allocation and no eligible drive → 422
  | "busy" // another storage operation / a migration is running → 409
  | "no_old_footage" // nothing to delete → 409
  | "bridge_unavailable" // the device-bridge cannot be reached → 503
  | "host_refused"; // the host refused (message carries the bridge's reason) → 422

export class RecordingsError extends Error {
  readonly code: RecordingsErrorCode;
  /** Bridge machine code when the host refused (os_disk, not_mounted, …). */
  readonly hostCode?: string;
  constructor(code: RecordingsErrorCode, message: string, hostCode?: string) {
    super(message);
    this.name = "RecordingsError";
    this.code = code;
    this.hostCode = hostCode;
  }
  toJSON() {
    return { error: this.message, code: this.code, ...(this.hostCode ? { hostCode: this.hostCode } : {}) };
  }
}

export interface ReconcileOutcome {
  /** What the tick did; one value, so the cron log line and the tests can assert it. */
  action:
    | "none"
    | "bridge_unavailable"
    | "no_eligible_drive"
    | "created"
    | "applied_and_migrating"
    | "migration_running"
    | "migration_done"
    | "migration_failed"
    | "marked_missing"
    | "recovered"
    | "grew"
    | "degraded"
    | "mode_applied";
  detail?: string;
}

export interface RecordingsAllocator {
  /** Hourly cron + after a drive is prepared: the full reconcile. Never throws on a missing bridge. */
  reconcile(opts?: { reason?: "cron" | "kick" }): Promise<ReconcileOutcome>;
  /** Every minute: advance a running migration. Cheap no-op unless a row is PENDING/MIGRATING. */
  pollMigration(): Promise<void>;
  /** `PUT /api/storage/recordings` after the tier-2 confirm. Accepts and returns; work continues asynchronously. */
  setAllocation(req: SetAllocationRequest, actor: RecordingsActor): Promise<{ accepted: true }>;
  /** `POST /api/storage/recordings/old-footage/delete` after the tier-3 confirm. */
  deleteOldFootage(actor: RecordingsActor): Promise<{ accepted: true }>;
  /** Collect facts (bridge + Frigate + DB). */
  getFacts(): Promise<RecordingsFacts>;
  /** `getFacts()` + `buildRecordingsOverview()`. */
  getOverview(): Promise<RecordingsOverview>;
}
