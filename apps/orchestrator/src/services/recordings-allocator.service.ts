/**
 * WARP-3514 / ADR-070 — the recordings allocator: Droplet measures the cameras,
 * sizes a quota-capped slice of an ENCRYPTED bay drive, moves the footage onto
 * it and keeps it sized. Supersedes ADR-019 D2 for camera recordings only;
 * erasing a drive and deleting footage still need the owner's confirmation.
 *
 * ## Rows
 *
 * One RECORDINGS row normally; TWO only while a drive switch is in flight (the
 * live row Frigate records onto, and the TARGET). The row whose filesystem the
 * host reports is the LIVE row; any other row is WORK to do.
 *
 * ## Why every state change is `updateMany({ where: { id, status: { in: from } } })`
 *
 * findUnique → check → update lets two actors (the hourly tick, the 1-minute
 * poll, an owner's PUT) both pass the guard (handbook P1). The expected status
 * is in the WHERE and the caller branches on `count`.
 *
 * ## The host is the source of truth, and an unreachable host is NOT an answer
 *
 * `facts.hostError` / `drivesError` ⇒ the tick does NOTHING (`bridge_unavailable`):
 * no row is created, nothing is marked missing, nothing is moved on a guess.
 *
 * ## Failed moves
 *
 * The migration job restarts Frigate on the OLD source before it reports
 * `failed`. A failure is counted on the row; the retry waits 1 h, 6 h, then
 * 24 h. After the third retry fails the row goes back to PENDING and STAYS there
 * (no more automatic attempts), the owner is told once, and the status reads
 * `on_system_disk` until they act. A read-only or SMART-failing drive is never
 * auto-moved: it is DEGRADED + a warning.
 */
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../lib/logger.js";
import { recordActivity as defaultRecordActivity } from "./activity.singleton.js";
import type { RecordParams } from "./activity.service.js";
import { loadRecordingsAllocations, toAllocationRecord } from "./recordings-capacity.js";
import { isEligibleRecordingsDrive, pickRecordingsDrive } from "./recordings-eligibility.js";
import { buildRecordingsOverview } from "./recordings-overview.js";
import { growthDecision, initialReservedBytes, reservedForMode } from "./recordings-sizing.js";
import type { RecordingsBridge } from "./recordings-bridge.client.js";
import {
  RecordingsError,
  type AllocationModeName,
  type AllocationRecord,
  type AllocationStatusName,
  type NvrMigrationStatus,
  type ReconcileOutcome,
  type RecordingsActor,
  type RecordingsAllocator,
  type RecordingsDriveCandidate,
  type RecordingsFacts,
  type RecordingsOverview,
  type SetAllocationRequest,
} from "./recordings.types.js";

const logger = createLogger("recordings-allocator");

const HOUR_MS = 3_600_000;
/** Wait after failure n (1-based) before the automatic retry n. A 4th failure ends the automatic attempts. */
export const RETRY_DELAYS_MS: readonly number[] = [1 * HOUR_MS, 6 * HOUR_MS, 24 * HOUR_MS];
export const MAX_AUTO_RETRIES = RETRY_DELAYS_MS.length;
const WAITING_FOR_RETENTION = "waiting for Frigate's resolved recording retention settings";

function retentionUnavailable(facts: RecordingsFacts): boolean {
  return facts.sizing.retentionKnown === false;
}

function requireKnownRetention(facts: RecordingsFacts): void {
  if (retentionUnavailable(facts)) {
    throw new RecordingsError("busy", "Frigate's recording retention settings are unavailable; try again when Frigate is reachable");
  }
}

export const TITLE_SETTING_ASIDE = "Droplet is setting aside space for your camera recordings";
export const TITLE_MOVED = "Your camera recordings are now on the protected drive";
export const TITLE_MOVE_GAVE_UP = "Droplet could not move your camera recordings";

type AllocatorDb = Pick<PrismaClient, "storageAllocation">;

export interface AllocatorDeps {
  prisma: AllocatorDb;
  bridge: RecordingsBridge;
  collectFacts: () => Promise<RecordingsFacts>;
  /** Best-effort fresh bitrate sample at the start of a reconcile; its failure is logged, never fatal. */
  sampleBitrates?: () => Promise<unknown>;
  notifyOwners: (title: string, body: string) => Promise<unknown>;
  recordActivity?: (params: RecordParams) => Promise<unknown>;
  now?: () => Date;
}

