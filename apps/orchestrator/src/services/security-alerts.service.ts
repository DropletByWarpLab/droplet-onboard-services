/**
 * WARP-2978 (ADR-059 P3 §3.7, spec §6.7, §6.11, §7 routes 21–22) — who is
 * told about Security alerts, the notifier that tells them, redelivery, and
 * the `alerts` health row.
 *
 * ROUTING (D25, D26). An owner is a recipient by default: a `receiving` row
 * with origin `owner_default` is created lazily (INSERT … ON CONFLICT DO
 * NOTHING, never upsert) on every routing read and every notify, so a new
 * owner is told without anyone doing anything — and a person can still turn
 * an owner off. Everyone else is told only after a person chose them (no row =
 * not told). Security department managers are SUGGESTED in the settings UI
 * and granted nothing. Eligibility — active, a household role, a username that
 * passes WARP-2911's guard, and Security ≥ act through the §9 resolver
 * (owners bypass) — is checked when a setting is saved (at least one eligible
 * receiver, under an advisory lock) AND again at send time; the eligible
 * owners are the fallback when nobody routed can be told.
 *
 * THE NOTIFIER (engine step 6), per incident with notifyState = pending,
 * oldest alert first:
 *   1. module off box-wide → notifyState module_off (D29). Grouped, never sent.
 *   2. the recipients: every receiving row (eligible or not — an ineligible one
 *      gets a `skipped_*` notice, so "who was told" can say why), plus the
 *      eligible owners when no routed person is reached (`fallback_owner`).
 *      A RE-PLAN (review R4: the engine set an already-notified alert pending
 *      again because alert evidence arrived on a new camera) plans only the
 *      people whose notice is `skipped_not_visible`, updating that notice in
 *      place — still one notice, one notification at most, per person;
 *   3. per recipient, DS-005 (D27): the alert evidence on cameras they can
 *      see (`visibleCameraNames`). None → `skipped_not_visible`. The copy is
 *      built from that visible evidence only. ≥ 6 alert notifications to them
 *      in the last hour → `skipped_capped` (D28);
 *   4. ONE READ COMMITTED transaction: the incident CAS (pending → done), a
 *      NotificationLog row per queued recipient (`recordNotification`, by
 *      USERNAME — never User.id), and every notice. @@unique(incident, user)
 *      and the already-noticed filter mean nobody is ever told twice;
 *   5. after commit: `deliverNotification(id, {tag, priority: 'alert'})` per
 *      queued notice, then the notice is settled from the row's own stamp;
 *   6. `incident.alerted`, audited by the system after the commit. A failed
 *      audit is RETURNED (`auditError`), never thrown here: the engine
 *      finishes its tick — every other incident, redelivery, health — and
 *      only then rethrows it into safeRun's canary (review #8).
 * A throw in 1–4 counts an attempt; the third is terminal (`failed`, and the
 * alerts health row goes down).
 *
 * SETTLING (review #7). WARP-2804's delivery CLAIMS a NotificationLog row
 * (`error = 'delivery: outcome_unknown'`) before any transport and the stamp
 * overwrites the claim — so a row is delivered at most once, and a retry by
 * id is a no-op. A notice is settled from its row:
 *   · delivered (`deliveredAt`) → `sent`;
 *   · still carrying the claim → `outcome_unknown`: the transport ran (or
 *     crashed mid-way) and its stamp was lost, so the person may or may not
 *     have been reached. Never `not_sent` — the audit must not say they were
 *     not reached when they may have been;
 *   · stamped with nothing delivered → `not_sent`;
 *   · never claimed → left `queued`.
 * A notice still `queued` two minutes on (the process died between commit and
 * delivery, or the tick hit its deadline) gets its delivery then — which
 * only transports a row that was never claimed — and is settled either way,
 * so it never loops: a row that still cannot be claimed or read settles
 * `not_sent` (nothing was sent).
 */
import type { DirectoryUserStatus, Prisma, PrismaClient, Role, SecurityNoticeOutcome, SecurityNoticeReason } from "@prisma/client";
import { isUserIdShaped } from "@droplet/auth-policy";
import type { SecurityHealthRow } from "./security-events.service.js";
import type { EffectiveAccessResolver } from "../middleware/feature-gate.js";
import { resolveEffectiveAccess } from "./effective-access.service.js";
import { FEATURE_LEVEL_RANK, type FeatureLevel } from "./access-catalog.js";
import { visibleCameraNames } from "./camera-access.service.js";
import { deliverNotification, recordNotification } from "./notifications.service.js";
import { webPushGate } from "./off-lan-gate.service.js";
import { auditSecurityInTx, auditSecuritySystem, chainSafeText, stripUnsafeDisplayChars } from "./security-audit.js";
import { summaryName } from "./security-mode.service.js";
import { isLockLinkRef, parseLinkRef } from "./security-zones.service.js";
import { alertCopy, type AlertEvidence } from "../lib/security-alert-copy.js";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";
import { isValidIanaZone } from "../lib/zoned-time.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-alerts");

