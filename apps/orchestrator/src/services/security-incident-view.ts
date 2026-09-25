/**
 * WARP-2978 (ADR-059 P3 spec §6.8, D27, D34; R6) — DS-005 for incidents: ONE
 * place. The list (route 16), the summary counts (17), the detail (18) and the
 * acknowledge/resolve routes (19–20) all ask here; a second copy of the rule is
 * how a hidden camera leaks through the one surface that forgot.
 *
 *   · VISIBLE iff: site_threat → the viewer may read threats (owner/admin);
 *     site_camera_system → any Security viewer (camera-less rows are visible
 *     in the P2a feed too); otherwise the incident's `cameras` snapshot meets
 *     the viewer's visible cameras — the snapshot, so visibility survives the
 *     30-day event trim.
 *   · the viewer's CODES are the reasons whose evidence camera they can see
 *     (a camera-less reason follows the incident's own scope rule); the
 *     viewer's SEVERITY is the max over those, info when none.
 *   · no visible code → the viewer sees PLAIN ACTIVITY: state `no_action`, no
 *     acks, no notices, nothing to act on (409 NOT_ACTIONABLE).
 *   · a PARTIAL view — visible codes, but a reason AT THE INCIDENT'S TOP
 *     SEVERITY is on a camera the viewer cannot see (the rule and why:
 *     `projectIncident`) — is not actionable either (409 NOT_ACTIONABLE, the
 *     same body): acting would acknowledge or resolve an alert she cannot
 *     see. She gets nobody else's acks, no notices and no lastAck (each would
 *     reveal the hidden reason), and the state her visible codes justify:
 *     `resolved` once a person resolved the incident, else `open` — never
 *     the stored `acknowledged`, which a hidden escalation flips back to
 *     `open` (D22) with no cause she could see.
 *   · …but a partial view keeps her OWN acknowledgements, and with them
 *     `viewer.acknowledged` (review b7e1): they show only what she did
 *     herself. Hiding them was one more thing that changed when a hidden
 *     alert escalated an incident she had acknowledged (her ack vanished).
 *     ACCEPTED RESIDUAL: that escalation still turns her view from
 *     acknowledged and actionable to `open` and not actionable. That is the
 *     refusal itself — a view that may not act has to say so, and pressing
 *     the button would get the same 409 — and the only way to hide it would
 *     be to let her seal an alert she cannot see. `actionable` stays pinned
 *     to what routes 19–20 actually do.
 *   · a non-owner/admin never sees a `skipped_not_visible` notice, not even
 *     their own: it says an alert was raised on a camera they cannot see.
 *   · times and "still happening" come from the viewer's own cameras (review
 *     #4). A person still in view holds an incident open (WARP-2978 PR-D):
 *     it is still happening for a viewer who cannot see every camera only
 *     when that person is on one she can see (`presenceHolds`).
 *   · counts and labels sum `countsByCamera` over the visible cameras (plus
 *     the site bucket `""` on a site-scope incident).
 *   · notices: owner/admin see every one; anyone else only their own (D34).
 *   · members: the P2a feed query itself (`listSecurityEvents`), with the
 *     viewer's `feedVisibilityWhere` at AND[0] and the membership ANDed after.
 *
 * The projection and the SQL builders are pure; the loaders below them read
 * and then project. The wire shapes are the ones P3 PR-C and P6 build on.
 */
import type {
  Prisma,
  PrismaClient,
  SecurityIncidentAckAction,
  SecurityIncidentEvents,
  SecurityIncidentGrouping,
  SecurityIncidentScope,
  SecurityIncidentState,
  SecurityMode,
  SecurityNoticeOutcome,
  SecurityNoticeReason,
  PushOutcome,
  SecurityReasonCode,
  SecuritySeverity,
  SecurityZoneKind,
} from "@prisma/client";
import { feedVisibilityWhere, listSecurityEvents } from "./security-events.service.js";
import { loadActiveLinks, viewerAreas, zoneChipsFor } from "./security-zones.service.js";
import { projectedIncidentPage } from "./security-incident-page.js";
import { presenceHolds, type OngoingSource } from "./security-inflight.js";
import { stripUnsafeDisplayChars } from "./security-audit.js";
import { QUIET_MS, REASON_CODE_ORDER, SETTLE_MS, parseCounts, parseSpans } from "../lib/security-rules.js";

// ── the viewer and the rows ────────────────────────────────────────────────

