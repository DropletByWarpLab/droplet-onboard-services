/**
 * ADR-055 (P4a) — the doors service: what a box knows about its doors, the
 * append-only log of what happened at them, and the retention of that log.
 *
 * Deliberately NOT here: anything that writes an `AccessEvent`. Events come
 * from the cartridge, and `services/access-control/` (brief §11.1) is a later
 * slice; until it exists nothing appends. The one thing this file may do to an
 * existing event is delete it — and only the retention job, inside its own
 * transaction, after opening the gate the database trigger looks for
 * (migration 20260929100200). No UPDATE and no other DELETE exists in this
 * file or anywhere else in the orchestrator; `doors-append-only.guard.test.ts`
 * reads the source to keep it that way.
 *
 * Everything here is private to the `doors` module: it is unreachable when
 * DOORS_ENABLED is off — except the retention job, which must keep running,
 * since rows already written keep identifying people whether or not the
 * surface is switched on (ADR-055 §10, GDPR).
 */
import type { Request } from "express";
import type { AccessEventKind, AccessForcedClaim, AccessTroubleCode, DoorPositionSource, Prisma, PrismaClient } from "@prisma/client";
import { actorFromRequest } from "./activity.service.js";
import { recordActivity } from "./activity.singleton.js";
import { chainSafeText, hasUnsafeDisplayChars } from "./security-audit.js";
import type { CronRuntime } from "./cron-runtime.service.js";
import {
  alarmClaimsFor,
  positionOf,
  type DoorPosition,
} from "./door-derivations.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("doors");

// ── limits ──────────────────────────────────────────────────────────────

/** Mirrors the AccessPoint_shape CHECK. */
export const DOOR_NAME_MAX = 80;
export const HELD_OPEN_DEFAULT_SECONDS = 30;
export const HELD_OPEN_MIN_SECONDS = 5;
export const HELD_OPEN_MAX_SECONDS = 3600;
export const DOOR_EVENTS_DEFAULT_LIMIT = 50;
export const DOOR_EVENTS_MAX_LIMIT = 200;

/** 03:55 — a slot none of the other nightly legs (03:00 … 03:50) uses. */
export const DOORS_RETENTION_CRON = "55 3 * * *";
export const DOORS_RETENTION_LOCK_KEY = "droplet:doors-event-retention";
/** Rows per DELETE, and DELETEs per run: a backlog drains over nights, never over the cron lock's transaction. */
const PURGE_BATCH = 5000;
const PURGE_MAX_BATCHES = 20;

// ── views ───────────────────────────────────────────────────────────────

export interface DoorView {
  id: string;
  name: string;
  doorPositionSource: DoorPositionSource;
  heldOpenSeconds: number;
  status: "active" | "retired";
  retiredAt: Date | null;
  /** From the newest position event. Unknown — never closed — until one exists; not_monitored for a `none` door. */
  position: DoorPosition;
  positionSince: Date | null;
  /** What this door is able to alarm on (§9.7). The UI says so. */
  claims: { forcedDoor: AccessForcedClaim | null; heldOpen: boolean };
  createdAt: Date;
  updatedAt: Date;
}

export interface DoorEventView {
  id: string;
  doorId: string;
  doorName: string;
  kind: AccessEventKind;
  occurredAt: Date;
  forcedClaim: AccessForcedClaim | null;
  troubleCode: AccessTroubleCode | null;
  derivedFromId: string | null;
  correlationKey: string | null;
}