export const SECURITY_NOTIFY_MAX_ATTEMPTS = 3;
/** D28: alert notifications per recipient per rolling hour; the rest are shown in Security only. */
export const SECURITY_ALERT_HOURLY_CAP = 6;
/** A notice still queued this long after it was written is delivered once more. */
export const SECURITY_REDELIVER_AFTER_MS = 120_000;
export const SECURITY_ALERT_ROUTING_LOCK_KEY = "droplet:security-alert-routing";
/** Incidents handled per notify step. */
const NOTIFY_BATCH = 20;
const REDELIVER_BATCH = 50;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SINGLETON = "singleton";
const HOUSEHOLD_ROLES: readonly Role[] = ["owner", "admin", "family"];
/** Notices that count against the hourly cap: a NotificationLog row was written for them. */
const COUNTED: readonly SecurityNoticeOutcome[] = ["queued", "sent", "not_sent", "outcome_unknown"];
/** WARP-2804's claim on a row whose delivery started (notifications.service.ts). */
const DELIVERY_CLAIMED = "delivery: outcome_unknown";

/** What the engine hands the notifier. */
export interface NotifierDeps {
  isSecurityModuleOn: () => Promise<boolean>;
  resolveAccess: EffectiveAccessResolver;
}

/**
 * Review #6 — the engine's tick runs inside a 60 s advisory-lock transaction,
 * and a push dial may take 10 s. `deadline()` turns true once the tick has
 * spent its budget: nothing new is started after that (an incident, a
 * delivery, a redelivery) and the rest waits for the next tick — pending
 * incidents stay pending, queued notices stay queued for redelivery.
 */
export interface NotifyOptions {
  deadline?: () => boolean;
}

/** The push / tray collapse key for one incident's notifications. */
export function incidentTag(incidentId: string): string {
  return `security-incident-${incidentId}`;
}

// ── eligibility ───────────────────────────────────────────────────────────

export type IneligibleReason = "inactive" | "role" | "no_address" | "no_access";

export interface Eligibility {
  eligible: boolean;
  reason: IneligibleReason | null;
}

export interface EligibilityUser {
  id: string;
  username: string;
  role: Role;
  directoryStatus: DirectoryUserStatus;
}

const USER_SELECT = { id: true, username: true, displayName: true, role: true, directoryStatus: true } as const;
type RecipientUser = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

/**
 * Whether this person may be told about alerts right now (D25). A resolver
 * failure is NOT access — they are skipped this time and recorded as such.
 */
export async function eligibilityOf(user: EligibilityUser, resolve: EffectiveAccessResolver): Promise<Eligibility> {
  if (user.directoryStatus !== "ACTIVE") return { eligible: false, reason: "inactive" };
  if (!HOUSEHOLD_ROLES.includes(user.role)) return { eligible: false, reason: "role" };
  if (isUserIdShaped(user.username)) return { eligible: false, reason: "no_address" };
  let level: FeatureLevel | null = null;
  try {
    const access = await resolve(user.id);
    level = access?.features.find((f) => f.moduleId === "security")?.level ?? null;
  } catch (err) {
    logger.warn({ err, userId: user.id }, "alert eligibility: the access resolver failed — not told this time");
    return { eligible: false, reason: "no_access" };
  }
  if (level === null || FEATURE_LEVEL_RANK[level] < FEATURE_LEVEL_RANK.act) return { eligible: false, reason: "no_access" };
  return { eligible: true, reason: null };
}

/** Owners are recipients by default: their `receiving` rows, created lazily. */
export async function ensureOwnerRecipients(prisma: PrismaClient | Prisma.TransactionClient): Promise<void> {
  const owners = await prisma.user.findMany({ where: { role: "owner" }, select: { id: true } });
  if (owners.length === 0) return;
  await prisma.securityAlertRecipient.createMany({
    data: owners.map((o) => ({ userId: o.id, state: "receiving" as const, origin: "owner_default" as const })),
    skipDuplicates: true,
  });
}