export interface IncidentViewer {
  userId: string;
  /** `"all"` for owner/admin; otherwise exactly the granted Frigate camera names. */
  visibleCameras: "all" | ReadonlySet<string>;
  mayReadThreats: boolean;
  /** Owner/admin: every notice. Anyone else: their own (D34). */
  ownerOrAdmin: boolean;
}

/** The incident columns the projection reads. */
export const INCIDENT_VIEW_SELECT = {
  id: true,
  scope: true,
  zoneId: true,
  zoneName: true,
  zoneKind: true,
  scopeCamera: true,
  state: true,
  severity: true,
  reasonCodes: true,
  grouping: true,
  openedInMode: true,
  firstActivityAt: true,
  lastActivityAt: true,
  eventCount: true,
  countsByCamera: true,
  cameras: true,
  spanByCamera: true,
  eventsKept: true,
} as const satisfies Prisma.SecurityIncidentSelect;

export type IncidentRowForView = Prisma.SecurityIncidentGetPayload<{ select: typeof INCIDENT_VIEW_SELECT }>;

export const REASON_VIEW_SELECT = {
  code: true,
  severity: true,
  evidenceEventId: true,
  evidenceCamera: true,
  evidenceSource: true,
  evidenceKind: true,
  evidenceLabel: true,
  evidenceAt: true,
  evidenceSummary: true,
  detail: true,
} as const satisfies Prisma.SecurityIncidentReasonSelect;

export type ReasonRowForView = Prisma.SecurityIncidentReasonGetPayload<{ select: typeof REASON_VIEW_SELECT }>;

const SEVERITY_RANK: Readonly<Record<SecuritySeverity, number>> = { info: 0, notice: 1, alert: 2 };
/** The severities a reason can carry (CHECK SecurityIncidentReason_code_severity). */
const REASON_SEVERITIES = ["alert", "notice"] as const satisfies readonly SecuritySeverity[];
const SITE_SCOPES: readonly SecurityIncidentScope[] = ["site_threat", "site_camera_system"];

const seesCamera = (v: IncidentViewer, camera: string): boolean => v.visibleCameras === "all" || v.visibleCameras.has(camera);

/** Whether this viewer may know the incident exists at all. */
export function incidentVisible(i: Pick<IncidentRowForView, "scope" | "cameras">, v: IncidentViewer): boolean {
  if (i.scope === "site_threat") return v.mayReadThreats;
  if (i.scope === "site_camera_system") return true;
  return i.cameras.some((c) => seesCamera(v, c));
}

/**
 * Whether this viewer may see one reason: its evidence camera, or the incident's own scope rule for a camera-less one.
 * A camera-less reason exists only on a site scope (CHECK SecurityIncidentReason_site_evidence; §6.2 routes its evidence
 * nowhere else), where this and the SQL twins (`visibleReasonWhere`, the list's `visReason`) agree. On area/camera this
 * says hidden and they say shown — a row that cannot exist (review 383d647e item 4).
 */
export function reasonVisible(r: Pick<ReasonRowForView, "evidenceCamera">, i: Pick<IncidentRowForView, "scope">, v: IncidentViewer): boolean {
  if (r.evidenceCamera === null) return i.scope === "site_threat" ? v.mayReadThreats : SITE_SCOPES.includes(i.scope);
  return seesCamera(v, r.evidenceCamera);
}

export interface IncidentProjection {
  incident: IncidentRowForView;
  /** Visible codes, but a reason at the incident's stored (top) severity is on a hidden camera. Never actionable. */
  partial: boolean;
  /** The viewer's visible reasons. */
  reasons: ReasonRowForView[];
  /** Max over the visible reasons; info when none. */
  severity: SecuritySeverity;
  /** The visible reasons' distinct codes, in declaration order. */
  codes: SecurityReasonCode[];
  /**
   * The stored state — `no_action` when the viewer has no visible code; for a
   * partial view, `open` until the incident is resolved (an acknowledgement
   * she cannot see must not show as `acknowledged`).
   */
  state: SecurityIncidentState;
  /** A visible code exists AND the view is not partial: the viewer may acknowledge / resolve, and sees acks and notices. */
  actionable: boolean;
  /** Visible events (from the counts snapshot, so it survives the trim). */
  eventCount: number;
  /** Visible counts per label (`_status` / `_threat` for status and threat rows, `_ongoing` for a person still in view — PR-D). */
  labels: Record<string, number>;
  /**
   * Review #4 — the event-time span and whether it is still happening, from
   * the cameras THIS viewer can see (`spanByCamera`), so activity on a hidden
   * camera never moves them; a person still in view on one of her cameras
   * keeps it happening (PR-D). A viewer who sees every camera of the incident
   * gets the stored values. `openedInMode` needs no projection: an event
   * joins only in the incident's own mode, so every member's start — hers
   * included — was in that mode.
   */
  firstActivityAt: Date;
  lastActivityAt: Date;
  grouping: SecurityIncidentGrouping;
}

