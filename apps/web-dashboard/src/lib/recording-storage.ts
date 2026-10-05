/**
 * WARP-3515 — the recording-storage contract (WARP-3512 / ADR-070), as the
 * dashboard consumes it. Decision record: docs/ADR-070-camera-recording-storage.md.
 *
 * Three backend branches implement this contract in parallel and land
 * separately, so the dashboard cannot assume a payload is complete. Everything
 * the UI renders goes through `normalizeRecordingStorage`, which turns whatever
 * the wire carried into the typed `RecordingStorage` — defaulting every absent
 * field, ignoring a status or mode it does not recognise, dropping malformed
 * rows — so a component never guards a missing field and never crashes on one.
 *
 * This module is pure (no React, no fetch): the copy, the warning → fix mapping
 * and the arithmetic live here so they can be pinned without rendering anything.
 */
import type {
  RecordingMigration,
  RecordingMigrationState,
  RecordingOldFootage,
  RecordingStorage,
  RecordingStorageCamera,
  RecordingStorageDrive,
  RecordingStorageMode,
  RecordingStorageStatus,
  RecordingWarning,
  EligibleRecordingDrive,
} from "./types";

// ─── Link targets ─────────────────────────────────────────────────────────

/** Settings → Storage: where a drive is prepared, renamed, ejected. */
export const SETTINGS_STORAGE_HREF = "/settings/storage";

/** The `id` of the Recording storage card on /cameras/system. */
export const RECORDING_STORAGE_ANCHOR = "recording-storage";

/** Deep link to the Recording storage card (Settings → Storage and the
 *  per-camera settings page both point here). */
export const RECORDING_STORAGE_HREF = `/cameras/system#${RECORDING_STORAGE_ANCHOR}`;

// ─── Normalisation ────────────────────────────────────────────────────────

const STATUSES: ReadonlySet<string> = new Set<RecordingStorageStatus>([
  "active",
  "pending",
  "migrating",
  "degraded",
  "missing",
  "no_eligible_drive",
  "on_system_disk",
]);

const MODES: ReadonlySet<string> = new Set<RecordingStorageMode>(["auto_reserved", "full"]);

const MIGRATION_STATES: ReadonlySet<string> = new Set<RecordingMigrationState>([
  "idle",
  "running",
  "done",
  "failed",
]);

/** The contract's default retention (owner decision 4). Used only when the
 *  payload carries none. */
const DEFAULT_RETENTION_DAYS = 7;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A finite, non-negative number — from a number OR a decimal string (the
 *  ADR-029 BigInt-as-string wire convention). Anything else is `fallback`:
 *  a malformed figure must read as "none", never as NaN in a meter. */