/** A person's name as copy may carry it (display-safe, never empty). */
function displayName(u: { displayName: string; username: string }): string {
  const name = stripUnsafeDisplayChars(u.displayName || "").trim().slice(0, 60);
  return name.length > 0 ? name : "Someone";
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ── the notifier ──────────────────────────────────────────────────────────

/** The site's clock zone for alert copy: the site's own, else a valid Workspace.tz, else none (never UTC). */
async function copyZone(prisma: PrismaClient): Promise<string | null> {
  const site = await prisma.securitySiteHours.findUnique({ where: { id: SINGLETON }, select: { state: true, timezone: true } });
  if (site?.state === "set" && site.timezone && isValidIanaZone(site.timezone)) return site.timezone;
  const ws = await prisma.workspace.findUnique({ where: { id: 1 }, select: { tz: true } });
  return ws?.tz && isValidIanaZone(ws.tz) ? ws.tz : null;
}

interface PlannedNotice {
  user: RecipientUser;
  reason: SecurityNoticeReason;
  outcome: SecurityNoticeOutcome;
  copy: { title: string; body: string } | null;
  /** A re-plan (review R4): the id of this person's `skipped_not_visible` notice, updated in place — never a second notice. */
  replaces?: string;
}

const INCIDENT_SELECT = {
  id: true,
  version: true,
  notifyState: true,
  notifyAttempts: true,
  zoneName: true,
  scope: true,
  reasons: {
    where: { severity: "alert" as const },
    select: { evidenceCamera: true, evidenceAt: true, detail: true },
  },
} as const satisfies Prisma.SecurityIncidentSelect;
type NotifyIncident = Prisma.SecurityIncidentGetPayload<{ select: typeof INCIDENT_SELECT }>;

/**
 * Notices that mean the incident reached someone: a NotificationLog row was
 * written (whatever its transport did), or the person was capped — they were
 * told about other alerts this hour and see this one in Security.
 *
 * Why a cap counts as reached (and so never triggers the owner fallback): the
 * cap (D28) damps a storm — six alerts to one person in an hour. If capping
 * everyone routed woke the owners instead, the storm would move to exactly
 * the people who chose not to be told, at the moment alerts are most
 * frequent. The fallback is for an alert NOBODY routed could be told about
 * (nobody eligible, or nobody who can see its camera — review #2), which is
 * the rule's wording "every routed person skipped_not_visible → fall back".
 */
const REACHED: readonly SecurityNoticeOutcome[] = ["queued", "sent", "not_sent", "outcome_unknown", "skipped_capped"];

/**
 * Steps 2–3: who is told, and each one's outcome and words. Reads only (plus
 * the owners' lazy rows).
 *
 * The routed people are planned first. If NONE of them is reached (queued or
 * capped) — nobody eligible, or everyone eligible cannot see the evidence's
 * camera (review #2: eligibility is about Security, not about cameras) — the
 * eligible owners not already planned are added with `fallback_owner`, so an
 * alert never goes to nobody.
 *
 * A RE-PLAN (review R4) — the incident already has notices, and the engine set
 * it pending again because alert evidence arrived on a new camera — plans
 * only the routed people whose notice is `skipped_not_visible`, and moves only
 * one who can now see alert evidence (told, or capped): their notice is
 * updated in place (`replaces`), so it is still one notice, and at most one
 * notification, per person per incident. Nobody routed since is added.
 */
async function planNotices(
  prisma: PrismaClient,
  deps: NotifierDeps,
  incident: NotifyIncident,
  now: Date,
): Promise<{ planned: PlannedNotice[]; replan: boolean }> {
  await ensureOwnerRecipients(prisma);
  const existing = await prisma.securityIncidentNotice.findMany({
    where: { incidentId: incident.id },
    select: { id: true, userId: true, outcome: true, reason: true },
  });
  // User.id — an exclusion set, never a recipient.
  const already = new Set(existing.map((n) => n.userId));
  const replan = existing.length > 0;
  const reachedBefore = await prisma.securityIncidentNotice.count({ where: { incidentId: incident.id, outcome: { in: [...REACHED] } } });
  const routed = await prisma.securityAlertRecipient.findMany({
    where: { state: "receiving" },
    select: { user: { select: USER_SELECT } },
    orderBy: { userId: "asc" },
  });

  const cameras = [...new Set(incident.reasons.map((r) => r.evidenceCamera).filter((c): c is string => c !== null))];
  const labels = new Map(
    (await prisma.camera.findMany({ where: { name: { in: cameras } }, select: { name: true, displayName: true } })).map((c) => [
      c.name,
      c.displayName,
    ]),
  );
  const tz = await copyZone(prisma);
  const hourAgo = new Date(now.getTime() - HOUR_MS);

  const plan = async (user: RecipientUser, reason: SecurityNoticeReason, eligibility: Eligibility): Promise<PlannedNotice> => {
    if (!eligibility.eligible) {
      return { user, reason, outcome: eligibility.reason === "no_address" ? "skipped_no_address" : "skipped_no_access", copy: null };
    }
    // DS-005, per recipient: only the alert evidence on cameras they can see.
    const visible = await visibleCameraNames(prisma, { id: user.id, role: user.role });
    const ownerOrAdmin = user.role === "owner" || user.role === "admin";
    const evidence: AlertEvidence[] = incident.reasons
      .filter((r) => (r.evidenceCamera === null ? ownerOrAdmin : visible === "all" || visible.has(r.evidenceCamera)))
      .map((r) => ({
        cameraLabel: r.evidenceCamera ? (labels.get(r.evidenceCamera) ?? r.evidenceCamera) : "The camera system",
        at: r.evidenceAt,
        mode: String((r.detail as Record<string, unknown> | null)?.mode ?? "closed"),
      }));
    if (evidence.length === 0) return { user, reason, outcome: "skipped_not_visible", copy: null };
    const recent = await prisma.securityIncidentNotice.count({
      where: { userId: user.id, outcome: { in: [...COUNTED] }, createdAt: { gte: hourAgo } },
    });
    if (recent >= SECURITY_ALERT_HOURLY_CAP) return { user, reason, outcome: "skipped_capped", copy: null };
    return { user, reason, outcome: "queued", copy: alertCopy({ zoneName: incident.zoneName ?? "", evidence, tz }) };
  };

  const out: PlannedNotice[] = [];
  for (const { user } of routed) {
    const mine = existing.find((n) => n.userId === user.id);
    if (!mine) {
      if (!replan) out.push(await plan(user, "routed", await eligibilityOf(user, deps.resolveAccess)));
      continue;
    }
    if (mine.outcome !== "skipped_not_visible") continue;
    const again = await plan(user, mine.reason, await eligibilityOf(user, deps.resolveAccess));
    if (again.outcome === "queued" || again.outcome === "skipped_capped") out.push({ ...again, replaces: mine.id });
  }
  if (reachedBefore === 0 && !out.some((o) => REACHED.includes(o.outcome))) {
    const owners = await prisma.user.findMany({ where: { role: "owner" }, select: USER_SELECT, orderBy: { id: "asc" } });
    for (const owner of owners) {
      if (already.has(owner.id) || out.some((o) => o.user.id === owner.id)) continue;
      const eligibility = await eligibilityOf(owner, deps.resolveAccess);
      if (eligibility.eligible) out.push(await plan(owner, "fallback_owner", eligibility));
    }
  }
  return { planned: out, replan };
}

interface SettleableNotice {
  id: string;
  incidentId: string;
  notificationLogId: string | null;
}

/**
 * Deliver one queued notice's NotificationLog row and settle the notice from
 * the row's own stamp. `final`: a redelivery — settle `not_sent` when the row
 * still carries no stamp, so a broken stamp never loops. Never throws.
 */
async function deliverAndSettle(prisma: PrismaClient, notice: SettleableNotice, now: Date, final: boolean): Promise<void> {
  const logId = notice.notificationLogId;
  if (!logId) return;
  try {
    await deliverNotification(prisma, logId, { tag: incidentTag(notice.incidentId), priority: "alert" });
  } catch (err) {
    logger.warn({ err, noticeId: notice.id }, "security alert delivery threw — the notice stays queued for redelivery");
  }
  try {
    const row = await prisma.notificationLog.findUnique({
      where: { id: logId },
      select: { channels: true, pushOutcome: true, deliveredAt: true, error: true },
    });
    let data: Prisma.SecurityIncidentNoticeUpdateManyMutationInput;
    if (row?.deliveredAt) {
      data = { outcome: "sent", channels: row.channels.slice(0, 32), pushOutcome: row.pushOutcome, settledAt: now };
    } else if (row?.error === DELIVERY_CLAIMED) {
      // Claimed, never stamped: it may have gone out. It cannot be sent again.
      data = { outcome: "outcome_unknown", channels: "", pushOutcome: null, settledAt: now };
    } else if (row && (row.pushOutcome !== null || row.error !== null)) {
      data = { outcome: "not_sent", channels: row.channels.slice(0, 32), pushOutcome: row.pushOutcome, settledAt: now };
    } else if (final || row === null) {
      // Never claimed (or gone): nothing was sent. Settled, so it never loops.
      data = { outcome: "not_sent", channels: "", pushOutcome: null, settledAt: now };
    } else {
      return;
    }
    await prisma.securityIncidentNotice.updateMany({ where: { id: notice.id, outcome: "queued" }, data });
  } catch (err) {
    logger.warn({ err, noticeId: notice.id }, "security alert notice could not be settled — it stays queued");
  }
}

/** The audit `what` for an incident's alert. */
function alertedWhat(i: { scope: string; zoneName: string | null }): string {
  const place = i.scope === "area" && i.zoneName && chainSafeText(i.zoneName) ? stripUnsafeDisplayChars(i.zoneName) : null;
  return place ? `Security: sent an alert about ${place}` : "Security: sent an alert";
}

/** One incident, steps 1–6. True when its notices were written. Throws only from the after-commit audit. */
async function notifyIncident(
  prisma: PrismaClient,
  deps: NotifierDeps,
  incidentId: string,
  now: Date,
  opts: NotifyOptions,
): Promise<boolean> {
  const incident = await prisma.securityIncident.findUnique({ where: { id: incidentId }, select: INCIDENT_SELECT });
  if (!incident || incident.notifyState !== "pending") return false;
  let written: Array<{ id: string; userId: string; outcome: SecurityNoticeOutcome; reason: SecurityNoticeReason; notificationLogId: string | null }> | null;
  // False only for a re-plan that moved nobody: the incident goes back to done, and nothing is audited.
  let changed = true;
  try {
    if (!(await deps.isSecurityModuleOn())) {
      await prisma.securityIncident.updateMany({
        where: { id: incident.id, notifyState: "pending" },
        data: { notifyState: "module_off", version: { increment: 1 } },
      });
      return false;
    }
    const { planned, replan } = await planNotices(prisma, deps, incident, now);
    changed = planned.length > 0 || !replan;
    written = await prisma.$transaction(async (tx) => {
      const { count } = await tx.securityIncident.updateMany({
        where: { id: incident.id, version: incident.version, notifyState: "pending" },
        data: { notifyState: "done", version: { increment: 1 } },
      });
      if (count !== 1) return null;
      const rows: Prisma.SecurityIncidentNoticeCreateManyInput[] = [];
      for (const recipient of planned) {
        let notificationLogId: string | null = null;
        if (recipient.outcome === "queued" && recipient.copy) {
          const { id } = await recordNotification(tx, {
            username: recipient.user.username,
            kind: "event",
            title: recipient.copy.title,
            body: recipient.copy.body,
            url: `/security/incidents/${incident.id}`,
            data: { incidentId: incident.id },
          });
          notificationLogId = id;
        }
        if (recipient.replaces) {
          // Review R4: the skipped notice becomes this outcome, dated now (the cap and redelivery read createdAt).
          const { count: moved } = await tx.securityIncidentNotice.updateMany({
            where: { id: recipient.replaces, incidentId: incident.id, outcome: "skipped_not_visible" },
            data: { outcome: recipient.outcome, notificationLogId, createdAt: now, settledAt: recipient.outcome === "queued" ? null : now },
          });
          if (moved !== 1) throw new Error("security notice changed while it was re-planned");
          continue;
        }
        rows.push({
          incidentId: incident.id,
          userId: recipient.user.id,
          username: recipient.user.username.slice(0, 120),
          reason: recipient.reason,
          outcome: recipient.outcome,
          notificationLogId,
          // One clock (review #12): created and settled on the tick's clock,
          // the one the hourly cap and redelivery read — never the database's.
          createdAt: now,
          settledAt: recipient.outcome === "queued" ? null : now,
        });
      }
      if (rows.length > 0) await tx.securityIncidentNotice.createMany({ data: rows });
      return tx.securityIncidentNotice.findMany({
        where: { incidentId: incident.id },
        select: { id: true, userId: true, outcome: true, reason: true, notificationLogId: true },
      });
    }, READ_COMMITTED_TX);
  } catch (err) {
    const attempts = incident.notifyAttempts + 1;
    logger.error({ err, incidentId: incident.id, attempts }, "security alert could not be written");
    await prisma.securityIncident.updateMany({
      where: { id: incident.id, notifyState: "pending" },
      data: {
        notifyAttempts: { increment: 1 },
        version: { increment: 1 },
        ...(attempts >= SECURITY_NOTIFY_MAX_ATTEMPTS ? { notifyState: "failed" as const } : {}),
      },
    });
    return false;
  }
  if (!written || !changed) return false;

  for (const n of written) {
    if (n.outcome !== "queued") continue;
    // Past the deadline: left queued — redelivery gives it its first delivery.
    if (opts.deadline?.()) continue;
    await deliverAndSettle(prisma, { id: n.id, incidentId: incident.id, notificationLogId: n.notificationLogId }, now, false);
  }
  const settled = await prisma.securityIncidentNotice.findMany({
    where: { incidentId: incident.id },
    select: { userId: true, outcome: true, reason: true },
    orderBy: { userId: "asc" },
  });
  await auditSecuritySystem({
    action: "incident.alerted",
    what: alertedWhat(incident),
    refs: { incidentId: incident.id, notices: settled.map((n) => ({ userId: n.userId, outcome: n.outcome, reason: n.reason })) },
  });
  return true;
}

/**
 * Engine step 6: every pending alert, oldest first. An incident whose write
 * fails is counted as an attempt and does not stop the others. The first
 * failed after-commit audit comes back as `auditError` for the engine to
 * rethrow at the END of its tick (review #8).
 */
export async function notifyPendingIncidents(
  prisma: PrismaClient,
  deps: NotifierDeps,
  now: Date,
  opts: NotifyOptions = {},
): Promise<{ incidents: number; auditError?: unknown }> {
  const pending = await prisma.securityIncident.findMany({
    where: { notifyState: "pending" },
    orderBy: [{ alertedAt: "asc" }, { id: "asc" }],
    take: NOTIFY_BATCH,
    select: { id: true },
  });
  let incidents = 0;
  let firstError: unknown = null;
  for (const { id } of pending) {
    if (opts.deadline?.()) break;
    try {
      if (await notifyIncident(prisma, deps, id, now, opts)) incidents++;
    } catch (err) {
      // notifyIncident throws only from the after-commit audit: its notices were written.
      incidents++;
      logger.error({ err, incidentId: id }, "security alert sent, but its audit row was not written");
      firstError ??= err;
    }
  }
  return firstError ? { incidents, auditError: firstError } : { incidents };
}

/** Engine step 6, second half: notices still queued two minutes on get one more delivery, then settle. */
export async function redeliverStuckNotices(prisma: PrismaClient, now: Date, opts: NotifyOptions = {}): Promise<{ redelivered: number }> {
  const stuck = await prisma.securityIncidentNotice.findMany({
    where: { outcome: "queued", createdAt: { lte: new Date(now.getTime() - SECURITY_REDELIVER_AFTER_MS) } },
    orderBy: { createdAt: "asc" },
    take: REDELIVER_BATCH,
    select: { id: true, incidentId: true, notificationLogId: true },
  });
  let redelivered = 0;
  for (const n of stuck) {
    if (opts.deadline?.()) break;
    await deliverAndSettle(prisma, n, now, true);
    redelivered++;
  }
  return { redelivered };
}

// ── the alerts health row (§6.11) ─────────────────────────────────────────

/** Hours set AND at least one active Inside / Staff only area with an active link — what after-hours alerts need. */
export async function alertsReady(prisma: Pick<PrismaClient, "securitySiteHours" | "securityZone">): Promise<boolean> {
  const hours = await prisma.securitySiteHours.findUnique({ where: { id: SINGLETON }, select: { state: true } });
  if (hours?.state !== "set") return false;
  const areas = await prisma.securityZone.count({
    where: { state: "active", kind: { in: ["interior", "restricted"] }, links: { some: { state: "active" } } },
  });
  return areas > 0;
}

/**
 * The eligible people who are told: every `receiving` row, plus the owners
 * with no row yet (theirs is created lazily as `receiving` — read-only here,
 * so a health read never writes).
 */
async function eligibleReceivers(prisma: PrismaClient, resolve: EffectiveAccessResolver): Promise<RecipientUser[]> {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { securityAlertRecipient: { is: { state: "receiving" } } },
        { role: "owner", securityAlertRecipient: { is: null } },
      ],
    },
    select: USER_SELECT,
  });
  const out: RecipientUser[] = [];
  for (const user of users) if ((await eligibilityOf(user, resolve)).eligible) out.push(user);
  return out;
}