/** The columns the viewer's span is projected from. */
export type IncidentSpanRow = Pick<IncidentRowForView, "scope" | "spanByCamera" | "lastActivityAt">;

/**
 * The span entries this viewer sees — or null when the STORED span is theirs:
 * they see every camera (the list keeps the stored column for them), every
 * entry of this incident, or none of its entries. A `""` entry (a camera-less
 * event) is seen only on a site-scoped incident.
 *
 * The SQL twin is `projectedIncidentPage` (security-incident-page.ts); the
 * pg lane pins the two to the same order (review R1).
 */
function shownSpans(i: IncidentSpanRow, v: IncidentViewer): Array<{ first: Date; last: Date }> | null {
  if (v.visibleCameras === "all") return null;
  const spans = Object.entries(parseSpans(i.spanByCamera));
  const shown = spans.filter(([camera]) => (camera === "" ? SITE_SCOPES.includes(i.scope) : seesCamera(v, camera)));
  if (shown.length === 0 || shown.length === spans.length) return null;
  return shown.map(([, s]) => s);
}

/**
 * The viewer's own last activity (review R1): the time their summary shows,
 * and the key route 16 orders and pages by — so activity on a camera they
 * cannot see never moves an incident in their list.
 */
export function projectedLastActivity(i: IncidentSpanRow, v: IncidentViewer): Date {
  const shown = shownSpans(i, v);
  return shown ? new Date(Math.max(...shown.map((s) => s.last.getTime()))) : i.lastActivityAt;
}

const NOBODY_IN_VIEW: ReadonlySet<string> = new Set();

/** The viewer's own span and grouping (review #4). */
function viewerSpan(
  i: IncidentRowForView,
  v: IncidentViewer,
  now: Date,
  heldBy: ReadonlySet<string>,
): { firstActivityAt: Date; lastActivityAt: Date; grouping: SecurityIncidentGrouping } {
  const shown = shownSpans(i, v);
  if (!shown) return { firstActivityAt: i.firstActivityAt, lastActivityAt: i.lastActivityAt, grouping: i.grouping };
  const first = new Date(Math.min(...shown.map((s) => s.first.getTime())));
  const last = projectedLastActivity(i, v);
  // Her cameras quiet for quiet + settle: it has stopped happening, as far as she can know…
  const quiet = now.getTime() >= last.getTime() + QUIET_MS + SETTLE_MS;
  // …unless a person she can see is still in view there (PR-D): their stay
  // holds the incident open, and their `end` row will move her times — so
  // "stopped" now would read as reopened then (D22). A person on a camera she
  // cannot see holds it for everyone else, never for her (DS-005).
  const seenStaying = [...heldBy].some((camera) => seesCamera(v, camera));
  return {
    firstActivityAt: first,
    lastActivityAt: last,
    grouping: i.grouping === "closed" || (quiet && !seenStaying) ? "closed" : "collecting",
  };
}

/**
 * §6.8 — null when the viewer may not know the incident exists. `now` decides
 * "still happening" for a partial camera view, with `heldBy`: the cameras
 * where a person still in view holds the incident open (`presenceHolds`;
 * none when omitted).
 */
