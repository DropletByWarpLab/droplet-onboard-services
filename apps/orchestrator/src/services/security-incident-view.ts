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
import { loadActiveLinks, viewerAreas } from "./security-zones.service.js";
import { stripUnsafeDisplayChars } from "./security-audit.js";
import { parseCounts } from "../lib/security-rules.js";

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
const CODE_ORDER: readonly SecurityReasonCode[] = ["after_hours_presence", "camera_offline", "threat_signal"];
const SITE_SCOPES: readonly SecurityIncidentScope[] = ["site_threat", "site_camera_system"];

const seesCamera = (v: IncidentViewer, camera: string): boolean => v.visibleCameras === "all" || v.visibleCameras.has(camera);

/** Whether this viewer may know the incident exists at all. */
export function incidentVisible(i: Pick<IncidentRowForView, "scope" | "cameras">, v: IncidentViewer): boolean {
  if (i.scope === "site_threat") return v.mayReadThreats;
  if (i.scope === "site_camera_system") return true;
  return i.cameras.some((c) => seesCamera(v, c));
}

/** Whether this viewer may see one reason: its evidence camera, or the incident's own scope rule for a camera-less one. */
export function reasonVisible(r: Pick<ReasonRowForView, "evidenceCamera">, i: Pick<IncidentRowForView, "scope">, v: IncidentViewer): boolean {
  if (r.evidenceCamera === null) return i.scope === "site_threat" ? v.mayReadThreats : SITE_SCOPES.includes(i.scope);
  return seesCamera(v, r.evidenceCamera);
}

export interface IncidentProjection {
  incident: IncidentRowForView;
  /** The viewer's visible reasons. */
  reasons: ReasonRowForView[];
  /** Max over the visible reasons; info when none. */
  severity: SecuritySeverity;
  /** The visible reasons' distinct codes, in declaration order. */
  codes: SecurityReasonCode[];
  /** The stored state — or `no_action` when the viewer has no visible code. */
  state: SecurityIncidentState;
  /** A visible code exists: the viewer may acknowledge / resolve, and sees acks and notices. */
  actionable: boolean;
  /** Visible events (from the counts snapshot, so it survives the trim). */
  eventCount: number;
  /** Visible counts per label (`_status` / `_threat` for status and threat rows). */
  labels: Record<string, number>;
}