/**
 * The cameras an after-hours alert can come from (an ACTIVE link of an active
 * Inside / Staff only area) that no eligible receiver can see — alerts about
 * them reach the owners only through the fallback (review #2).
 */
async function uncoveredAlertCameras(prisma: PrismaClient, receivers: readonly RecipientUser[]): Promise<string[]> {
  const links = await prisma.securityZoneLink.findMany({
    where: { state: "active", zone: { state: "active", kind: { in: ["interior", "restricted"] } } },
    select: { sourceKind: true, sourceRef: true },
  });
  const cameras = new Set<string>();
  for (const l of links) {
    const parsed = parseLinkRef(l.sourceKind, l.sourceRef);
    // A door lock (WARP-2977 P2b-2) is no camera: lock rows feed no rule (D21).
    if (parsed && !isLockLinkRef(parsed)) cameras.add(parsed.camera);
  }
  if (cameras.size === 0) return [];
  const covered = new Set<string>();
  for (const r of receivers) {
    const visible = await visibleCameraNames(prisma, { id: r.id, role: r.role });
    if (visible === "all") return [];
    for (const c of visible) covered.add(c);
  }
  return [...cameras].filter((c) => !covered.has(c)).sort();
}

/**
 * The `alerts` row — owner/admin only (it names who is told):
 *   · not_configured — no opening hours, or no Inside / Staff only area with a link;
 *   · down — an alert failed in the last day; or nobody set to be told is
 *     eligible; or an Inside / Staff only camera none of them can see (the
 *     owner fallback is what reaches anyone about it);
 *   · quiet — an eligible receiver has no phone set up (or phone notifications
 *     are off on this box): they hear only while Droplet is open;
 *   · ok — who alerts go to.
 */
