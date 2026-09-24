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
 *      eligible owners when no routed person is eligible (`fallback_owner`);
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
 *   6. `incident.alerted`, audited by the system after the commit — its throw
 *      reaches safeRun's canary (after every other incident is handled).
 * A throw in 1–4 counts an attempt; the third is terminal (`failed`, and the
 * alerts health row goes down). A notice still `queued` two minutes later
 * (the process died between commit and delivery, or the stamp failed) is
 * delivered once more with the same tag — the device collapses duplicates by
 * tag — and then settled either way, so it never loops.
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
import { parseLinkRef } from "./security-zones.service.js";
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
const COUNTED: readonly SecurityNoticeOutcome[] = ["queued", "sent", "not_sent"];

/** What the engine hands the notifier. */
export interface NotifierDeps {
  isSecurityModuleOn: () => Promise<boolean>;
  resolveAccess: EffectiveAccessResolver;
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

/** The people this incident already has a notice for (User.id — an exclusion set, never a recipient). */
async function alreadyNoticed(prisma: PrismaClient, incidentId: string): Promise<Set<string>> {
  const rows = await prisma.securityIncidentNotice.findMany({ where: { incidentId }, select: { userId: true } });
  return new Set(rows.map((n) => n.userId));
}

/**
 * Notices that mean the incident reached someone: a NotificationLog row was
 * written (whatever its transport did), or the person was capped — they were
 * told about other alerts this hour and see this one in Security.
 */
const REACHED: readonly SecurityNoticeOutcome[] = ["queued", "sent", "not_sent", "skipped_capped"];

/**
 * Steps 2–3: who is told, and each one's outcome and words. Reads only (plus
 * the owners' lazy rows).
 *
 * The routed people are planned first. If NONE of them is reached (queued or
 * capped) — nobody eligible, or everyone eligible cannot see the evidence's
 * camera (review #2: eligibility is about Security, not about cameras) — the
 * eligible owners not already planned are added with `fallback_owner`, so an
 * alert never goes to nobody.
 */
async function planNotices(prisma: PrismaClient, deps: NotifierDeps, incident: NotifyIncident, now: Date): Promise<PlannedNotice[]> {
  await ensureOwnerRecipients(prisma);
  const already = await alreadyNoticed(prisma, incident.id);
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
    if (already.has(user.id)) continue;
    out.push(await plan(user, "routed", await eligibilityOf(user, deps.resolveAccess)));
  }
  if (reachedBefore === 0 && !out.some((o) => REACHED.includes(o.outcome))) {
    const owners = await prisma.user.findMany({ where: { role: "owner" }, select: USER_SELECT, orderBy: { id: "asc" } });
    for (const owner of owners) {
      if (already.has(owner.id) || out.some((o) => o.user.id === owner.id)) continue;
      const eligibility = await eligibilityOf(owner, deps.resolveAccess);
      if (eligibility.eligible) out.push(await plan(owner, "fallback_owner", eligibility));
    }
  }
  return out;
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
      select: { channels: true, pushOutcome: true, deliveredAt: true },
    });
    const stamped = row !== null && (row.pushOutcome !== null || row.channels !== "" || row.deliveredAt !== null);
    if (!stamped && !final && row !== null) return;
    await prisma.securityIncidentNotice.updateMany({
      where: { id: notice.id, outcome: "queued" },
      data:
        stamped && row
          ? {
              outcome: row.deliveredAt ? "sent" : "not_sent",
              channels: row.channels.slice(0, 32),
              pushOutcome: row.pushOutcome,
              settledAt: now,
            }
          : { outcome: "not_sent", channels: "", pushOutcome: null, settledAt: now },
    });
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
async function notifyIncident(prisma: PrismaClient, deps: NotifierDeps, incidentId: string, now: Date): Promise<boolean> {
  const incident = await prisma.securityIncident.findUnique({ where: { id: incidentId }, select: INCIDENT_SELECT });
  if (!incident || incident.notifyState !== "pending") return false;
  let written: Array<{ id: string; userId: string; outcome: SecurityNoticeOutcome; reason: SecurityNoticeReason; notificationLogId: string | null }> | null;
  try {
    if (!(await deps.isSecurityModuleOn())) {
      await prisma.securityIncident.updateMany({
        where: { id: incident.id, notifyState: "pending" },
        data: { notifyState: "module_off", version: { increment: 1 } },
      });
      return false;
    }
    const planned = await planNotices(prisma, deps, incident, now);
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
        rows.push({
          incidentId: incident.id,
          userId: recipient.user.id,
          username: recipient.user.username.slice(0, 120),
          reason: recipient.reason,
          outcome: recipient.outcome,
          notificationLogId,
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
  if (!written) return false;

  for (const n of written) {
    if (n.outcome === "queued") await deliverAndSettle(prisma, { id: n.id, incidentId: incident.id, notificationLogId: n.notificationLogId }, now, false);
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
 * fails is counted as an attempt and does not stop the others; a failed
 * after-commit audit is rethrown once all of them are handled (safeRun's canary).
 */
export async function notifyPendingIncidents(prisma: PrismaClient, deps: NotifierDeps, now: Date): Promise<{ incidents: number }> {
  const pending = await prisma.securityIncident.findMany({
    where: { notifyState: "pending" },
    orderBy: [{ alertedAt: "asc" }, { id: "asc" }],
    take: NOTIFY_BATCH,
    select: { id: true },
  });
  let incidents = 0;
  let firstError: unknown = null;
  for (const { id } of pending) {
    try {
      if (await notifyIncident(prisma, deps, id, now)) incidents++;
    } catch (err) {
      logger.error({ err, incidentId: id }, "security alert sent, but its audit row was not written");
      firstError ??= err;
    }
  }
  if (firstError) throw firstError;
  return { incidents };
}

/** Engine step 6, second half: notices still queued two minutes on get one more delivery, then settle. */
export async function redeliverStuckNotices(prisma: PrismaClient, now: Date): Promise<{ redelivered: number }> {
  const stuck = await prisma.securityIncidentNotice.findMany({
    where: { outcome: "queued", createdAt: { lte: new Date(now.getTime() - SECURITY_REDELIVER_AFTER_MS) } },
    orderBy: { createdAt: "asc" },
    take: REDELIVER_BATCH,
    select: { id: true, incidentId: true, notificationLogId: true },
  });
  for (const n of stuck) await deliverAndSettle(prisma, n, now, true);
  return { redelivered: stuck.length };
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
    if (parsed) cameras.add(parsed.camera);
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
 *      connections): none → roll back, `no_recipient`;
 *   4. the audit, last.
 * `receiving` for an ineligible person is refused before the transaction;
 * `not_receiving` is always allowed (clean-up).
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
      if (eligibleCount === 0) throw new RoutingRollback("no_recipient");
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