/** §6.8 — null when the viewer may not know the incident exists. */
export function projectIncident(i: IncidentRowForView, reasons: readonly ReasonRowForView[], v: IncidentViewer): IncidentProjection | null {
  if (!incidentVisible(i, v)) return null;
  const visible = reasons.filter((r) => reasonVisible(r, i, v));
  let severity: SecuritySeverity = "info";
  for (const r of visible) if (SEVERITY_RANK[r.severity] > SEVERITY_RANK[severity]) severity = r.severity;
  const codes = CODE_ORDER.filter((c) => visible.some((r) => r.code === c));
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
  const actionable = codes.length > 0;
  return {
    incident: i,
    reasons: visible,
    severity,
    codes,
    state: actionable ? i.state : "no_action",
    actionable,
    eventCount,
    labels,
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

/** A reason the viewer may see — on an incident the visibility clause already let through. */
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
 * hidden camera's code. `attention` is an open incident (nobody on it yet);
 * `activity` is one with no visible code.
 */
export function incidentListWhere(v: IncidentViewer, f: IncidentListFilters): Prisma.SecurityIncidentWhereInput {
  const vis = visibleReasonWhere(v);
  const and: Prisma.SecurityIncidentWhereInput[] = [incidentVisibilityWhere(v)];
  switch (f.state) {
    case "attention":
    case "open":
      and.push({ state: "open", reasons: { some: vis } });
      break;
    case "acknowledged":
    case "resolved":
      and.push({ state: f.state, reasons: { some: vis } });
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

/** `<lastActivityAt ms>.<uuid>` — the keyset position of a page's last incident. */
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
  /** Visible counts per label; `_status` / `_threat` count status and threat rows. */
  labels: Record<string, number>;
  /** The latest acknowledgement, when the viewer has a visible code. */
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

export type IncidentMemberView = Awaited<ReturnType<typeof listSecurityEvents>>["events"][number] & {
  /** The other visible areas the event also matched at triage. */
  alsoIn: Array<{ id: string; name: string }>;
};

export interface IncidentDetail extends IncidentSummary {
  reasons: IncidentReasonView[];
  /** Visible members while their events are kept, newest first (the feed row shape). */
  events: IncidentMemberView[];
  /** More visible members than `events` carries. */
  moreEvents: boolean;
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
    grouping: i.grouping,
    openedInMode: i.openedInMode,
    firstActivityAt: i.firstActivityAt.toISOString(),
    lastActivityAt: i.lastActivityAt.toISOString(),
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

/** Project a page of incidents with one reasons query and one acks query. Hidden rows (never expected after the SQL) are dropped. */
async function summariesOf(prisma: Db, rows: readonly IncidentRowForView[], v: IncidentViewer): Promise<IncidentSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const reasons = await prisma.securityIncidentReason.findMany({
    where: { incidentId: { in: ids } },
    select: { incidentId: true, ...REASON_VIEW_SELECT },
  });
  const acks = await latestAcks(prisma, ids);
  const out: IncidentSummary[] = [];
  for (const row of rows) {
    const p = projectIncident(row, reasons.filter((r) => r.incidentId === row.id), v);
    if (p) out.push(summaryOf(p, acks.get(row.id) ?? null));
  }
  return out;
}

/** Route 16: one page, `(lastActivityAt desc, id desc)`. */
export async function listIncidents(
  prisma: Db,
  v: IncidentViewer,
  f: IncidentListFilters,
  limit: number,
): Promise<{ incidents: IncidentSummary[]; nextCursor: string | null }> {
  const rows = await prisma.securityIncident.findMany({
    where: incidentListWhere(v, f),
    orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: INCIDENT_VIEW_SELECT,
  });
  const page = rows.slice(0, limit);
  const tail = page[page.length - 1];
  return {
    incidents: await summariesOf(prisma, page, v),
    nextCursor: rows.length > limit && tail ? `${tail.lastActivityAt.getTime()}.${tail.id}` : null,
  };
}

/** Route 17: open alerts / open notices for this viewer (visible codes only), and the latest three that need attention. */
export async function incidentsSummary(
  prisma: Db,
  v: IncidentViewer,
): Promise<{ openAlerts: number; openNotices: number; latest: IncidentSummary[] }> {
  const [openAlerts, openNotices, latest] = await Promise.all([
    prisma.securityIncident.count({ where: incidentListWhere(v, { state: "attention", severity: "alert" }) }),
    prisma.securityIncident.count({ where: incidentListWhere(v, { state: "attention", severity: "notice" }) }),
    listIncidents(prisma, v, { state: "attention" }, 3),
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
): Promise<IncidentDetail | null> {
  const row = await prisma.securityIncident.findUnique({ where: { id }, select: INCIDENT_VIEW_SELECT });
  if (!row) return null;
  const reasons = await prisma.securityIncidentReason.findMany({
    where: { incidentId: id },
    orderBy: [{ evidenceAt: "asc" }, { id: "asc" }],
    select: REASON_VIEW_SELECT,
  });
  const p = projectIncident(row, reasons, v);
  if (!p) return null;

  const acks = p.actionable
    ? await prisma.securityIncidentAck.findMany({ where: { incidentId: id }, orderBy: [{ at: "asc" }, { id: "asc" }] })
    : [];
  const notices = p.actionable
    ? await prisma.securityIncidentNotice.findMany({
        where: { incidentId: id, ...(v.ownerOrAdmin ? {} : { userId: v.userId }) },
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
      alsoIn: (also.get(e.id) ?? [])
        .filter((zoneId) => areas.names.has(zoneId))
        .map((zoneId) => ({ id: zoneId, name: areas.names.get(zoneId)! })),
    }));
  }

  const lastAck = acks.length > 0 ? acks[acks.length - 1]! : null;
  return {
    ...summaryOf(p, lastAck),
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
