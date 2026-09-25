/**
 * WARP-2978 (ADR-059 P3 spec §6.6, §A.8; D7, D22, D23) — a person
 * acknowledges or resolves an incident, with a record that can be proven:
 * who (the authenticated person), when (the box's clock), which sign-in (the
 * sign-in's id from the signed token, and whether the live-session check ran
 * on that request), what the device SAID it was (reported, labelled as such),
 * and the alert notification it came from (stored only when verified).
 *
 * The table (§6.6), judged on the VIEWER's projection (DS-005: a viewer whose
 * visible codes are empty sees plain activity and can act on nothing; a
 * PARTIAL viewer — a reason at the incident's top severity is on a camera
 * they cannot see, `projectIncident` — acts on nothing either, because both
 * actions settle the whole incident for everyone):
 *
 *   from \ action  | acknowledge                                   | resolve
 *   no visible code| 409 NOT_ACTIONABLE                            | 409 NOT_ACTIONABLE
 *   or partial     |                                               |
 *   open           | → acknowledged, ack row                        | → resolved + sealed, ack row
 *   acknowledged   | this person has no row yet → ack row (state    | → resolved + sealed, ack row
 *                  | unchanged, D23: every person's first ack is    |
 *                  | recorded); else changed:false                  |
 *   resolved       | changed:false                                  | changed:false
 *
 * Each write is ONE READ COMMITTED transaction:
 *   1. CAS on SecurityIncident.version (every recorded ack bumps it, which
 *      also serialises two acks by the same person); a lost race re-reads and
 *      re-plans once, then 409 INCIDENT_CONFLICT;
 *   2. the ack row;
 *   3. the actor's OWN NotificationLog rows for this incident →
 *      `ackMethod: 'incident'` — keyed on the actor's username, never another
 *      recipient's rows (D7: a notification ack is its recipient's statement);
 *   4. `auditSecurityInTx`, LAST — nothing follows it in the callback.
 * A notification ack never acknowledges an incident (that is the other
 * direction, and it needs act level).
 *
 * A resolve made before the notifier reached a pending alert also settles
 * the alert: `notifyState` pending → done, with no notices (review #9) — a
 * person has already handled it, so nobody is woken for it. An acknowledge
 * leaves it pending: someone is on it, and the others are still told.
 *
 * WARP-2980 (ADR-059 P5 PR-B, brief §4.4, spec D15) — a VERDICT: Expected /
 * Not expected, by owner/admin at act level (route 35; review item 2). It
 * feeds precision and nothing else: it never touches state, severity, codes
 * or notifications, so an alert that joins later still notifies.
 *
 *   judged on the viewer's projection plus their visible flags:
 *     partial, or nothing to judge           → 409 NOT_JUDGEABLE (one body)
 *     the same verdict AND the same codes    → changed:false, no audit
 *     otherwise (any state, collecting too)  → stamped: who, when, the
 *                                              first mark (never moves), and
 *                                              `verdictCodes` = what they
 *                                              could judge — codes that
 *                                              joined since are picked up
 *   It can change (expected ↔ not_expected), never go back to unreviewed.
 *   One READ COMMITTED transaction: CAS on version (one re-read and re-plan
 *   on a lost race, then 409 INCIDENT_CONFLICT), `auditSecurityInTx` LAST.
 */
import type { PrismaClient, SecurityIncidentAckAction, SecurityIncidentState } from "@prisma/client";
import { auditSecurityInTx, stripUnsafeDisplayChars } from "./security-audit.js";
import { summaryName } from "./security-mode.service.js";
import {
  FLAG_VIEW_SELECT,
  INCIDENT_VIEW_SELECT,
  REASON_VIEW_SELECT,
  VERDICT_SELECT,
  judgeableCodes,
  projectIncident,
  type IncidentViewer,
} from "./security-incident-view.js";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-incident-actions");

/** The person acting, and what their request can say about the device. */
export interface IncidentActor {
  id: string;
  username: string;
  role: string;
  displayName: string;
  /** The sign-in's id from the signed token (JWT `sid`); null when the token carried none. */
  sessionId: string | null;
  /** Whether authMiddleware's live-session check ran on this request (only meaningful with a sessionId). */
  sessionChecked: boolean;
  /** `describeClient(...)` — reported, never proof. */
  client: string | null;
}

export interface IncidentActionInput {
  incidentId: string;
  action: SecurityIncidentAckAction;
  actor: IncidentActor;
  viewer: IncidentViewer;
  /** The NotificationLog id the page was opened from (`?n=`), when any. Stored only when verified. */
  notificationId?: string | null;
  /** Resolve only; already checked with `chainSafeText` by the route. */
  note?: string;
  now: Date;
}