function num(v: unknown, fallback = 0): number {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && v.trim() !== ""
        ? Number(v)
        : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function clampPct(v: unknown): number {
  const n = num(v, 0);
  return Math.min(100, n);
}

function normalizeDrive(v: unknown): RecordingStorageDrive | null {
  if (!isRecord(v)) return null;
  return {
    fsUuid: str(v.fsUuid),
    label: str(v.label),
    model: str(v.model),
    sizeBytes: num(v.sizeBytes),
    encrypted: v.encrypted === true,
    mountPath: str(v.mountPath),
  };
}

function normalizeCameras(v: unknown): RecordingStorageCamera[] {
  if (!Array.isArray(v)) return [];
  const out: RecordingStorageCamera[] = [];
  for (const row of v) {
    if (!isRecord(row)) continue;
    const name = str(row.name).trim();
    if (!name) continue;
    out.push({
      name,
      displayName: str(row.displayName).trim() || name,
      mbPerHour: num(row.mbPerHour),
      gbPerDay: num(row.gbPerDay),
      needBytes: num(row.needBytes),
      usedBytes: num(row.usedBytes),
    });
  }
  return out;
}

function normalizeMigration(v: unknown): RecordingMigration {
  const m = isRecord(v) ? v : {};
  const state = MIGRATION_STATES.has(str(m.state))
    ? (m.state as RecordingMigrationState)
    : "idle";
  return {
    state,
    progressPct: clampPct(m.progressPct),
    bytesCopied: num(m.bytesCopied),
    bytesTotal: num(m.bytesTotal),
    startedAt: strOrNull(m.startedAt),
    error: strOrNull(m.error),
  };
}

function normalizeOldFootage(v: unknown): RecordingOldFootage {
  const o = isRecord(v) ? v : {};
  return {
    present: o.present === true,
    bytes: num(o.bytes),
    location: str(o.location) || "system_disk",
  };
}

function normalizeWarnings(v: unknown): RecordingWarning[] {
  if (!Array.isArray(v)) return [];
  const out: RecordingWarning[] = [];
  for (const row of v) {
    if (!isRecord(row)) continue;
    const code = str(row.code).trim();
    if (!code) continue;
    out.push({ code, message: str(row.message) });
  }
  return out;
}

function normalizeEligible(v: unknown): EligibleRecordingDrive[] {
  if (!Array.isArray(v)) return [];
  const out: EligibleRecordingDrive[] = [];
  for (const row of v) {
    if (!isRecord(row)) continue;
    const fsUuid = str(row.fsUuid).trim();
    // Without an fsUuid the drive could never be chosen (PUT keys on it).
    if (!fsUuid) continue;
    out.push({
      fsUuid,
      label: str(row.label),
      sizeBytes: num(row.sizeBytes),
      freeBytes: num(row.freeBytes),
      encrypted: row.encrypted === true,
    });
  }
  return out;
}

/**
 * Wire payload → `RecordingStorage`. Returns `null` only when `raw` is not an
 * object at all (an HTML error page, a bare string) — the caller then treats the
 * endpoint as not supported. An object with nothing useful in it still
 * normalises to a safe, renderable value with status `unknown`.
 */
export function normalizeRecordingStorage(raw: unknown): RecordingStorage | null {
  if (!isRecord(raw)) return null;
  const status = STATUSES.has(str(raw.status))
    ? (raw.status as RecordingStorageStatus)
    : "unknown";
  const mode = MODES.has(str(raw.mode)) ? (raw.mode as RecordingStorageMode) : null;
  const retentionKnown = raw.retentionKnown !== false;
  const retention = retentionKnown ? num(raw.retentionDays, DEFAULT_RETENTION_DAYS) : 0;
  const cameras = normalizeCameras(raw.cameras).map((camera) =>
    retentionKnown ? camera : { ...camera, needBytes: 0 },
  );
  return {
    status,
    mode,
    drive: normalizeDrive(raw.drive),
    reservedBytes: num(raw.reservedBytes),
    usedBytes: num(raw.usedBytes),
    freeBytes: num(raw.freeBytes),
    ...(typeof raw.retentionKnown === "boolean" ? { retentionKnown } : {}),
    needBytes: retentionKnown ? num(raw.needBytes) : 0,
    retentionDays: retentionKnown && retention > 0 ? retention : 0,
    daysStored: num(raw.daysStored),
    cameras,
    migration: normalizeMigration(raw.migration),
    oldFootage: normalizeOldFootage(raw.oldFootage),
    warnings: normalizeWarnings(raw.warnings),
    eligibleDrives: normalizeEligible(raw.eligibleDrives),
  };
}

// ─── Presentation helpers ─────────────────────────────────────────────────

/** The shell `Badge` variants (components/shell/primitives `BadgeKind`),
 *  restated so this pure module does not import a component. */
export type StatusBadgeKind = "ok" | "warn" | "danger" | "info" | "muted";

/** The status chip on the card header. */
export function recordingStatusView(status: RecordingStorageStatus): {
  label: string;
  kind: StatusBadgeKind;
} {
  switch (status) {
    case "active":
      return { label: "Active", kind: "ok" };
    case "pending":
      return { label: "Setting up", kind: "info" };
    case "migrating":
      return { label: "Moving recordings", kind: "info" };
    case "degraded":
      return { label: "Needs attention", kind: "warn" };
    case "missing":
      return { label: "Drive missing", kind: "danger" };
    case "no_eligible_drive":
      return { label: "No drive yet", kind: "muted" };
    case "on_system_disk":
      return { label: "On the system drive", kind: "danger" };
    default:
      return { label: "Unknown", kind: "muted" };
  }
}

/** Customer-facing name for the recordings drive: the label the owner (or the
 *  filesystem) gave it, then its hardware model, then a friendly generic —
 *  never a mount path or an fs UUID (home-user persona, ADR-002). */
export function recordingsDriveName(
  drive: { label?: string | null; model?: string | null } | null | undefined,
): string {
  return drive?.label?.trim() || drive?.model?.trim() || "Drive";
}

/** MB/h and GB/day: whole numbers from 100, otherwise one trimmed decimal. A
 *  real-but-tiny rate reads "<0.1", never "0"; nothing measured reads "0". */
export function formatRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 0.1) return "<0.1";
  return n >= 100 ? String(Math.round(n)) : String(Number(n.toFixed(1)));
}