export function projectIncident(
  i: IncidentRowForView,
  reasons: readonly ReasonRowForView[],
  v: IncidentViewer,
  now: Date,
  heldBy: ReadonlySet<string> = NOBODY_IN_VIEW,
): IncidentProjection | null {
  if (!incidentVisible(i, v)) return null;
  const visible = reasons.filter((r) => reasonVisible(r, i, v));
  let severity: SecuritySeverity = "info";
  for (const r of visible) if (SEVERITY_RANK[r.severity] > SEVERITY_RANK[severity]) severity = r.severity;
  const codes = REASON_CODE_ORDER.filter((c) => visible.some((r) => r.code === c));
  const counts = parseCounts(i.countsByCamera);
  const labels: Record<string, number> = {};
  let eventCount = 0;
  for (const [camera, byLabel] of Object.entries(counts)) {
    const shown = camera === "" ? SITE_SCOPES.includes(i.scope) : seesCamera(v, camera);
    if (!shown) continue;
    for (const [label, n] of Object.entries(byLabel)) {
      labels[label] = (labels[label] ?? 0) + n;
      eventCount += n;
    }
  }
  // PARTIAL (review b7e1, blocking): some reason AT THE INCIDENT'S TOP
  // SEVERITY is on evidence this viewer cannot see.
  //   · per reason, never per code: reasons are kept per (code, evidence)
  //     (@@unique([incidentId, code, evidenceEventId]), capEvidence), so an
  //     area incident on `front` and `back` carries an after_hours_presence
  //     alert for EACH camera. A front-only viewer seeing "an alert code" has
  //     not seen the alerts: the same code on `back` counts.
  //   · at every top severity, notice included: acknowledge and resolve act
  //     on the WHOLE incident, for everyone — a resolve seals it and takes it
  //     out of every owner's Needs attention — so resolving a notice-level
  //     incident from `front` would also seal a `camera_offline` notice on
  //     `back` she never saw.
  //   · a hidden reason BELOW the top severity does not: what she acts on is
  //     the incident at its top severity, and she sees all of that.
  // The stored severity is the max over the reasons (written in the same
  // transaction), so a visible severity below it (the lower-code-only view)
  // is the case where every top-severity reason is hidden. SQL twins: `full`
  // and `topHidden` in `incidentListWhere` below, and in
  // `projectedIncidentPage` (security-incident-page.ts).
  const partial = codes.length > 0 && reasons.some((r) => r.severity === i.severity && !reasonVisible(r, i, v));
  const actionable = codes.length > 0 && !partial;
  const state: SecurityIncidentState =
    codes.length === 0 ? "no_action" : partial ? (i.state === "resolved" ? "resolved" : "open") : i.state;
  return {
    incident: i,
    partial,
    reasons: visible,
    severity,
    codes,
    state,
    actionable,
    eventCount,
    labels,
    ...viewerSpan(i, v, now, heldBy),
  };
}

// ── the list's SQL (routes 16–17) ──────────────────────────────────────────

/** DS-005 in the query: which incidents the viewer may know exist. Always AND[0]. */
export function incidentVisibilityWhere(v: IncidentViewer): Prisma.SecurityIncidentWhereInput {
  if (v.visibleCameras === "all") return v.mayReadThreats ? {} : { scope: { not: "site_threat" } };
  return {
    OR: [
      { scope: { in: ["area", "camera"] }, cameras: { hasSome: [...v.visibleCameras] } },
      { scope: "site_camera_system" },
      ...(v.mayReadThreats ? [{ scope: "site_threat" as const }] : []),
    ],
  };
}

/**
 * A reason the viewer may see — on an incident the visibility clause already let through. A camera-less reason is
 * shown: it is site-wide evidence (CHECK SecurityIncidentReason_site_evidence) that §6.2 groups only into a site scope,
 * where `reasonVisible` shows it too.
 */
export function visibleReasonWhere(v: IncidentViewer): Prisma.SecurityIncidentReasonWhereInput {
  if (v.visibleCameras === "all") return {};
  return { OR: [{ evidenceCamera: { in: [...v.visibleCameras] } }, { evidenceCamera: null }] };
}

export type IncidentStateFilter = "attention" | "open" | "acknowledged" | "resolved" | "activity" | "all";

export interface IncidentListFilters {
  state: IncidentStateFilter;
  severity?: "alert" | "notice";
  zoneId?: string;
  cursor?: { at: Date; id: string };
}

/**
 * Route 16's where: visibility at AND[0]; the state and severity filters
 * count only VISIBLE codes, so "Alerts" and "Needs attention" never count a
 * hidden camera's code, and they select exactly the rows `projectIncident`
 * gives that state. `attention` is an open incident (nobody on it yet);
 * `activity` is one with no visible code. For a viewer who cannot see every
 * camera, a PARTIAL row (a reason at the stored severity on a hidden camera)
 * reads `open` while it is open or acknowledged — and is never `acknowledged`.
 */
