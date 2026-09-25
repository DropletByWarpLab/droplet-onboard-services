/**
 * WARP-2980 (ADR-059 P5 PR-B, brief §4.4, p5b spec D12, D13, D18; routes
 * 32–34) — expected activity. "Suppression" is the code's and the ADR's word;
 * the UI only ever says "Expected activity".
 *
 * A person at Security manage says: this label, at this place, in this
 * window of hours on these days, is normal — so the pattern rules record the
 * matching flags as `suppressed` instead of `trial` (security-pattern-rules.ts
 * via `suppressionFor`). It quiets out_of_place, unusual_volume and
 * long_dwell ONLY — never after_hours_presence, camera_offline or
 * threat_signal (D12): it "is the one lever that can hide a real intrusion"
 * (brief §4.4), so it can never silence the one rule that says someone is
 * inside after hours.
 *
 * IMMUTABLE (D13). There is no edit and no extend: to change one, remove it
 * and add another, and both are audited — so "never extended or widened" is
 * structural. It ends when a person removes it or when its `expiresAt`
 * passes (≤ 365 days, default 30); every reader also requires
 * `expiresAt > now`, so a lagging expiry job never extends one.
 *
 * WRITES follow the audit contract (security-audit.ts): READ COMMITTED; the
 * limit's advisory lock and every CAS first; `auditSecurityInTx` LAST. The
 * reason a person typed never goes into the audit refs (user text stays off
 * the chain, as the resolve note does). Expiry is the system's: per row,
 * after its CAS, `auditSecuritySystem` — and a failed audit is returned, not
 * thrown, so the baseline tick can finish first (D18).
 *
 * DS-005 on the list (route 32): owner/admin (every camera) see every row;
 * anyone else sees a row only when they may see EVERY camera behind its key —
 * P5-A's own `visibleKeyCameras`, the rule for that key's numbers (review
 * item 9): the row names a place, a time and a person's reason. An archived
 * or unlinked area's rows are therefore owner/admin only.
 */
import type { PrismaClient, SecuritySuppressionDays } from "@prisma/client";
import { auditSecurityInTx, auditSecuritySystem, stripUnsafeDisplayChars } from "./security-audit.js";
import { summaryName } from "./security-mode.service.js";
import { loadActiveLinks, loadCameraLabels } from "./security-zones.service.js";
import { visibleKeyCameras } from "./security-patterns-read.js";
import type { SecurityViewerScope } from "./security-access.js";
import type { PatternCode } from "../lib/security-baseline-math.js";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-suppressions");

/** At most this many active at once (409 SUPPRESSION_LIMIT), counted under the lock. */
export const SECURITY_SUPPRESSION_ACTIVE_LIMIT = 100;
/** brief §4.4: default 30 days, at most a year. */
export const SUPPRESSION_DEFAULT_DAYS = 30;
export const SUPPRESSION_MAX_DAYS = 365;
/** Serialises "fewer than 100 active" with the create — the zone-limit idiom (security-zones.service.ts). */
const SUPPRESSION_LIMIT_LOCK_KEY = "droplet:security-suppression-limit";
const DAY_MS = 86_400_000;

/** Route 32's row. Mirrored in apps/web-dashboard/src/lib/types.ts. */
export interface SuppressionView {
  id: string;
  target: { kind: "area"; zoneId: string; name: string; archived: boolean } | { kind: "camera"; camera: string; name: string };
  label: string;
  days: SecuritySuppressionDays;
  hourFrom: number;
  hourCount: number;
  codes: PatternCode[];
  reason: string;
  createdByName: string;
  createdAt: string;
  expiresAt: string;
  /** Flags it quietened — owner/admin only (flags are, D16); null for anyone else. */
  quietedFlags: number | null;
}

export interface SuppressionList {
  suppressions: SuppressionView[];
  /** Whether this viewer may add and remove (route 33/34's gate, answered by the server — D22). */
  canManage: boolean;
  limit: typeof SECURITY_SUPPRESSION_ACTIVE_LIMIT;
}