/** One camera's share of the whole recording need — the "Share" column. It is a
 *  share of NEED (what each camera is expected to take for the retention
 *  window), which is what makes the columns around it add up: GB/day → need →
 *  share. */
export function cameraNeedShares(
  cameras: readonly RecordingStorageCamera[],
): Array<RecordingStorageCamera & { sharePct: number }> {
  const total = cameras.reduce((sum, c) => sum + c.needBytes, 0);
  return cameras.map((c) => ({
    ...c,
    sharePct: total > 0 ? (c.needBytes * 100) / total : 0,
  }));
}

// ─── Which state wins ─────────────────────────────────────────────────────

/**
 * The orchestrator's own precedence for a drive that is in more than one
 * condition at once (WARP-3512, "Decisions settled 2026-10-04"): a missing drive
 * is the headline whatever else is true, then a move in flight, then a degraded
 * drive, then recordings on the system drive, then a pending set-up, then plain
 * active, with "no eligible drive" the quietest. `unknown` (a status this build
 * does not recognise) yields to any recognised signal.
 */
const STATUS_PRECEDENCE: readonly RecordingStorageStatus[] = [
  "missing",
  "migrating",
  "degraded",
  "on_system_disk",
  "pending",
  "active",
  "no_eligible_drive",
  "unknown",
];

/**
 * The status the card renders. The API sends one `status`, already ordered by the
 * precedence above — but the rest of the payload can say more (a `drive_missing`
 * warning beside `active`, a running migration beside `pending`), and a card
 * that headlines "Active" over a missing drive would be telling the owner
 * something false. So the structured signals are folded in and the highest
 * precedence wins. `near_full` alone is a warning, not a state.
 */
export function effectiveRecordingStatus(
  r: Pick<RecordingStorage, "status" | "warnings" | "migration">,
): RecordingStorageStatus {
  const codes = new Set(r.warnings.map((w) => w.code));
  const candidates: RecordingStorageStatus[] = [r.status];
  if (codes.has("drive_missing")) candidates.push("missing");
  if (r.migration.state === "running") candidates.push("migrating");
  if (codes.has("read_only") || codes.has("smart_failed") || codes.has("cannot_grow")) {
    candidates.push("degraded");
  }
  if (codes.has("on_system_disk")) candidates.push("on_system_disk");
  return candidates.reduce((best, c) =>
    STATUS_PRECEDENCE.indexOf(c) < STATUS_PRECEDENCE.indexOf(best) ? c : best,
  );
}