export function incidentListWhere(v: IncidentViewer, f: IncidentListFilters): Prisma.SecurityIncidentWhereInput {
  const vis = visibleReasonWhere(v);
  const and: Prisma.SecurityIncidentWhereInput[] = [incidentVisibilityWhere(v)];
  // A viewer who sees every camera sees every reason of every incident they
  // may know: never partial, so the plain filters.
  const neverPartial = v.visibleCameras === "all";
  // `projectIncident`'s PARTIAL rule: a reason at the incident's stored (top)
  // severity whose evidence the viewer cannot see. Prisma cannot compare a
  // reason's column with its incident's, so each severity a reason can carry
  // is spelled out; `info` carries none (CHECK: info ⇔ no reason codes).
  const topHidden: Prisma.SecurityIncidentWhereInput = {
    OR: REASON_SEVERITIES.map((s) => ({ severity: s, reasons: { some: { severity: s, NOT: vis } } })),
  };
  /** Not partial: every reason at the top severity is visible. */
  const full: Prisma.SecurityIncidentWhereInput = {
    OR: [{ severity: "info" }, ...REASON_SEVERITIES.map((s) => ({ severity: s, reasons: { none: { severity: s, NOT: vis } } }))],
  };
  switch (f.state) {
    case "attention":
    case "open":
      and.push(
        neverPartial
          ? { state: "open", reasons: { some: vis } }
          : {
              reasons: { some: vis },
              OR: [
                { state: "open", ...full },
                { state: { in: ["open", "acknowledged"] }, ...topHidden },
              ],
            },
      );
      break;
    case "acknowledged":
      and.push(neverPartial ? { state: "acknowledged", reasons: { some: vis } } : { state: "acknowledged", reasons: { some: vis }, ...full });
      break;
    case "resolved":
      and.push({ state: "resolved", reasons: { some: vis } });
      break;
    case "activity":
      and.push({ OR: [{ state: "no_action" }, { reasons: { none: vis } }] });
      break;
    case "all":
      break;
  }
  if (f.severity === "alert") and.push({ reasons: { some: { AND: [vis, { severity: "alert" }] } } });
  if (f.severity === "notice") {
    and.push({
      AND: [{ reasons: { some: { AND: [vis, { severity: "notice" }] } } }, { reasons: { none: { AND: [vis, { severity: "alert" }] } } }],
    });
  }
  if (f.zoneId) and.push({ zoneId: f.zoneId });
  if (f.cursor) {
    and.push({ OR: [{ lastActivityAt: { lt: f.cursor.at } }, { lastActivityAt: f.cursor.at, id: { lt: f.cursor.id } }] });
  }
  return { AND: and };
}

const CURSOR_RE = /^(\d{1,15})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** `<the viewer's last activity, ms>.<uuid>` — the keyset position of a page's last incident (review R1). */
export function parseIncidentCursor(raw: string): { at: Date; id: string } | null {
  const m = CURSOR_RE.exec(raw);
  if (!m) return null;
  const at = new Date(Number(m[1]));
  return Number.isNaN(at.getTime()) ? null : { at, id: m[2]! };
}

// ── wire shapes (routes 16–20) — mirrored in apps/web-dashboard/src/lib/types.ts by PR-C ──

export interface IncidentAckSummary {
  action: SecurityIncidentAckAction;
  byName: string;
  at: string;
}

export interface IncidentSummary {
  id: string;
  scope: SecurityIncidentScope;
  /** The area as it was when the incident opened (the snapshot). */
  zone: { id: string; name: string; kind: SecurityZoneKind } | null;
  camera: string | null;
  /** Viewer-projected (§6.8). */
  state: SecurityIncidentState;
  /** The viewer's visible severity. */
  severity: SecuritySeverity;
  /** The viewer's visible codes. */
  reasonCodes: SecurityReasonCode[];
  grouping: SecurityIncidentGrouping;
  openedInMode: SecurityMode;
  firstActivityAt: string;
  lastActivityAt: string;
  /** Visible events. */
  eventCount: number;
  /** Visible counts per label; `_status` / `_threat` count status and threat rows, `_ongoing` a person's "still in view" row (PR-D). */
  labels: Record<string, number>;
  /** The latest acknowledgement, by anyone — only in an actionable view (never partial, never plain activity). */
  lastAck: IncidentAckSummary | null;
}

export interface IncidentReasonView {
  code: SecurityReasonCode;
  severity: SecuritySeverity;
  evidence: {
    eventId: string;
    camera: string | null;
    source: string;
    kind: string;
    label: string | null;
    at: string;
    summary: string;
  };
  /** The rule's numbers (§4): after_hours_presence {mode, modeSource, nonOpenAt, zoneKind}; camera_offline {offlineForSec, backAt}; threat_signal {activityId, kind}. */
  detail: Prisma.JsonValue;
}

export interface IncidentAckView {
  action: SecurityIncidentAckAction;
  byName: string;
  at: string;
  /** What the device SAID it was — reported, never proof. */
  client: string | null;
  /** The ack came from the person's own alert notification for this incident (verified). */
  viaNotification: boolean;
  note: string;
  /**
   * Review #11 — the sign-in behind the ack, for owner/admin ONLY (null for
   * anyone else): whether the request carried a sign-in id (the signed
   * token's `sid`) and whether authMiddleware confirmed that sign-in live.
   * The id itself is never returned — not even truncated: nothing an owner
   * can see names a sign-in by it (GET /auth/sessions deliberately omits
   * sids), so a prefix would identify a session without matching anything.
   */
  signIn: { recorded: boolean; confirmedLive: boolean } | null;
}