interface AccessPointRow {
  id: string;
  name: string;
  doorPositionSource: DoorPositionSource;
  heldOpenSeconds: number;
  status: "active" | "retired";
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PositionRow {
  accessPointId: string;
  kind: AccessEventKind;
  troubleCode: AccessTroubleCode | null;
  occurredAt: Date;
}

function toDoorView(row: AccessPointRow, latest: PositionRow | undefined): DoorView {
  const source = row.doorPositionSource;
  return {
    id: row.id,
    name: row.name,
    doorPositionSource: source,
    heldOpenSeconds: row.heldOpenSeconds,
    status: row.status,
    retiredAt: row.retiredAt,
    position: positionOf(source, latest ? { kind: latest.kind, troubleCode: latest.troubleCode } : null),
    positionSince: source === "none" ? null : (latest?.occurredAt ?? null),
    claims: alarmClaimsFor(source),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── reads ───────────────────────────────────────────────────────────────

/**
 * The doors, with each one's position. A `none` door is never looked up: it
 * has no position to read, and the answer is `not_monitored`, said out loud.
 */
export async function listDoors(
  prisma: Pick<PrismaClient, "accessPoint" | "$queryRaw">,
  opts: { includeRetired: boolean },
): Promise<DoorView[]> {
  const rows = (await prisma.accessPoint.findMany({
    ...(opts.includeRetired ? {} : { where: { status: "active" as const } }),
    orderBy: [{ name: "asc" }, { id: "asc" }],
  })) as AccessPointRow[];

  const monitored = rows.filter((r) => r.doorPositionSource !== "none").map((r) => r.id);
  const latestByDoor = new Map<string, PositionRow>();
  if (monitored.length > 0) {
    // DISTINCT ON walks the (accessPointId, occurredAt) index per door; Prisma's
    // own `distinct` would read every matching row and pick in memory.
    const latest = await prisma.$queryRaw<PositionRow[]>`
      SELECT DISTINCT ON ("accessPointId") "accessPointId", "kind", "troubleCode", "occurredAt"
      FROM "AccessEvent"
      WHERE "accessPointId" = ANY(${monitored}::text[])
        AND ("kind" IN ('door_open', 'door_closed') OR ("kind" = 'trouble' AND "troubleCode" = 'position_unknown'))
      ORDER BY "accessPointId", "occurredAt" DESC, "id" DESC`;
    for (const r of latest) latestByDoor.set(r.accessPointId, r);
  }
  return rows.map((r) => toDoorView(r, latestByDoor.get(r.id)));
}

/** `<occurredAt ms>_<id>`. Both halves are bounded so a hostile cursor cannot overflow BIGINT (a 503 in P2a). */
const CURSOR_RE = /^(\d{1,15})_(\d{1,18})$/;

export function formatEventCursor(occurredAt: Date, id: bigint): string {
  return `${occurredAt.getTime()}_${id}`;
}

export function parseEventCursor(raw: string): { occurredAt: Date; id: bigint } | null {
  const m = CURSOR_RE.exec(raw);
  if (!m) return null;
  const occurredAt = new Date(Number(m[1]));
  if (Number.isNaN(occurredAt.getTime())) return null;
  return { occurredAt, id: BigInt(m[2]!) };
}

/**
 * Events, newest first by when the DEVICE says they happened, then by id. The
 * cursor is the last row's (occurredAt, id), so rows sharing an instant
 * neither repeat nor vanish across a page boundary.
 */
export async function listDoorEvents(
  prisma: Pick<PrismaClient, "accessEvent">,
  opts: { limit: number; cursor?: { occurredAt: Date; id: bigint }; doorId?: string },
): Promise<{ events: DoorEventView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit) || DOOR_EVENTS_DEFAULT_LIMIT), DOOR_EVENTS_MAX_LIMIT);
  const clauses: Prisma.AccessEventWhereInput[] = [];
  if (opts.doorId) clauses.push({ accessPointId: opts.doorId });
  if (opts.cursor) {
    const { occurredAt, id } = opts.cursor;
    clauses.push({ OR: [{ occurredAt: { lt: occurredAt } }, { occurredAt, id: { lt: id } }] });
  }
  const rows = await prisma.accessEvent.findMany({
    ...(clauses.length > 0 ? { where: { AND: clauses } } : {}),
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { accessPoint: { select: { name: true } } },
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    events: page.map((e) => ({
      id: e.id.toString(),
      doorId: e.accessPointId,
      doorName: e.accessPoint.name,
      kind: e.kind,
      occurredAt: e.occurredAt,
      forcedClaim: e.forcedClaim,
      troubleCode: e.troubleCode,
      derivedFromId: e.derivedFromId === null ? null : e.derivedFromId.toString(),
      correlationKey: e.correlationKey,
    })),
    nextCursor: rows.length > limit && last ? formatEventCursor(last.occurredAt, last.id) : null,
  };
}

// ── writes (owner only — the route enforces it) ─────────────────────────

export class DoorWriteError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: "INVALID_NAME" | "DOOR_NOT_FOUND" | "DOOR_RETIRED",
    message: string,
  ) {
    super(message);
    this.name = "DoorWriteError";
  }
}

export interface DoorWriteContext {
  req: Pick<Request, "user">;
  now: Date;
}

/**
 * A door's name as it is stored: NFC, edge whitespace gone, runs of spaces
 * collapsed, 1–80 characters, and nothing that reorders or hides text on the
 * lines around it (control characters, bidi overrides, NUL). It appears on
 * the audit trail, so it must be text the chain can carry.
 */
export function normaliseDoorName(raw: string): string | null {
  const name = raw.normalize("NFC").trim().replace(/\p{Zs}+/gu, " ");
  if (!chainSafeText(name) || hasUnsafeDisplayChars(name)) return null;
  const length = [...name].length;
  return length >= 1 && length <= DOOR_NAME_MAX ? name : null;
}