/** What the card says about a move that did not finish. The orchestrator puts
 *  Frigate back on the OLD source before it reports `failed`, so nothing is
 *  lost and cameras keep recording where they were; it retries on its own at
 *  1 h / 6 h / 24 h, then goes back to pending with a warning and a
 *  notification. */
export const MIGRATION_RETRY_COPY =
  "Droplet tries again on its own — in about 1 hour, then 6 hours, then 24 hours — and tells you if it still can't finish.";

/** Where the recordings left behind by a move are, in words. `system_disk` is
 *  the usual first move; anything else is a bay drive the recordings moved off. */
export function oldFootagePlace(location: string): {
  where: string;
  action: string;
  summary: string;
} {
  return location === "system_disk"
    ? {
        where: "the system drive",
        action: "Delete old recordings from system drive",
        summary: "system drive",
      }
    : {
        where: "the previous recording drive",
        action: "Delete old recordings from previous drive",
        summary: "previous drive",
      };
}

// ─── Warnings → copy + the fix ────────────────────────────────────────────

/** What the owner can do about a warning, from where they stand. */
export type WarningFix =
  | { kind: "link"; label: string; href: string }
  /** Switch to "Whole drive" (opens the same tier-2 confirm as the radio). */
  | { kind: "whole_drive"; label: string }
  /** Focus the drive picker on the card. */
  | { kind: "pick_drive"; label: string };

export interface WarningView {
  code: string;
  severity: "danger" | "warn";
  title: string;
  detail: string;
  /** The server's own sentence, when it adds something to ours. Secondary. */
  serverMessage: string | null;
  fix: WarningFix | null;
}

export interface WarningContext {
  mode: RecordingStorageMode | null;
  /** Eligible drives other than the current one. */
  eligibleCount: number;
  retentionDays: number;
  retentionKnown?: boolean;
}

const OPEN_STORAGE: WarningFix = {
  kind: "link",
  label: "Open Storage",
  href: SETTINGS_STORAGE_HREF,
};

/**
 * One contract warning code → the words and the fix. A code this build does not
 * know still renders: the server's own message, with no fix, never a crash.
 */
export function describeWarning(w: RecordingWarning, ctx: WarningContext): WarningView {
  const serverMessage = w.message.trim() || null;
  const base = { code: w.code, serverMessage };

  switch (w.code) {
    case "drive_missing":
      return {
        ...base,
        severity: "danger",
        title: "Recording drive not found",
        detail:
          "Droplet can't see the drive that holds your recordings. Reconnect it, then rescan drives.",
        fix: OPEN_STORAGE,
      };
    case "read_only":
      return {
        ...base,
        severity: "danger",
        title: "Recording drive is read-only",
        detail:
          "Your cameras can't save new recordings to it right now. Check the drive and its connection.",
        fix: OPEN_STORAGE,
      };
    case "near_full":
      return {
        ...base,
        severity: "warn",
        title: "Recording space is nearly full",
        detail: ctx.retentionKnown === false
          ? "The oldest recordings are deleted first when space fills. The retention estimate is unavailable while waiting for Frigate retention settings."
          : `The oldest recordings are deleted first when it fills, so cameras may keep less than their configured retention windows (up to ${ctx.retentionDays} days).`,
        // On an auto-sized slice the next step up is the whole drive; once it
        // already IS the whole drive the only way to more room is more storage.
        fix:
          ctx.mode === "auto_reserved"
            ? { kind: "whole_drive", label: "Use the whole drive" }
            : OPEN_STORAGE,
      };
    case "cannot_grow":
      return {
        ...base,
        severity: "warn",
        title: "Reserved space can't grow",
        detail:
          "Your cameras now need more space than is set aside, and the drive has no room to add more.",
        fix: OPEN_STORAGE,
      };
    case "on_system_disk":
      return {
        ...base,
        severity: "danger",
        title: "Recordings are on the system drive",
        detail:
          "That's the disk your Droplet runs on, so recordings can fill it. Recordings belong on an encrypted drive of their own.",
        fix:
          ctx.eligibleCount > 0
            ? { kind: "pick_drive", label: "Choose a recording drive" }
            : OPEN_STORAGE,
      };
    case "smart_failed":
      return {
        ...base,
        severity: "danger",
        title: "Recording drive reports health problems",
        detail:
          "Its own self-check failed. Back up anything you need and plan to replace it.",
        fix: OPEN_STORAGE,
      };
    case "not_encrypted":
      return {
        ...base,
        severity: "warn",
        title: "Recording drive isn't encrypted",
        detail:
          "Recordings should only live on an encrypted drive. Prepare a drive to set one up.",
        fix: OPEN_STORAGE,
      };
    default:
      // Unknown code: the server's sentence IS the detail (no duplicate line).
      return {
        code: w.code,
        severity: "warn",
        title: "Recording storage needs attention",
        detail: serverMessage ?? "Something about your recording storage needs a look.",
        serverMessage: null,
        fix: null,
      };
  }
}