type RowUpdate = {
  status?: AllocationStatusName;
  mode?: AllocationModeName;
  reservedBytes?: bigint;
  migrationFailures?: number;
  lastFailureAt?: Date | null;
};

const toBig = (n: number): bigint => BigInt(Math.max(0, Math.floor(n)));
const modeName = (m: AllocationModeName): "auto_reserved" | "full" => (m === "FULL" ? "full" : "auto_reserved");

export function createRecordingsAllocator(deps: AllocatorDeps): RecordingsAllocator {
  const { prisma, bridge, collectFacts, notifyOwners } = deps;
  const now = deps.now ?? (() => new Date());
  const record = deps.recordActivity ?? defaultRecordActivity;

  // ── one operation at a time ────────────────────────────────────────────────
  // A tick that finds the lock held is skipped; an owner's action waits its turn.
  let running = false;
  const waiters: Array<() => void> = [];
  async function acquire(wait: boolean): Promise<boolean> {
    if (!running) {
      running = true;
      return true;
    }
    if (!wait) return false;
    await new Promise<void>((resolve) => waiters.push(resolve));
    return true; // ownership is handed over: `running` stays true
  }
  function release(): void {
    const next = waiters.shift();
    if (next) next();
    else running = false;
  }

  // ── small effects ──────────────────────────────────────────────────────────
  async function transition(id: string, from: readonly AllocationStatusName[], data: RowUpdate): Promise<boolean> {
    const r = await prisma.storageAllocation.updateMany({ where: { id, status: { in: [...from] } }, data });
    return r.count > 0;
  }

  /** Audit row. Never carries a label, mount path or device path (WARP-3466) — only generic text and the fsUuid. */
  async function audit(
    severity: "info" | "warn",
    what: string,
    actor: RecordingsActor,
    refs: Record<string, unknown>,
  ): Promise<void> {
    try {
      await record({ kind: "system", severity, sourceIcon: "hard-drive", what, sub: null, refs, actor });
    } catch (err) {
      logger.warn({ err }, "recordings audit row could not be written");
    }
  }

  async function tell(title: string, body: string): Promise<void> {
    try {
      await notifyOwners(title, body);
    } catch (err) {
      logger.warn({ err, title }, "owner notification failed");
    }
  }

  const SYSTEM: RecordingsActor = { type: "system" };

  /** The row whose filesystem the host says Frigate records onto. */
  function liveRow(facts: RecordingsFacts): AllocationRecord | undefined {
    const h = facts.host;
    if (h === null || h.kind !== "path" || !h.mounted || h.fsUuid === null) return undefined;
    const fs = h.fsUuid.toLowerCase();
    return facts.allocations.find((r) => r.fsUuid.toLowerCase() === fs);
  }

  const driveOf = (facts: RecordingsFacts, fsUuid: string): RecordingsDriveCandidate | undefined =>
    facts.drives.find((d) => d.fsUuid === fsUuid && d.mounted);

  // ── prepare the target + start the move ────────────────────────────────────
  /** Map a bridge failure of a background step to an outcome; anything unexpected is rethrown to the cron canary. */
  function outcomeOfBridgeError(err: unknown, step: string): ReconcileOutcome {
    if (err instanceof RecordingsError) {
      if (err.code === "bridge_unavailable") return { action: "bridge_unavailable", detail: step };
      logger.warn({ step, code: err.code, hostCode: err.hostCode }, "recordings host step refused — the row stays as it is");
      return { action: "none", detail: `${step}: ${err.hostCode ?? err.code}` };
    }
    throw err;
  }

  async function prepareAndMigrate(w: AllocationRecord): Promise<void> {
    await bridge.applyNvrTarget({
      fsUuid: w.fsUuid,
      mode: w.mode === "FULL" ? "full" : "reserved",
      ...(w.mode === "FULL" ? {} : { limitBytes: w.reservedBytes }),
    });
    try {
      await bridge.startMigration(w.fsUuid);
    } catch (err) {
      // `busy` after a successful apply means the job is ALREADY running (a crash between the
      // start and the status write): that is exactly the state we want to record.
      if (!(err instanceof RecordingsError && err.code === "busy")) throw err;
    }
    await transition(w.id, ["PENDING"], { status: "MIGRATING" });
  }

  async function startWork(w: AllocationRecord): Promise<ReconcileOutcome> {
    if (w.migrationFailures > MAX_AUTO_RETRIES) {
      return { action: "none", detail: "automatic retries are exhausted — waiting for the owner" };
    }
    try {
      await prepareAndMigrate(w);
    } catch (err) {
      return outcomeOfBridgeError(err, "prepare");
    }
    return { action: "applied_and_migrating" };
  }

  // ── a move's result ────────────────────────────────────────────────────────
  async function complete(w: AllocationRecord): Promise<ReconcileOutcome> {
    const flipped = await transition(w.id, ["MIGRATING"], { status: "ACTIVE", migrationFailures: 0, lastFailureAt: null });
    if (!flipped) return { action: "none", detail: "row changed under the tick" };
    // The superseded live row (a drive switch) is no longer the recordings target; its nvr/ is old footage now.
    await prisma.storageAllocation.deleteMany({ where: { role: "RECORDINGS", id: { not: w.id } } });
    await audit("info", "Camera recordings moved to the protected drive", SYSTEM, { fsUuid: w.fsUuid });
    await tell(
      TITLE_MOVED,
      "Droplet moved your camera recordings onto the encrypted drive it set aside for them. " +
        "Your earlier footage is kept on the system drive until you choose to delete it.",
    );
    return { action: "migration_done" };
  }

  async function failed(w: AllocationRecord, m: NvrMigrationStatus): Promise<ReconcileOutcome> {
    const failures = w.migrationFailures + 1;
    const exhausted = failures > MAX_AUTO_RETRIES;
    const moved = await transition(w.id, ["MIGRATING"], {
      status: exhausted ? "PENDING" : "DEGRADED",
      migrationFailures: failures,
      lastFailureAt: now(),
    });
    if (!moved) return { action: "none", detail: "row changed under the tick" };
    await audit("warn", "Moving camera recordings to the protected drive failed", SYSTEM, {
      fsUuid: w.fsUuid,
      errorCode: m.errorCode,
      attempt: failures,
      willRetry: !exhausted,
    });
    if (exhausted) {
      await tell(
        TITLE_MOVE_GAVE_UP,
        "Moving your camera recordings to the encrypted drive failed several times, so they are still on the " +
          "system drive. Open Storage to see why and to try again.",
      );
    }
    return { action: "migration_failed", detail: m.errorCode ?? undefined };
  }

  /** Apply the job's state to a MIGRATING row (shared by the hourly tick and the 1-minute poll). */
  async function onMigrationState(w: AllocationRecord, m: NvrMigrationStatus | null): Promise<ReconcileOutcome> {
    if (m === null) return { action: "none", detail: "migration status unavailable" };
    if (m.job === "migrate" && m.state === "running") return { action: "migration_running" };
    if (m.job === "migrate" && m.state === "done") return complete(w);
    if (m.job === "migrate" && m.state === "failed") return failed(w, m);
    if (m.job === "delete_old" && m.state === "running") return { action: "migration_running" };
    // No record of this move (bridge state lost, or the file now describes another job): start it
    // again — it is idempotent and an already-moved box finishes at once.
    try {
      await bridge.startMigration(w.fsUuid);
    } catch (err) {
      if (!(err instanceof RecordingsError && err.code === "busy")) return outcomeOfBridgeError(err, "restart migration");
    }
    return { action: "migration_running", detail: "restarted" };
  }

  // ── the tick ───────────────────────────────────────────────────────────────
  async function createFirst(facts: RecordingsFacts): Promise<ReconcileOutcome> {
    if (retentionUnavailable(facts)) return { action: "none", detail: WAITING_FOR_RETENTION };
    const drive = pickRecordingsDrive(facts.drives);
    if (!drive) return { action: "no_eligible_drive" };
    let row;
    try {
      row = await prisma.storageAllocation.create({
        data: {
          fsUuid: drive.fsUuid,
          mode: "AUTO_RESERVED",
          reservedBytes: toBig(initialReservedBytes(facts.sizing.needTotalBytes, drive.freeBytes)),
          status: "PENDING",
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") return { action: "none", detail: "row already exists" };
      throw err;
    }
    await audit("info", "Camera recordings allocation created", SYSTEM, { fsUuid: drive.fsUuid });
    await tell(
      TITLE_SETTING_ASIDE,
      "Droplet found an encrypted storage drive, set aside space on it for camera recordings, and is moving your " +
        "existing footage there. Your cameras keep recording while it moves.",
    );
    const started = await startWork(toAllocationRecord(row));
    return { action: "created", detail: started.action };
  }

  async function handleWork(w: AllocationRecord, facts: RecordingsFacts): Promise<ReconcileOutcome> {
    if (!driveOf(facts, w.fsUuid)) {
      if (w.status === "MISSING") return { action: "none", detail: "drive absent" };
      await transition(w.id, [w.status], { status: "MISSING" });
      return { action: "marked_missing" };
    }
    let cur = w;
    let recovered = false;
    if (w.status === "MISSING" && (await transition(w.id, ["MISSING"], { status: "PENDING" }))) {
      cur = { ...w, status: "PENDING" };
      recovered = true;
    }
    switch (cur.status) {
      case "MIGRATING":
        return onMigrationState(cur, facts.migration);
      case "DEGRADED": {
        const waited = cur.lastFailureAt === null ? Infinity : facts.at.getTime() - cur.lastFailureAt.getTime();
        const delay = RETRY_DELAYS_MS[Math.min(Math.max(cur.migrationFailures, 1), MAX_AUTO_RETRIES) - 1] ?? 0;
        if (waited < delay) return { action: "none", detail: "waiting to retry the move" };
        if (retentionUnavailable(facts)) return { action: "none", detail: WAITING_FOR_RETENTION };
        if (!(await transition(cur.id, ["DEGRADED"], { status: "PENDING" }))) return { action: "none" };
        return startWork({ ...cur, status: "PENDING" });
      }
      case "ACTIVE":
        // The row says bay drive, the host does not record there (a reflash reset .env, a volume fallback…).
        if (!(await transition(cur.id, ["ACTIVE"], { status: "PENDING" }))) return { action: "none" };
        if (retentionUnavailable(facts)) return { action: "none", detail: WAITING_FOR_RETENTION };
        return startWork({ ...cur, status: "PENDING" });
      case "PENDING":
      default: {
        if (retentionUnavailable(facts)) return { action: "none", detail: WAITING_FOR_RETENTION };
        const out = await startWork(cur);
        return recovered && out.action === "applied_and_migrating" ? { action: "recovered" } : out;
      }
    }
  }

  async function handleLive(live: AllocationRecord, facts: RecordingsFacts): Promise<ReconcileOutcome> {
    const d = driveOf(facts, live.fsUuid);
    if (!d) {
      if (live.status === "MISSING") return { action: "none", detail: "drive absent" };
      await transition(live.id, [live.status], { status: "MISSING" });
      return { action: "marked_missing" };
    }
    let outcome: ReconcileOutcome = live.status === "MISSING" ? { action: "recovered" } : { action: "none" };
    const host = facts.host;
    const used = host?.usedBytes ?? null;
    const fsFree = host?.fsFreeBytes ?? d.freeBytes;
    const fsSize = host?.fsSizeBytes ?? d.sizeBytes;
    let growthBlocked = false;

    try {
      if (live.mode === "FULL") {
        if (host?.limitBytes != null && host.limitBytes < fsSize) {
          await bridge.resizeNvr(fsSize);
          await transition(live.id, [live.status], { reservedBytes: toBig(fsSize) });
        }
      } else if (!retentionUnavailable(facts)) {
        const g = growthDecision({
          mode: live.mode,
          reservedBytes: live.reservedBytes,
          needTotalBytes: facts.sizing.needTotalBytes,
          usedBytes: used,
          fsFreeBytes: fsFree,
          fsSizeBytes: fsSize,
        });
        if (g.action === "grow" && g.targetBytes !== undefined) {
          await bridge.resizeNvr(g.targetBytes);
          await transition(live.id, [live.status], { reservedBytes: toBig(g.targetBytes) });
          growthBlocked = g.partial === true;
          outcome = { action: "grew", detail: String(g.targetBytes) };
        } else if (g.action === "degrade") {
          growthBlocked = true;
          outcome = { action: "degraded", detail: g.reason };
        }
      }
    } catch (err) {
      if (!(err instanceof RecordingsError)) throw err;
      if (err.code === "bridge_unavailable") return { action: "bridge_unavailable", detail: "resize" };
      // The host refused (e.g. below_used, files_not_empty): the slice keeps its size; the room problem is a warning.
      growthBlocked = true;
      outcome = { action: "degraded", detail: `resize: ${err.hostCode ?? err.code}` };
    }

    // A failing or read-only drive is DEGRADED + a warning — never auto-moved.
    const desired: AllocationStatusName = d.readOnly || d.smart === "FAILED" || growthBlocked
      ? "DEGRADED"
      : retentionUnavailable(facts) && live.mode === "AUTO_RESERVED"
        ? live.status
        : "ACTIVE";
    if (live.status !== desired) {
      await transition(live.id, [live.status], { status: desired });
      if (outcome.action === "none") outcome = { action: desired === "DEGRADED" ? "degraded" : "recovered" };
    }
    return outcome;
  }

  async function tick(facts: RecordingsFacts): Promise<ReconcileOutcome> {
    if (facts.hostError !== null || facts.drivesError !== null) {
      logger.warn({ hostError: facts.hostError, drivesError: facts.drivesError }, "recordings reconcile skipped — the device-bridge cannot be asked");
      return { action: "bridge_unavailable", detail: facts.hostError ?? facts.drivesError ?? undefined };
    }
    if (facts.allocations.length === 0) return createFirst(facts);
    const live = liveRow(facts);
    const work = facts.allocations.find((r) => r.id !== live?.id);
    if (work) return handleWork(work, facts);
    if (live) return handleLive(live, facts);
    return { action: "none" };
  }

  // ── the public surface ─────────────────────────────────────────────────────
  async function reconcile(): Promise<ReconcileOutcome> {
    if (!(await acquire(false))) return { action: "none", detail: "another recordings operation is running" };
    try {
      if (deps.sampleBitrates) {
        try {
          await deps.sampleBitrates();
        } catch (err) {
          logger.warn({ err }, "bitrate sample failed — sizing uses the samples it has");
        }
      }
      return await tick(await collectFacts());
    } finally {
      release();
    }
  }

  async function pollMigration(): Promise<void> {
    if (!(await acquire(false))) return;
    try {
      const rows = await loadRecordingsAllocations(prisma);
      const w = rows.find((r) => r.status === "MIGRATING");
      if (!w) return;
      let m: NvrMigrationStatus | null = null;
      try {
        m = await bridge.getMigration();
      } catch (err) {
        logger.debug?.({ err }, "migration poll: status unavailable");
        return;
      }
      await onMigrationState(w, m);
    } finally {
      release();
    }
  }

  async function freshFacts(): Promise<RecordingsFacts> {
    const facts = await collectFacts();
    if (facts.hostError !== null || facts.drivesError !== null) {
      throw new RecordingsError("bridge_unavailable", "the device-bridge cannot be reached right now");
    }
    return facts;
  }

  async function setAllocation(req: SetAllocationRequest, actor: RecordingsActor): Promise<{ accepted: true }> {
    await acquire(true);
    try {
      const facts = await freshFacts();
      if (facts.migration?.state === "running") throw new RecordingsError("busy", "a storage operation is already running");
      const live = liveRow(facts);
      const wantMode: AllocationModeName | undefined = req.mode === undefined ? undefined : req.mode === "full" ? "FULL" : "AUTO_RESERVED";
      const need = facts.sizing.needTotalBytes;

      if (req.fsUuid !== undefined && req.fsUuid !== live?.fsUuid) {
        // ── (A) a drive: a different one, or the first allocation ──
        const drive = facts.drives.find((d) => d.fsUuid === req.fsUuid);
        if (!drive || !isEligibleRecordingsDrive(drive)) {
          throw new RecordingsError("not_eligible", "that drive cannot hold camera recordings");
        }
        const mode: AllocationModeName = wantMode ?? live?.mode ?? "AUTO_RESERVED";
        if (mode === "AUTO_RESERVED") requireKnownRetention(facts);
        const reserved = mode === "FULL" ? drive.sizeBytes : initialReservedBytes(need, drive.freeBytes);
        const existing = facts.allocations.find((r) => r.fsUuid === req.fsUuid);
        // A superseded TARGET is dropped; the live row stays until the new drive is confirmed.
        await prisma.storageAllocation.deleteMany({
          where: { role: "RECORDINGS", fsUuid: { not: req.fsUuid }, ...(live ? { id: { not: live.id } } : {}) },
        });
        let row: AllocationRecord;
        if (existing) {
          await prisma.storageAllocation.updateMany({
            where: { id: existing.id },
            data: { mode, reservedBytes: toBig(reserved), status: "PENDING", migrationFailures: 0, lastFailureAt: null },
          });
          row = { ...existing, mode, reservedBytes: reserved, status: "PENDING", migrationFailures: 0, lastFailureAt: null };
        } else {
          row = toAllocationRecord(
            await prisma.storageAllocation.create({
              data: { fsUuid: drive.fsUuid, mode, reservedBytes: toBig(reserved), status: "PENDING" },
            }),
          );
        }
        try {
          await prepareAndMigrate(row);
        } catch (err) {
          // A refusal surfaces to the owner now; a row this call created is not left behind as stray intent.
          if (!existing) await prisma.storageAllocation.deleteMany({ where: { id: row.id } });
          throw err;
        }
        await audit("info", "Camera recordings drive changed", actor, { fsUuid: drive.fsUuid, mode: modeName(mode) });
        return { accepted: true };
      }

      if (wantMode !== undefined) {
        const current = live ?? (facts.allocations.length === 0 ? undefined : facts.allocation ?? undefined);
        if (current && current.mode === wantMode) throw new RecordingsError("no_change", "recordings are already set that way");
        if (!live) {
          // No live row: the first allocation, with the requested mode, on the best drive.
          const drive = pickRecordingsDrive(facts.drives);
          if (!drive) throw new RecordingsError("no_allocation", "there is no eligible drive for camera recordings");
          if (wantMode === "AUTO_RESERVED") requireKnownRetention(facts);
          const reserved = wantMode === "FULL" ? drive.sizeBytes : initialReservedBytes(need, drive.freeBytes);
          const row = toAllocationRecord(
            await prisma.storageAllocation.create({
              data: { fsUuid: drive.fsUuid, mode: wantMode, reservedBytes: toBig(reserved), status: "PENDING" },
            }),
          );
          try {
            await prepareAndMigrate(row);
          } catch (err) {
            await prisma.storageAllocation.deleteMany({ where: { id: row.id } });
            throw err;
          }
          await audit("info", "Camera recordings allocation created", actor, { fsUuid: drive.fsUuid, mode: modeName(wantMode) });
          return { accepted: true };
        }
        // ── (B) switch the mode of the live drive: a quota change only, no restart ──
        const d = driveOf(facts, live.fsUuid);
        if (!d) throw new RecordingsError("not_eligible", "the recordings drive is not available");
        if (wantMode === "AUTO_RESERVED") requireKnownRetention(facts);
        const fsSize = facts.host?.fsSizeBytes ?? d.sizeBytes;
        const target =
          wantMode === "FULL"
            ? fsSize
            : reservedForMode("AUTO_RESERVED", {
                needTotalBytes: need,
                usedBytes: facts.host?.usedBytes ?? 0,
                fsSizeBytes: fsSize,
                fsFreeBytes: facts.host?.fsFreeBytes ?? d.freeBytes,
              });
        await bridge.resizeNvr(target);
        await prisma.storageAllocation.updateMany({
          where: { id: live.id },
          data: { mode: wantMode, reservedBytes: toBig(target) },
        });
        await audit("info", "Camera recordings size mode changed", actor, { fsUuid: live.fsUuid, mode: modeName(wantMode) });
        return { accepted: true };
      }

      // The same drive again: an owner's RETRY of a move that gave up. Anything else is a no-op.
      const stuck = req.fsUuid !== undefined ? facts.allocations.find((r) => r.fsUuid === req.fsUuid && r.id !== live?.id) : undefined;
      if (stuck && (stuck.migrationFailures > 0 || stuck.status !== "MIGRATING")) {
        await transition(stuck.id, [stuck.status], { status: "PENDING", migrationFailures: 0, lastFailureAt: null });
        await prepareAndMigrate({ ...stuck, status: "PENDING", migrationFailures: 0, lastFailureAt: null });
        await audit("info", "Camera recordings move retried", actor, { fsUuid: stuck.fsUuid });
        return { accepted: true };
      }
      throw new RecordingsError("no_change", "recordings are already set that way");
    } finally {
      release();
    }
  }

  async function deleteOldFootage(actor: RecordingsActor): Promise<{ accepted: true }> {
    await acquire(true);
    try {
      const facts = await freshFacts();
      const old = facts.migration?.oldSource;
      if (!old || old.deleted) throw new RecordingsError("no_old_footage", "there is no earlier footage to delete");
      if (facts.migration?.state === "running") throw new RecordingsError("busy", "a storage operation is already running");
      await bridge.deleteOldFootage();
      await audit("warn", "Earlier camera footage on the previous location is being deleted", actor, { bytes: old.bytes });
      return { accepted: true };
    } finally {
      release();
    }
  }

  async function getOverview(): Promise<RecordingsOverview> {
    return buildRecordingsOverview(await collectFacts());
  }

  return { reconcile, pollMigration, setAllocation, deleteOldFootage, getFacts: collectFacts, getOverview };
}