function invalidName(): DoorWriteError {
  return new DoorWriteError(400, "INVALID_NAME", `A door's name is 1–${DOOR_NAME_MAX} characters, with nothing that hides or reorders text`);
}

/** Door configuration is security-relevant (`none` switches alarms off), so every change is audited. Best effort: the recorder never throws. */
async function audit(
  ctx: DoorWriteContext,
  what: string,
  sub: string,
  action: "door.create" | "door.update" | "door.retire",
  refs: Record<string, unknown>,
): Promise<void> {
  await recordActivity({
    // system / info, never network / auth or warn / err: the Security threat
    // mirror copies exactly those, and an owner naming a door is not a threat.
    kind: "system",
    severity: "info",
    sourceIcon: "shield",
    what,
    sub,
    refs: { surface: "doors", action, ...refs },
    actor: actorFromRequest(ctx.req),
  });
}

export async function createDoor(
  prisma: Pick<PrismaClient, "accessPoint" | "$queryRaw">,
  input: { name: string; doorPositionSource: DoorPositionSource; heldOpenSeconds?: number },
  ctx: DoorWriteContext,
): Promise<DoorView> {
  const name = normaliseDoorName(input.name);
  if (name === null) throw invalidName();
  const row = (await prisma.accessPoint.create({
    data: {
      name,
      doorPositionSource: input.doorPositionSource,
      heldOpenSeconds: input.heldOpenSeconds ?? HELD_OPEN_DEFAULT_SECONDS,
    },
  })) as AccessPointRow;
  await audit(ctx, "Door added", row.name, "door.create", {
    doorId: row.id,
    doorPositionSource: row.doorPositionSource,
    heldOpenSeconds: row.heldOpenSeconds,
  });
  return toDoorView(row, undefined);
}

async function loadDoor(prisma: Pick<PrismaClient, "accessPoint">, id: string): Promise<AccessPointRow> {
  const row = (await prisma.accessPoint.findUnique({ where: { id } })) as AccessPointRow | null;
  if (!row) throw new DoorWriteError(404, "DOOR_NOT_FOUND", "No such door");
  return row;
}

async function viewOf(prisma: Pick<PrismaClient, "accessPoint" | "$queryRaw">, id: string): Promise<DoorView> {
  const row = await loadDoor(prisma, id);
  const latest = row.doorPositionSource === "none" ? [] : await prisma.$queryRaw<PositionRow[]>`
    SELECT DISTINCT ON ("accessPointId") "accessPointId", "kind", "troubleCode", "occurredAt"
    FROM "AccessEvent"
    WHERE "accessPointId" = ${id}
      AND ("kind" IN ('door_open', 'door_closed') OR ("kind" = 'trouble' AND "troubleCode" = 'position_unknown'))
    ORDER BY "accessPointId", "occurredAt" DESC, "id" DESC`;
  return toDoorView(row, latest[0]);
}

export async function updateDoor(
  prisma: Pick<PrismaClient, "accessPoint" | "$queryRaw">,
  id: string,
  patch: { name?: string; doorPositionSource?: DoorPositionSource; heldOpenSeconds?: number },
  ctx: DoorWriteContext,
): Promise<DoorView> {
  const current = await loadDoor(prisma, id);
  if (current.status === "retired") throw new DoorWriteError(409, "DOOR_RETIRED", "This door is retired and can't be changed");

  const data: { name?: string; doorPositionSource?: DoorPositionSource; heldOpenSeconds?: number } = {};
  if (patch.name !== undefined) {
    const name = normaliseDoorName(patch.name);
    if (name === null) throw invalidName();
    if (name !== current.name) data.name = name;
  }
  if (patch.doorPositionSource !== undefined && patch.doorPositionSource !== current.doorPositionSource) {
    data.doorPositionSource = patch.doorPositionSource;
  }
  if (patch.heldOpenSeconds !== undefined && patch.heldOpenSeconds !== current.heldOpenSeconds) {
    data.heldOpenSeconds = patch.heldOpenSeconds;
  }
  const changed = Object.keys(data);
  if (changed.length === 0) return viewOf(prisma, id);

  // The status guard rides on the write itself: a door retired between the read
  // above and this line must not be quietly edited.
  const { count } = await prisma.accessPoint.updateMany({ where: { id, status: "active" }, data });
  if (count === 0) throw new DoorWriteError(409, "DOOR_RETIRED", "This door is retired and can't be changed");

  await audit(ctx, "Door changed", data.name ?? current.name, "door.update", {
    doorId: id,
    changed,
    // The one change with teeth: `none` switches forced-door and held-open off.
    ...(data.doorPositionSource ? { doorPositionSource: { from: current.doorPositionSource, to: data.doorPositionSource } } : {}),
    ...(data.heldOpenSeconds !== undefined ? { heldOpenSeconds: { from: current.heldOpenSeconds, to: data.heldOpenSeconds } } : {}),
  });
  return viewOf(prisma, id);
}