export interface IncidentNoticeView {
  userId: string;
  name: string;
  outcome: SecurityNoticeOutcome;
  reason: SecurityNoticeReason;
  channels: string;
  pushOutcome: PushOutcome | null;
  createdAt: string;
  settledAt: string | null;
}

/**
 * A member as the feed shows it (route 1's row shape): the event, its
 * `zones` — the viewer's VISIBLE areas, from the feed's own resolver
 * (`zoneChipsFor`, review A) — and `alsoIn`. Route 1's `incident` field is
 * left out: every member here belongs to this incident.
 */
export type IncidentMemberView = Awaited<ReturnType<typeof listSecurityEvents>>["events"][number] & {
  zones: Array<{ id: string; name: string }>;
  /** The other visible areas the event also matched at triage. */
  alsoIn: Array<{ id: string; name: string }>;
};

export interface IncidentDetail extends IncidentSummary {
  /**
   * Whether this viewer can act on the incident right now — exactly when a
   * resolve from them would change it (routes 19–20): their Security level is
   * at least act (the level the act gate checks), the view is not partial and
   * has a visible code (else 409 NOT_ACTIONABLE), and the incident is open or
   * acknowledged (a resolved one answers both actions with 200 changed:false).
   * Acknowledge follows it except once this viewer has acknowledged
   * (`viewer.acknowledged`) an actionable incident: then acknowledge is a 200
   * changed:false no-op. A partial view may carry `viewer.acknowledged`
   * (her own earlier ack) and is still not actionable: both actions are 409.
   */
  actionable: boolean;
  reasons: IncidentReasonView[];
  /** Visible members while their events are kept, newest first (the feed row shape). */
  events: IncidentMemberView[];
  /** More visible members than `events` carries. */
  moreEvents: boolean;
  /** Every ack when the view is actionable; a partial view, only this viewer's own; plain activity, none. */
  acks: IncidentAckView[];
  notices: IncidentNoticeView[];
  eventsKept: SecurityIncidentEvents;
  viewer: { level: "view" | "act" | "manage"; acknowledged: boolean };
}

export function summaryOf(p: IncidentProjection, lastAck: { action: SecurityIncidentAckAction; byName: string; at: Date } | null): IncidentSummary {
  const i = p.incident;
  return {
    id: i.id,
    scope: i.scope,
    zone: i.zoneId && i.zoneName && i.zoneKind ? { id: i.zoneId, name: i.zoneName, kind: i.zoneKind } : null,
    camera: i.scopeCamera,
    state: p.state,
    severity: p.severity,
    reasonCodes: p.codes,
    grouping: p.grouping,
    openedInMode: i.openedInMode,
    firstActivityAt: p.firstActivityAt.toISOString(),
    lastActivityAt: p.lastActivityAt.toISOString(),
    eventCount: p.eventCount,
    labels: p.labels,
    lastAck: p.actionable && lastAck ? { action: lastAck.action, byName: lastAck.byName, at: lastAck.at.toISOString() } : null,
  };
}

// ── loaders ─────────────────────────────────────────────────────────────────

export const INCIDENT_PAGE_MAX = 100;
/** Members carried on the detail page. */
export const INCIDENT_EVENTS_MAX = 200;

type Db = PrismaClient;

async function latestAcks(prisma: Db, ids: readonly string[]): Promise<Map<string, { action: SecurityIncidentAckAction; byName: string; at: Date }>> {
  const acks = await prisma.securityIncidentAck.findMany({
    where: { incidentId: { in: [...ids] } },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    select: { incidentId: true, action: true, byName: true, at: true },
  });
  const out = new Map<string, { action: SecurityIncidentAckAction; byName: string; at: Date }>();
  for (const a of acks) if (!out.has(a.incidentId)) out.set(a.incidentId, a);
  return out;
}

/** What the loaders read "still in view" from: camera.service's in-flight map (the routes pass it; absent, nobody is). */
export type PresenceSource = Pick<OngoingSource, "inView">;

/**
 * The cameras holding each collecting incident open (PR-D) — asked only for a
 * viewer who cannot see every camera: anyone else gets the stored grouping,
 * which the engine's hold already keeps `collecting`.
 */