export async function computeAlertsHealthRow(
  prisma: PrismaClient,
  resolve: EffectiveAccessResolver,
  now: Date,
): Promise<SecurityHealthRow> {
  const row = (state: SecurityHealthRow["state"], detail: string): SecurityHealthRow => ({ id: "alerts", state, detail, lastSeenAt: null });
  if (!(await alertsReady(prisma))) {
    return row("not_configured", "After-hours alerts need opening hours and an area marked Inside or Staff only");
  }
  const failed = await prisma.securityIncident.count({ where: { notifyState: "failed", alertedAt: { gte: new Date(now.getTime() - DAY_MS) } } });
  if (failed > 0) return row("down", "An alert couldn't be sent");
  const receivers = await eligibleReceivers(prisma, resolve);
  if (receivers.length === 0) return row("down", "Nobody set to be told can open Security, so the owner is told instead");
  const uncovered = await uncoveredAlertCameras(prisma, receivers);
  if (uncovered.length > 0) {
    const labels = new Map(
      (await prisma.camera.findMany({ where: { name: { in: uncovered } }, select: { name: true, displayName: true } })).map((c) => [
        c.name,
        stripUnsafeDisplayChars(c.displayName).trim() || c.name,
      ]),
    );
    return row(
      "down",
      `Nobody set to be told can see ${listNames(uncovered.map((c) => labels.get(c) ?? c))}, so the owner is told about ${uncovered.length === 1 ? "it" : "them"} instead`,
    );
  }
  const names = (us: readonly RecipientUser[]) => us.map(displayName).sort((a, b) => a.localeCompare(b));
  if (!(await webPushGate(prisma))) {
    return row("quiet", `Alerts reach ${listNames(names(receivers))} only while Droplet is open (phone notifications are turned off on this box)`);
  }
  const subscribed = new Set(
    (
      await prisma.pushSubscription.findMany({ where: { username: { in: receivers.map((r) => r.username) } }, select: { username: true } })
    ).map((s) => s.username),
  );
  const inApp = receivers.filter((r) => !subscribed.has(r.username));
  if (inApp.length > 0) {
    return row("quiet", `Alerts reach ${listNames(names(inApp))} only while Droplet is open (no phone is set up for notifications)`);
  }
  return row("ok", `Alerts go to ${listNames(names(receivers))}`);
}