export type IncidentActionResult =
  | { status: "ok"; changed: boolean }
  | { status: "not_found" }
  | { status: "not_actionable" }
  | { status: "conflict" };

type Plan =
  | { kind: "noop" }
  | {
      kind: "write";
      state: SecurityIncidentState;
      patch: Record<string, unknown>;
    };

const HOUSE_WORDS: Readonly<Record<string, string>> = { alert: "an alert", notice: "a notice", info: "an incident" };

/** `in Stock room` / `on camera back` / `about network and sign-in warnings` / `about the camera system`. */
function placeOf(i: { scope: string; zoneName: string | null; scopeCamera: string | null }): string {
  if (i.scope === "area" && i.zoneName) {
    const name = stripUnsafeDisplayChars(i.zoneName).trim();
    return name ? `in ${name}` : "in an area";
  }
  if (i.scope === "camera" && i.scopeCamera) return `on camera ${i.scopeCamera}`;
  if (i.scope === "site_threat") return "about network and sign-in warnings";
  return "about the camera system";
}

/** Acknowledge or resolve (spec §6.6). */
export async function actOnIncident(prisma: PrismaClient, input: IncidentActionInput): Promise<IncidentActionResult> {
  const { actor, now } = input;
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await prisma.securityIncident.findUnique({
      where: { id: input.incidentId },
      select: { ...INCIDENT_VIEW_SELECT, version: true, notifyState: true },
    });
    if (!row) return { status: "not_found" };
    const reasons = await prisma.securityIncidentReason.findMany({ where: { incidentId: row.id }, select: REASON_VIEW_SELECT });
    const view = projectIncident(row, reasons, input.viewer, now);
    if (!view) return { status: "not_found" };
    if (!view.actionable) return { status: "not_actionable" };

    const mine = await prisma.securityIncidentAck.count({ where: { incidentId: row.id, byUserId: actor.id } });
    let plan: Plan;
    if (row.state === "resolved") plan = { kind: "noop" };
    else if (input.action === "resolve") {
      plan = {
        kind: "write",
        state: "resolved",
        patch: {
          state: "resolved",
          stateChangedAt: now,
          stateChangedById: actor.id,
          resolvedAt: now,
          resolvedById: actor.id,
          ...(row.grouping === "collecting" ? { grouping: "closed", closedAt: now } : {}),
          ...(row.notifyState === "pending" ? { notifyState: "done" } : {}),
        },
      };
    } else if (row.state === "open") {
      plan = { kind: "write", state: "acknowledged", patch: { state: "acknowledged", stateChangedAt: now, stateChangedById: actor.id } };
    } else if (row.state === "acknowledged" && mine === 0) {
      // D23: every person's first acknowledgement is recorded; the state stays.
      plan = { kind: "write", state: "acknowledged", patch: {} };
    } else plan = { kind: "noop" };
    if (plan.kind === "noop") return { status: "ok", changed: false };

    // The actor's own alert notices for THIS incident: the notification they may
    // have come from, and the NotificationLog rows their acknowledgement covers.
    const ownNotices = await prisma.securityIncidentNotice.findMany({
      where: { incidentId: row.id, userId: actor.id, notificationLogId: { not: null } },
      select: { notificationLogId: true },
    });
    const ownLogIds = ownNotices.map((n) => n.notificationLogId).filter((x): x is string => x !== null);
    const via = input.notificationId && ownLogIds.includes(input.notificationId) ? input.notificationId : null;
    if (input.notificationId && !via) {
      logger.info({ incidentId: row.id, userId: actor.id }, "incident ack named a notification that is not this person's alert for it — not stored");
    }
    const byName = summaryName(actor.displayName || actor.username);
    const write = plan;

    const done = await prisma.$transaction(async (tx) => {
      const { count } = await tx.securityIncident.updateMany({
        where: { id: row.id, version: row.version },
        data: { ...write.patch, version: { increment: 1 } },
      });
      if (count !== 1) return false;
      const ack = await tx.securityIncidentAck.create({
        data: {
          incidentId: row.id,
          action: input.action,
          byUserId: actor.id,
          byName,
          at: now,
          sessionId: actor.sessionId,
          sessionChecked: actor.sessionId !== null && actor.sessionChecked,
          client: actor.client,
          viaNotificationId: via,
          note: input.action === "resolve" ? (input.note ?? "") : "",
        },
        select: { id: true },
      });
      if (ownLogIds.length > 0) {
        // Only the ACTOR's rows (D7): keyed on their username as well as the ids.
        await tx.notificationLog.updateMany({
          where: { id: { in: ownLogIds }, username: actor.username, ackState: { in: ["unacked", "untracked"] } },
          data: {
            ackState: "acked",
            ackedAt: now,
            ackMethod: "incident",
            ackSessionId: actor.sessionId,
            ackSessionChecked: actor.sessionId !== null && actor.sessionChecked,
            ackClient: actor.client,
          },
        });
      }
      // LAST: it takes the box-wide chain lock until commit; nothing may follow it here.
      await auditSecurityInTx(tx, { user: { id: actor.id, role: actor.role } }, {
        action: input.action === "resolve" ? "incident.resolve" : "incident.acknowledge",
        what: `Security: ${input.action === "resolve" ? "resolved" : "acknowledged"} ${HOUSE_WORDS[row.severity] ?? "an incident"} ${placeOf(row)}`,
        refs: {
          incidentId: row.id,
          ackId: ack.id,
          severity: row.severity,
          codes: [...row.reasonCodes],
          // Review b7e1: what the actor could SEE when they acted, beside the
          // incident-wide codes (a hidden reason below the top severity is in
          // `codes` and not here). Audit refs are read only through the
          // owner/admin activity routes, who see every camera: no DS-005 leak.
          visibleCodes: [...view.codes],
          state: write.state,
        },
      });
      return true;
    }, READ_COMMITTED_TX);
    if (done) return { status: "ok", changed: true };
  }
  return { status: "conflict" };
}