async function holdsFor(
  prisma: Db,
  rows: ReadonlyArray<Pick<IncidentRowForView, "id" | "grouping" | "firstActivityAt">>,
  v: IncidentViewer,
  presence: PresenceSource | undefined,
  now: Date,
): Promise<Map<string, Set<string>>> {
  if (v.visibleCameras === "all") return new Map();
  return presenceHolds(prisma, rows.filter((r) => r.grouping === "collecting"), presence, now);
}

/** Project a page of incidents with one reasons query and one acks query. Hidden rows (never expected after the SQL) are dropped. */
async function summariesOf(
  prisma: Db,
  rows: readonly IncidentRowForView[],
  v: IncidentViewer,
  now: Date,
  presence: PresenceSource | undefined,
): Promise<IncidentSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const reasons = await prisma.securityIncidentReason.findMany({
    where: { incidentId: { in: ids } },
    select: { incidentId: true, ...REASON_VIEW_SELECT },
  });
  const acks = await latestAcks(prisma, ids);
  const holds = await holdsFor(prisma, rows, v, presence, now);
  const out: IncidentSummary[] = [];
  for (const row of rows) {
    const p = projectIncident(row, reasons.filter((r) => r.incidentId === row.id), v, now, holds.get(row.id));
    if (p) out.push(summaryOf(p, acks.get(row.id) ?? null));
  }
  return out;
}

/**
 * Route 16: one page, `(last activity desc, id desc)` by the VIEWER's last
 * activity — the time each summary shows (review R1). The cursor is
 * `<that time in ms>.<id>`, so a camera the viewer cannot see never reorders
 * their list or moves their page boundary.
 *
 *   · a viewer who sees every camera: their projection IS the stored column,
 *     so Prisma pages on `lastActivityAt` and its indexes;
 *   · anyone else: `projectedIncidentPage` orders in SQL by the projection
 *     over the cameras they can see, then the page's rows are read by id.
 */
export async function listIncidents(
  prisma: Db,
  v: IncidentViewer,
  f: IncidentListFilters,
  limit: number,
  now: Date,
  presence?: PresenceSource,
): Promise<{ incidents: IncidentSummary[]; nextCursor: string | null }> {
  if (v.visibleCameras === "all") {
    const rows = await prisma.securityIncident.findMany({
      where: incidentListWhere(v, f),
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: INCIDENT_VIEW_SELECT,
    });
    const page = rows.slice(0, limit);
    const tail = page[page.length - 1];
    return {
      incidents: await summariesOf(prisma, page, v, now, presence),
      nextCursor: rows.length > limit && tail ? `${tail.lastActivityAt.getTime()}.${tail.id}` : null,
    };
  }
  const keys = await projectedIncidentPage(prisma, { ...v, visibleCameras: v.visibleCameras }, f, limit + 1);
  const page = keys.slice(0, limit);
  const rows = await prisma.securityIncident.findMany({ where: { id: { in: page.map((k) => k.id) } }, select: INCIDENT_VIEW_SELECT });
  const byId = new Map(rows.map((r) => [r.id, r]));
  // A row removed between the two reads (retention) is simply absent.
  const ordered = page.map((k) => byId.get(k.id)).filter((r): r is IncidentRowForView => r !== undefined);
  const tail = page[page.length - 1];
  return {
    incidents: await summariesOf(prisma, ordered, v, now, presence),
    nextCursor: keys.length > limit && tail ? `${tail.projectedLast.getTime()}.${tail.id}` : null,
  };
}

/** Route 17: open alerts / open notices for this viewer (visible codes only), and the latest three that need attention. */
export async function incidentsSummary(
  prisma: Db,
  v: IncidentViewer,
  now: Date,
  presence?: PresenceSource,
): Promise<{ openAlerts: number; openNotices: number; latest: IncidentSummary[] }> {
  const [openAlerts, openNotices, latest] = await Promise.all([
    prisma.securityIncident.count({ where: incidentListWhere(v, { state: "attention", severity: "alert" }) }),
    prisma.securityIncident.count({ where: incidentListWhere(v, { state: "attention", severity: "notice" }) }),
    listIncidents(prisma, v, { state: "attention" }, 3, now, presence),
  ]);
  return { openAlerts, openNotices, latest: latest.incidents };
}

/**
 * Route 18: the detail, or null when the incident is missing OR hidden (the
 * route answers both with the same 404). `level` is the viewer's resolved
 * Security level for the `viewer` block.
 */