const ROW_SELECT = {
  id: true,
  targetKind: true,
  zoneId: true,
  camera: true,
  label: true,
  days: true,
  hourFrom: true,
  hourCount: true,
  codes: true,
  reason: true,
  createdByName: true,
  createdAt: true,
  expiresAt: true,
  zone: { select: { name: true, state: true } },
} as const;

type Row = {
  id: string;
  targetKind: "area" | "camera";
  zoneId: string | null;
  camera: string | null;
  label: string;
  days: SecuritySuppressionDays;
  hourFrom: number;
  hourCount: number;
  codes: string[];
  reason: string;
  createdByName: string;
  createdAt: Date;
  expiresAt: Date;
  zone: { name: string; state: "active" | "archived" } | null;
};

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `in Stock room` / `on camera back` — the audit's place, display-safe. */
function placeOf(row: { targetKind: string; camera: string | null; zone: { name: string } | null }): string {
  if (row.targetKind === "area") {
    const name = stripUnsafeDisplayChars(row.zone?.name ?? "").trim();
    return name ? `in ${name}` : "in an area";
  }
  return `on camera ${row.camera}`;
}

function viewOf(row: Row, cameraLabels: ReadonlyMap<string, string>, quieted: number | null): SuppressionView {
  return {
    id: row.id,
    target:
      row.targetKind === "area"
        ? { kind: "area", zoneId: row.zoneId!, name: row.zone?.name ?? "", archived: row.zone?.state !== "active" }
        : { kind: "camera", camera: row.camera!, name: cameraLabels.get(row.camera!) ?? row.camera! },
    label: row.label,
    days: row.days,
    hourFrom: row.hourFrom,
    hourCount: row.hourCount,
    codes: row.codes as PatternCode[],
    reason: row.reason,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    quietedFlags: quieted,
  };
}

// ── route 32 ─────────────────────────────────────────────────────────────

/**
 * The expected activity this viewer may see: active and not past its
 * `expiresAt` (ended ones live in the audit log). Sorted by the place's
 * name, the label, the first hour, the id. Throws on a read failure — the
 * route answers 503, never an empty list.
 */
export async function listSuppressions(
  prisma: PrismaClient,
  viewer: { scope: Pick<SecurityViewerScope, "visibleCameras">; ownerOrAdmin: boolean },
  now: Date,
): Promise<SuppressionView[]> {
  const rows = (await prisma.securitySuppression.findMany({
    where: { state: "active", expiresAt: { gt: now } },
    select: ROW_SELECT,
  })) as Row[];
  if (rows.length === 0) return [];
  const { scope } = viewer;
  let visible = rows;
  if (scope.visibleCameras !== "all") {
    const areaIds = [...new Set(rows.filter((r) => r.targetKind === "area").map((r) => r.zoneId!))];
    const [links, ready] = await Promise.all([
      loadActiveLinks(prisma),
      prisma.securityBaselineBuild.findFirst({ where: { state: "ready" }, select: { id: true } }),
    ]);
    // An area's cameras as its numbers are judged: its cells' (one row per built key), else its links'.
    const cells =
      ready && areaIds.length > 0
        ? await prisma.securityBaselineCell.findMany({
            where: { buildId: ready.id, keyKind: "area", zoneId: { in: areaIds }, label: "person", dayType: "weekday", hour: 0 },
            select: { zoneId: true, cameras: true },
          })
        : [];
    const cellCameras = new Map(cells.map((c) => [c.zoneId, c.cameras]));
    visible = rows.filter((r) =>
      r.targetKind === "area"
        ? visibleKeyCameras({ kind: "area", zoneId: r.zoneId! }, links, cellCameras.get(r.zoneId) ?? null, scope) !== null
        : visibleKeyCameras({ kind: "camera", camera: r.camera! }, links, null, scope) !== null,
    );
  }
  const [cameraLabels, quieted] = await Promise.all([
    loadCameraLabels(prisma),
    viewer.ownerOrAdmin && visible.length > 0
      ? prisma.securityPatternFlag.groupBy({
          by: ["suppressionId"],
          where: { suppressionId: { in: visible.map((r) => r.id) } },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ suppressionId: string | null; _count: { _all: number } }>),
  ]);
  const counts = new Map(quieted.map((g) => [g.suppressionId, g._count._all]));
  return visible
    .map((r) => viewOf(r, cameraLabels, viewer.ownerOrAdmin ? (counts.get(r.id) ?? 0) : null))
    .sort(
      (a, b) =>
        a.target.name.localeCompare(b.target.name) || a.label.localeCompare(b.label) || a.hourFrom - b.hourFrom || byString(a.id, b.id),
    );
}