// ─── Errors ───────────────────────────────────────────────────────────────

export type RecordingStorageAction =
  | "mode"
  | "drive"
  | "delete-old"
  | "recovery-key"
  | "regenerate";

const FILES_BLOCK_CODES: ReadonlySet<string> = new Set([
  "files_not_empty",
  "drive_has_files",
  "files_present",
]);

/**
 * "Whole drive" is only allowed on a drive whose `files/` is empty (the drive is
 * then removed from Files). The refusal is a 409; this tells it apart from the
 * other 409s (a move already running, a busy drive), by its code or, failing
 * that, by prose that talks about files being present. Never true for a
 * non-409: a 500 that happens to mention files is not a refusal.
 */
export function isWholeDriveBlockedByFiles(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { status, code, message } = err as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (status !== 409) return false;
  if (typeof code === "string" && FILES_BLOCK_CODES.has(code)) return true;
  return (
    typeof message === "string" &&
    /not empty|\b(holds?|has|have|contains?|present)\b[^.]{0,30}\bfiles?\b|\bfiles?\b[^.]{0,30}\b(present|in use|exist)/i.test(
      message,
    )
  );
}

/**
 * A failed recording-storage call → calm, honest, home-user copy. The server's
 * own message is NEVER shown: it can carry mount paths and tool output. The
 * status is what the client attached (`storageWriteError`) and is all we need.
 */
export function friendlyRecordingStorageError(
  err: unknown,
  action: RecordingStorageAction,
): string {
  // Operator breadcrumb — the full cause in DevTools, never on screen.
  // eslint-disable-next-line no-console
  console.error(`[recording-storage:${action}]`, err);

  const status =
    err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : undefined;
  const ownerOnly = action === "delete-old" || action === "recovery-key" || action === "regenerate";
  const keyAction = action === "recovery-key" || action === "regenerate";

  switch (status) {
    case 403:
      return ownerOnly
        ? "Only the Droplet's owner can do that."
        : "Only the Droplet's owner or an admin can change recording storage.";
    case 404:
      return keyAction
        ? "That isn't available on this Droplet yet."
        : "Recording storage isn't available on this Droplet yet.";
    case 409:
      if (action === "delete-old") {
        return "Old recordings can't be deleted until the move to the new drive has finished.";
      }
      if (action === "regenerate") {
        return "A new recovery key can't be generated right now. Try again in a few minutes.";
      }
      if (isWholeDriveBlockedByFiles(err)) {
        return "Whole drive can only be used on a drive that holds no files, and this one still has some. Move your files off it first, then try again.";
      }
      return "Recording storage can't be changed right now — recordings are already being moved, or the drive is busy. Try again in a few minutes.";
    case 503:
      return "The storage service isn't reachable right now. Try again in a moment.";
    default:
      return "We couldn't do that right now. Try again in a moment.";
  }
}