export async function loadIncidentDetail(
  prisma: Db,
  id: string,
  v: IncidentViewer,
  level: "view" | "act" | "manage",
  now: Date,
  presence?: PresenceSource,
): Promise<IncidentDetail | null> {
  const row = await prisma.securityIncident.findUnique({ where: { id }, select: INCIDENT_VIEW_SELECT });
  if (!row) return null;
  const reasons = await prisma.securityIncidentReason.findMany({
    where: { incidentId: id },
    orderBy: [{ evidenceAt: "asc" }, { id: "asc" }],
    select: REASON_VIEW_SELECT,
  });
  const p = projectIncident(row, reasons, v, now, (await holdsFor(prisma, [row], v, presence, now)).get(row.id));
  if (!p) return null;

  // Every ack when actionable; in a PARTIAL view only the viewer's own (what
  // she did herself — review b7e1); plain activity, none.
  const acks =
    p.actionable || p.partial
      ? await prisma.securityIncidentAck.findMany({
          where: { incidentId: id, ...(p.actionable ? {} : { byUserId: v.userId }) },
          orderBy: [{ at: "asc" }, { id: "asc" }],
        })
      : [];
  // Owner/admin: every notice. Anyone else: their own — and never a
  // skipped_not_visible one, which says an alert was raised on a camera they
  // cannot see (DS-005, review #1).
  const notices = p.actionable
    ? await prisma.securityIncidentNotice.findMany({
        where: { incidentId: id, ...(v.ownerOrAdmin ? {} : { userId: v.userId, outcome: { not: "skipped_not_visible" } }) },
        orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
      })
    : [];
  const names = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: notices.map((n) => n.userId) } },
        select: { id: true, displayName: true },
      })
    ).map((u) => [u.id, u.displayName]),
  );

  let events: IncidentMemberView[] = [];
  let moreEvents = false;
  if (row.eventsKept !== "removed") {
    const page = await listSecurityEvents(
      prisma,
      feedVisibilityWhere(v.visibleCameras, v.mayReadThreats),
      { limit: INCIDENT_EVENTS_MAX, includeLow: true },
      [{ triage: { is: { incidentId: id, outcome: "grouped" } } }],
    );
    moreEvents = page.nextCursor !== null;
    const triage = await prisma.securityEventTriage.findMany({
      where: { eventId: { in: page.events.map((e) => BigInt(e.id)) } },
      select: { eventId: true, alsoZoneIds: true },
    });
    const also = new Map(triage.map((t) => [t.eventId.toString(), t.alsoZoneIds]));
    const areas = viewerAreas(await loadActiveLinks(prisma), { visibleCameras: v.visibleCameras });
    events = page.events.map((e) => ({
      ...e,
      zones: zoneChipsFor(e, areas),
      alsoIn: (also.get(e.id) ?? [])
        .filter((zoneId) => areas.names.has(zoneId))
        .map((zoneId) => ({ id: zoneId, name: areas.names.get(zoneId)! })),
    }));
  }

  const lastAck = acks.length > 0 ? acks[acks.length - 1]! : null;
  return {
    ...summaryOf(p, lastAck),
    actionable: p.actionable && level !== "view" && (p.state === "open" || p.state === "acknowledged"),
    reasons: p.reasons.map((r) => ({
      code: r.code,
      severity: r.severity,
      evidence: {
        eventId: r.evidenceEventId.toString(),
        camera: r.evidenceCamera,
        source: r.evidenceSource,
        kind: r.evidenceKind,
        label: r.evidenceLabel,
        at: r.evidenceAt.toISOString(),
        summary: r.evidenceSummary,
      },
      detail: r.detail,
    })),
    events,
    moreEvents,
    acks: acks.map((a) => ({
      action: a.action,
      byName: a.byName,
      at: a.at.toISOString(),
      client: a.client,
      viaNotification: a.viaNotificationId !== null,
      note: a.note,
      signIn: v.ownerOrAdmin ? { recorded: a.sessionId !== null, confirmedLive: a.sessionId !== null && a.sessionChecked } : null,
    })),
    notices: notices.map((n) => ({
      userId: n.userId,
      // A self-edited display name, shown to every owner/admin: no controls, line separators or bidi.
      name: stripUnsafeDisplayChars(names.get(n.userId) ?? n.username).trim() || n.username,
      outcome: n.outcome,
      reason: n.reason,
      channels: n.channels,
      pushOutcome: n.pushOutcome,
      createdAt: n.createdAt.toISOString(),
      settledAt: n.settledAt ? n.settledAt.toISOString() : null,
    })),
    eventsKept: row.eventsKept,
    viewer: { level, acknowledged: acks.some((a) => a.byUserId === v.userId) },
  };
}