// ── route 33 ─────────────────────────────────────────────────────────────

export interface CreateSuppressionInput {
  target: { kind: "area"; zoneId: string } | { kind: "camera"; camera: string };
  label: string;
  days: SecuritySuppressionDays;
  hourFrom: number;
  hourCount: number;
  /** 1–3 distinct pattern codes (zod); long_dwell only with `person`. */
  codes: PatternCode[];
  /** Trimmed, 1–120, already checked with `chainSafeText` / `hasUnsafeDisplayChars` by the route. */
  reason: string;
  expiresInDays: number;
}

export interface SuppressionActor {
  id: string;
  role: string;
  username: string;
  displayName: string;
}

export type CreateSuppressionResult =
  | { status: "ok"; suppression: SuppressionView }
  | { status: "target_not_found" }
  | { status: "zone_archived" }
  | { status: "limit" };

/**
 * Route 33, in ONE READ COMMITTED transaction: the limit's advisory lock; an
 * area target re-read (archived → 409); the count of active ones (≥ 100 →
 * 409); the row, with `createdAt` and `expiresAt` from the ROUTE clock (never
 * the database default, so the CHECK compares one clock); the audit LAST.
 */
export async function createSuppression(
  prisma: PrismaClient,
  input: CreateSuppressionInput,
  actor: SuppressionActor,
  now: Date,
): Promise<CreateSuppressionResult> {
  const t = input.target;
  if (t.kind === "area") {
    if (!(await prisma.securityZone.findUnique({ where: { id: t.zoneId }, select: { id: true } }))) return { status: "target_not_found" };
  } else if (!(await prisma.camera.findUnique({ where: { name: t.camera }, select: { name: true } }))) {
    return { status: "target_not_found" };
  }
  const expiresAt = new Date(now.getTime() + input.expiresInDays * DAY_MS);
  const outcome = await prisma.$transaction(async (tx) => {
    // `IS NULL` so the row has a boolean column: Prisma cannot deserialise `void`.
    await tx.$queryRaw`SELECT (pg_advisory_xact_lock(hashtext(${SUPPRESSION_LIMIT_LOCK_KEY}::text)) IS NULL) AS locked`;
    let zone: { name: string; state: "active" | "archived" } | null = null;
    if (t.kind === "area") {
      zone = await tx.securityZone.findUnique({ where: { id: t.zoneId }, select: { name: true, state: true } });
      if (!zone) return { status: "target_not_found" as const };
      if (zone.state !== "active") return { status: "zone_archived" as const };
    }
    const active = await tx.securitySuppression.count({ where: { state: "active", expiresAt: { gt: now } } });
    if (active >= SECURITY_SUPPRESSION_ACTIVE_LIMIT) return { status: "limit" as const };
    const row = (await tx.securitySuppression.create({
      data: {
        targetKind: t.kind,
        zoneId: t.kind === "area" ? t.zoneId : null,
        camera: t.kind === "camera" ? t.camera : null,
        label: input.label,
        days: input.days,
        hourFrom: input.hourFrom,
        hourCount: input.hourCount,
        codes: [...input.codes],
        reason: input.reason,
        createdById: actor.id,
        createdByName: summaryName(actor.displayName || actor.username),
        createdAt: now,
        expiresAt,
      },
      select: ROW_SELECT,
    })) as Row;
    // LAST: it takes the box-wide chain lock until commit; nothing may follow it here.
    await auditSecurityInTx(tx, { user: { id: actor.id, role: actor.role } }, {
      action: "suppression.create",
      what: `Security: added expected activity ${placeOf(row)}`,
      // Never the reason: user text stays off the chain.
      refs: {
        suppressionId: row.id,
        target: t.kind === "area" ? { kind: "area", zoneId: t.zoneId } : { kind: "camera", camera: t.camera },
        label: row.label,
        days: row.days,
        hourFrom: row.hourFrom,
        hourCount: row.hourCount,
        codes: [...row.codes],
        expiresAt: expiresAt.toISOString(),
      },
    });
    return { status: "ok" as const, row };
  }, READ_COMMITTED_TX);
  if (outcome.status !== "ok") return outcome;
  // The creator passed the manage floor (owner/admin): they see every flag, and this one has quietened none yet.
  return { status: "ok", suppression: viewOf(outcome.row, await loadCameraLabels(prisma), 0) };
}