/** How long a computed row is reused by the /security/health handler. */
const ALERTS_HEALTH_FRESH_MS = 90_000;
let alertsHealth: { row: SecurityHealthRow; at: Date } | null = null;

/** Test seam. */
export function _resetAlertsHealthForTests(): void {
  alertsHealth = null;
}

/** Engine step 7 (every 6th tick) and after each routing PUT. Never throws. */
export async function recomputeAlertsHealth(prisma: PrismaClient, resolve: EffectiveAccessResolver | undefined, now: Date): Promise<void> {
  if (!resolve) return;
  try {
    alertsHealth = { row: await computeAlertsHealthRow(prisma, resolve, now), at: now };
  } catch (err) {
    logger.warn({ err }, "alerts health could not be computed");
    alertsHealth = { row: { id: "alerts", state: "down", detail: "Can't check who alerts reach right now", lastSeenAt: null }, at: now };
  }
}

/** The `alerts` row the /security/health handler shows (owner/admin only). Reuses a fresh one; never throws. */
export async function securityAlertsHealth(
  prisma: PrismaClient,
  resolve: EffectiveAccessResolver | undefined,
  now: Date,
): Promise<SecurityHealthRow> {
  if (!alertsHealth || now.getTime() - alertsHealth.at.getTime() > ALERTS_HEALTH_FRESH_MS) {
    await recomputeAlertsHealth(prisma, resolve ?? resolveEffectiveAccess, now);
  }
  return alertsHealth!.row;
}