// ── WARP-2980 P5 PR-B: the verdict (route 35) ─────────────────────────────

export type IncidentVerdict = "expected" | "not_expected";

export type IncidentVerdictResult =
  | { status: "ok"; changed: boolean }
  | { status: "not_found" }
  | { status: "not_judgeable" }
  | { status: "conflict" };

const VERDICT_WORDS: Readonly<Record<IncidentVerdict, string>> = { expected: "as expected", not_expected: "as not expected" };

/** Expected / Not expected (spec D15, review item 2). See the table in this file's header. */
export async function setIncidentVerdict(
  prisma: PrismaClient,
  input: { incidentId: string; verdict: IncidentVerdict; actor: IncidentActor; viewer: IncidentViewer; now: Date },
): Promise<IncidentVerdictResult> {
  const { actor, now, viewer } = input;
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await prisma.securityIncident.findUnique({
      where: { id: input.incidentId },
      select: { ...INCIDENT_VIEW_SELECT, ...VERDICT_SELECT, version: true },
    });
    if (!row) return { status: "not_found" };
    const reasons = await prisma.securityIncidentReason.findMany({ where: { incidentId: row.id }, select: REASON_VIEW_SELECT });
    const view = projectIncident(row, reasons, viewer, now);
    if (!view) return { status: "not_found" };
    // Only a viewer the flags' role clause admits reads them; judgeableCodes applies the camera clauses.
    const flags = viewer.ownerOrAdmin ? await prisma.securityPatternFlag.findMany({ where: { incidentId: row.id }, select: FLAG_VIEW_SELECT }) : [];
    const codes = judgeableCodes(view, flags, viewer);
    if (view.partial || codes.length === 0) return { status: "not_judgeable" };
    const sameCodes = codes.length === row.verdictCodes.length && codes.every((c, n) => c === row.verdictCodes[n]);
    if (row.verdict === input.verdict && sameCodes) return { status: "ok", changed: false };

    const done = await prisma.$transaction(async (tx) => {
      const { count } = await tx.securityIncident.updateMany({
        where: { id: row.id, version: row.version },
        data: {
          verdict: input.verdict,
          verdictById: actor.id,
          verdictByName: summaryName(actor.displayName || actor.username),
          verdictAt: now,
          // The first mark never moves (the CHECK ties it to a verdict being set).
          verdictFirstAt: row.verdict === "unreviewed" ? now : row.verdictFirstAt!,
          verdictCodes: codes,
          version: { increment: 1 },
        },
      });
      if (count !== 1) return false;
      // LAST: it takes the box-wide chain lock until commit; nothing may follow it here.
      await auditSecurityInTx(tx, { user: { id: actor.id, role: actor.role } }, {
        action: "incident.verdict",
        what: `Security: marked ${HOUSE_WORDS[row.severity] ?? "an incident"} ${placeOf(row)} ${VERDICT_WORDS[input.verdict]}`,
        refs: {
          incidentId: row.id,
          verdict: input.verdict,
          from: row.verdict,
          codes: [...codes],
          incidentCodes: [...row.reasonCodes],
        },
      });
      return true;
    }, READ_COMMITTED_TX);
    if (done) return { status: "ok", changed: true };
  }
  return { status: "conflict" };
}