// ── route 34 ─────────────────────────────────────────────────────────────

export type RemoveSuppressionResult = { status: "ok"; changed: boolean } | { status: "not_found" };

/**
 * Route 34: `active` → `removed`, with who and when, in one READ COMMITTED
 * transaction whose CAS is `{id, state: active, expiresAt > now}` — a row
 * past its expiry (the job has not marked it yet) is not a person's to end,
 * so it answers `changed: false` with no audit, like one already ended.
 */
export async function removeSuppression(prisma: PrismaClient, id: string, actor: SuppressionActor, now: Date): Promise<RemoveSuppressionResult> {
  const row = await prisma.securitySuppression.findUnique({
    where: { id },
    select: { id: true, targetKind: true, camera: true, zone: { select: { name: true } } },
  });
  if (!row) return { status: "not_found" };
  const changed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.securitySuppression.updateMany({
      where: { id, state: "active", expiresAt: { gt: now } },
      data: { state: "removed", endedAt: now, endedById: actor.id },
    });
    if (count !== 1) return false;
    await auditSecurityInTx(tx, { user: { id: actor.id, role: actor.role } }, {
      action: "suppression.remove",
      what: `Security: removed expected activity ${placeOf(row)}`,
      refs: { suppressionId: id },
    });
    return true;
  }, READ_COMMITTED_TX);
  return { status: "ok", changed };
}

// ── expiry (D18) ─────────────────────────────────────────────────────────

/**
 * Every baseline tick, before its zone check (so it runs with no site zone
 * too): each `active` row whose `expiresAt` has passed → `expired`, per-row
 * CAS on `{state: active}` — a row removed between the read and the CAS is
 * not expired, and not audited. One `suppression.expire` system audit per
 * row, AFTER its commit. Every row is audited even when one audit fails; the
 * first failure is RETURNED, and the tick rethrows it only once its own work
 * is done — never through its `lastError` path, which would say "Couldn't
 * check which cameras…", a false thing.
 */
export async function expireSuppressions(
  prisma: Pick<PrismaClient, "securitySuppression">,
  now: Date,
): Promise<{ expired: number; auditError?: unknown }> {
  const due = await prisma.securitySuppression.findMany({
    where: { state: "active", expiresAt: { lte: now } },
    select: { id: true, targetKind: true, camera: true, zone: { select: { name: true } } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
  });
  let expired = 0;
  let auditError: unknown;
  for (const row of due) {
    const { count } = await prisma.securitySuppression.updateMany({
      where: { id: row.id, state: "active" },
      data: { state: "expired", endedAt: now },
    });
    if (count !== 1) continue;
    expired++;
    try {
      await auditSecuritySystem({ action: "suppression.expire", what: `Security: expected activity ended ${placeOf(row)}`, refs: { suppressionId: row.id } });
    } catch (err) {
      logger.error({ err, suppressionId: row.id }, "expected activity ended, but its audit row could not be written");
      auditError ??= err;
    }
  }
  return auditError === undefined ? { expired } : { expired, auditError };
}