// ── routing reads and writes (§7 routes 21–22) ────────────────────────────

export interface RoutingPerson {
  userId: string;
  name: string;
  role: Role;
  state: "receiving" | "not_receiving";
  origin: "owner_default" | "chosen" | null;
  version: number | null;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
  /** A manager of a department made from the Security template — a suggestion only (D26). */
  managesSecurityDepartment: boolean;
  delivery: "push" | "in_app_only";
}

export type RoutingView =
  | { level: "manage"; people: RoutingPerson[]; fallbackActive: boolean }
  | { level: "view" | "act"; self: { state: "receiving" | "not_receiving"; eligible: boolean } };

async function peopleOf(prisma: PrismaClient, resolve: EffectiveAccessResolver, ids?: readonly string[]): Promise<RoutingPerson[]> {
  const users = await prisma.user.findMany({
    where: ids ? { id: { in: [...ids] } } : { OR: [{ role: { in: [...HOUSEHOLD_ROLES] } }, { securityAlertRecipient: { isNot: null } }] },
    select: { ...USER_SELECT, securityAlertRecipient: { select: { state: true, origin: true, version: true } } },
  });
  const managers = new Set(
    (
      await prisma.departmentMembership.findMany({
        where: { right: "manager", department: { is: { archivedAt: null, profile: { is: { template: "security" } } } } },
        select: { userId: true },
      })
    ).map((m) => m.userId),
  );
  const gate = await webPushGate(prisma);
  const subscribed = gate
    ? new Set(
        (await prisma.pushSubscription.findMany({ where: { username: { in: users.map((u) => u.username) } }, select: { username: true } })).map(
          (s) => s.username,
        ),
      )
    : new Set<string>();
  const out: RoutingPerson[] = [];
  for (const u of users) {
    const e = await eligibilityOf(u, resolve);
    const row = u.securityAlertRecipient;
    out.push({
      userId: u.id,
      name: displayName(u),
      role: u.role,
      state: row?.state ?? "not_receiving",
      origin: row?.origin ?? null,
      version: row?.version ?? null,
      eligible: e.eligible,
      ineligibleReason: e.reason,
      managesSecurityDepartment: managers.has(u.id),
      delivery: subscribed.has(u.username) ? "push" : "in_app_only",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.userId < b.userId ? -1 : 1));
}

/**
 * Route 21. `level` is the viewer's resolved Security level (the route passes
 * `manage` also for an owner/admin with nothing to resolve — P2b's
 * `mayListArchivedZones` rule). Below manage it is a filter, not a gate: the
 * viewer's own line only.
 */
export async function readAlertRouting(
  prisma: PrismaClient,
  resolve: EffectiveAccessResolver,
  viewer: { id: string; role: string },
  level: FeatureLevel,
): Promise<RoutingView> {
  await ensureOwnerRecipients(prisma);
  if (level === "manage") {
    const people = await peopleOf(prisma, resolve);
    return { level, people, fallbackActive: !people.some((p) => p.state === "receiving" && p.eligible) };
  }
  const me = await prisma.user.findUnique({
    where: { id: viewer.id },
    select: { ...USER_SELECT, securityAlertRecipient: { select: { state: true } } },
  });
  return {
    level,
    self: { state: me?.securityAlertRecipient?.state ?? "not_receiving", eligible: me ? (await eligibilityOf(me, resolve)).eligible : false },
  };
}

export type SetRoutingResult =
  | { status: "ok"; person: RoutingPerson }
  | { status: "not_found" }
  | { status: "not_eligible"; reason: IneligibleReason }
  | { status: "version_conflict" }
  | { status: "no_recipient" };

class RoutingRollback extends Error {
  constructor(readonly result: "version_conflict" | "no_recipient") {
    super(result);
  }
}

/**
 * Route 22 (manage), ONE READ COMMITTED transaction:
 *   1. the routing advisory lock (two saves never both remove the last receiver);
 *   2. CAS on the row's version — or, with `expectedVersion: null`, insert it
 *      (a row that already exists is a version conflict);
 *   3. count the eligible receiving rows (the resolver reads on its own
 *      connections): none, when the change took away an eligible receiver →
 *      roll back, `no_recipient`;
 *   4. the audit, last.
 * `receiving` for an ineligible person is refused before the transaction;
 * `not_receiving` for an ineligible person is always allowed (clean-up) —
 * even when nobody eligible is left receiving (review B).
 */
export async function setAlertRouting(
  prisma: PrismaClient,
  resolve: EffectiveAccessResolver,
  req: { user?: { id: string; role?: string } | undefined },
  input: { userId: string; state: "receiving" | "not_receiving"; expectedVersion: number | null },
  now: Date,
): Promise<SetRoutingResult> {
  const target = await prisma.user.findUnique({ where: { id: input.userId }, select: USER_SELECT });
  if (!target) return { status: "not_found" };
  const eligibility = await eligibilityOf(target, resolve);
  if (input.state === "receiving" && !eligibility.eligible) return { status: "not_eligible", reason: eligibility.reason ?? "no_access" };
  await ensureOwnerRecipients(prisma);
  const setById = req.user?.id ?? null;
  // Chain-safe (no controls, bidi or lone surrogates): it is signed into the audit row.
  const name = summaryName(target.displayName || target.username);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT (pg_advisory_xact_lock(hashtext(${SECURITY_ALERT_ROUTING_LOCK_KEY}::text)) IS NULL) AS locked`;
      const data = { state: input.state, origin: "chosen" as const, setById, setAt: now };
      if (input.expectedVersion === null) {
        const { count } = await tx.securityAlertRecipient.createMany({ data: [{ userId: target.id, ...data }], skipDuplicates: true });
        if (count !== 1) throw new RoutingRollback("version_conflict");
      } else {
        const { count } = await tx.securityAlertRecipient.updateMany({
          where: { userId: target.id, version: input.expectedVersion },
          data: { ...data, version: { increment: 1 } },
        });
        if (count !== 1) throw new RoutingRollback("version_conflict");
      }
      const receiving = await tx.securityAlertRecipient.findMany({ where: { state: "receiving" }, select: { user: { select: USER_SELECT } } });
      let eligibleCount = 0;
      for (const { user } of receiving) {
        if (user.id === target.id ? eligibility.eligible : (await eligibilityOf(user, resolve)).eligible) eligibleCount++;
      }
      // Only a change that takes away an ELIGIBLE receiver can leave nobody to
      // tell. Switching off someone who cannot be told anyway (review B) is
      // always allowed — the clean-up the settings page needs.
      if (eligibleCount === 0 && eligibility.eligible) throw new RoutingRollback("no_recipient");
      // LAST: nothing may follow the audit in this callback.
      await auditSecurityInTx(tx, req, {
        action: "alert_routing.set",
        what: input.state === "receiving" ? `Security: ${name} is told about alerts` : `Security: ${name} is no longer told about alerts`,
        refs: { userId: target.id, state: input.state, eligibleReceivers: eligibleCount },
      });
    }, READ_COMMITTED_TX);
  } catch (err) {
    if (err instanceof RoutingRollback) return { status: err.result };
    throw err;
  }
  await recomputeAlertsHealth(prisma, resolve, now);
  const [person] = await peopleOf(prisma, resolve, [target.id]);
  return { status: "ok", person: person! };
}