/** A door is retired, never deleted: its events are evidence and reference it. Retiring twice is a no-op, not an error. */
export async function retireDoor(
  prisma: Pick<PrismaClient, "accessPoint" | "$queryRaw">,
  id: string,
  ctx: DoorWriteContext,
): Promise<DoorView> {
  const current = await loadDoor(prisma, id);
  if (current.status === "retired") return viewOf(prisma, id);
  const { count } = await prisma.accessPoint.updateMany({
    where: { id, status: "active" },
    data: { status: "retired", retiredAt: ctx.now },
  });
  if (count === 1) await audit(ctx, "Door retired", current.name, "door.retire", { doorId: id });
  return viewOf(prisma, id);
}

// ── retention ───────────────────────────────────────────────────────────

/**
 * Delete events the box received more than `retentionDays` ago. The ONLY code
 * in the orchestrator that deletes an AccessEvent.
 *
 * The database trigger refuses every DELETE except inside a transaction that
 * has set `droplet.access_event_retention` to `on`; this opens one, sets it
 * with a transaction-local `set_config` (so it cannot outlive the
 * transaction, or leak to another statement on a pooled connection), and
 * deletes. `doors-append-only.guard.test.ts` pins that no other file names it.
 *
 * Counts from `createdAt` — when THIS box received the row — not `occurredAt`,
 * the device's word: a device with a wrong clock must not be able to keep a
 * row forever, or expire it at once.
 *
 * A `door_open` row that a younger alarm still cites is kept until that alarm
 * ages out too (§11.3: derived alarms reference it, so the evidence must be
 * whole for as long as the alarm exists). Deleting highest id first means an
 * alarm always goes before, or in the same statement as, the row it cites; the
 * foreign key is NO ACTION for exactly that reason.
 */
export async function purgeExpiredAccessEvents(
  prisma: Pick<PrismaClient, "$transaction">,
  retentionDays: number,
  now: Date = new Date(),
): Promise<{ deleted: number; before: Date }> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    // A typo must never read as "delete everything", nor as "keep forever".
    throw new Error(`door event retention must be a whole number of days >= 1, got ${String(retentionDays)}`);
  }
  const before = new Date(now.getTime() - retentionDays * 86_400_000);
  const deleted = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('droplet.access_event_retention', 'on', true)`;
      let total = 0;
      for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
        const n = await tx.$executeRaw`
          DELETE FROM "AccessEvent" WHERE "id" IN (
            SELECT e."id" FROM "AccessEvent" e
            WHERE e."createdAt" < ${before}
              AND NOT EXISTS (
                SELECT 1 FROM "AccessEvent" d
                WHERE d."derivedFromId" = e."id" AND d."createdAt" >= ${before}
              )
            ORDER BY e."id" DESC
            LIMIT ${PURGE_BATCH}
          )`;
        total += n;
        if (n < PURGE_BATCH) break;
      }
      return total;
    },
    { timeout: 30_000, maxWait: 5_000 },
  );
  return { deleted, before };
}

/**
 * The daily purge, on the orchestrator's cron runtime, single-flighted on its
 * own advisory lock. Registered whether or not DOORS_ENABLED is on: rows
 * already written keep identifying people, and their clock does not stop
 * because the surface was switched off. No new container, no bare setInterval,
 * no `while (true)`.
 */
export function registerDoorsJobs(
  cronRuntime: Pick<CronRuntime, "scheduleCron">,
  prisma: PrismaClient,
  retentionDays: number,
): void {
  cronRuntime.scheduleCron(
    DOORS_RETENTION_CRON,
    async () => {
      const r = await purgeExpiredAccessEvents(prisma, retentionDays, new Date());
      if (r.deleted > 0) logger.info(r, "door event retention purge");
    },
    { lockKey: DOORS_RETENTION_LOCK_KEY },
  );
  retentionRegistered = true;
}

/** Read by the boot assertion (doors-wiring.ts): a box with doors on and no purge scheduled must not start. */
let retentionRegistered = false;
export function doorsRetentionRegistered(): boolean {
  return retentionRegistered;
}
export function _resetDoorsJobsForTests(): void {
  retentionRegistered = false;
}
