/**
 * WARP-2978 (ADR-059 P3 §3.5, spec §6.2–§6.5) — the incident rules, PURE and
 * versioned: which scope an event groups under, which incident it joins, and
 * which reason codes it earns. The engine (services/security-incidents.service.ts)
 * does the I/O and calls here.
 *
 * Grouping (D12–D14):
 *   · one event → at most one incident. An event in several areas groups
 *     under the most sensitive (`rankPick`); the others are recorded on the
 *     member (`alsoZoneIds`), so after-hours evaluation sees that area;
 *   · scopes: an area; a camera no area covers; site-wide threats; the camera
 *     system as a whole. `detection_low` is `low`; `mode_changed` and every
 *     kind P3 does not know (a lock reading) are `context`; online rows only
 *     JOIN — a lone recovery is not news;
 *   · the numbers (D13): 5 min of event-time quiet ends an incident, 90 s is
 *     the settle (backward tolerance, and the arrival wait before sealing),
 *     60 min is the span cap, and nothing joins across a mode change.
 *     Consequences, on purpose: a continuous two-hour presence is two
 *     incidents (one alert each hour), a long-tracked object whose `end`
 *     arrives after its incident sealed opens its own, and grouping is
 *     deterministic given triage order (the ledger records `triagedAt`).
 *
 * Rules (D18–D21): severity comes from the codes only. after_hours_presence
 * alerts; camera_offline and threat_signal are notices and never alert in P3
 * (a CHECK pins the pairs). Codes are monotonic: a reason is never deleted or
 * downgraded. Lock rows feed no rule (D21).
 *
 * Changing any number in RULESET needs a SECURITY_RULESET_VERSION bump
 * (lib/ruleset-fingerprint.test.ts fails otherwise).
 *
 * Version 2 (WARP-2978 PR-D, spec §6.12): early presence. A person Frigate is
 * still tracking 30 s in gets one `detection_ongoing` row; it groups like a
 * detection (same camera, same areas), counts as `_ongoing` (not a second
 * person), spans `[startedAt, createdAt]` (it was still in view when it was
 * written), and after_hours_presence accepts it — so the alert goes out at
 * about 30 s instead of at Frigate's `end`, and the later `end` row joins the
 * same incident.
 */
import type {
  SecurityIncidentScope,
  SecurityIncidentState,
  SecurityIncidentNotify,
  SecurityMode,
  SecurityReasonCode,
  SecuritySeverity,
  SecurityZoneKind,
} from "@prisma/client";
import { nonOpenWithin, type ModeTimeline } from "./security-mode-history.js";

export const SECURITY_RULESET_VERSION = 2;

export const RULESET = {
  after_hours_presence: {
    severity: "alert",
    label: "person",
    /** v2 (PR-D): a person still in view at 30 s alerts without waiting for their `end`. */
    kinds: ["detection", "detection_ongoing"],
    zoneKinds: ["interior", "restricted"],
  },
  camera_offline: { severity: "notice", minOfflineMs: 60_000 },
  threat_signal: { severity: "notice", ignoreActivitySubs: ["web_push"] },
} as const;

/** Event-time quiet that ends an incident (D13). */
export const QUIET_MS = 300_000;
/** How far before an incident's first activity an event may start and still join; also how long sealing waits after the last arrival (D13). */
export const SETTLE_MS = 90_000;
/** An incident never spans more than this in event time (D13). */
export const MAX_SPAN_MS = 3_600_000;
/** Evidence rows kept per (incident, code, evidence camera) — per camera, so a hidden camera's evidence never crowds out a visible one's (DS-005). */
export const EVIDENCE_PER_CAMERA = 5;

/** The kinds P3 groups (PR-D added `detection_ongoing`). Anything else is `context`. */
export const GROUPABLE_KINDS = [
  "detection",
  "detection_ongoing",
  "camera_offline",
  "camera_online",
  "source_offline",
  "source_online",
  "threat",
] as const;
/** Kinds that only ever join an incident. */
export const JOIN_ONLY_KINDS = ["camera_online", "source_online"] as const;

/** D12: the more sensitive the area, the higher. */
export const ZONE_KIND_RANK: Readonly<Record<SecurityZoneKind, number>> = {
  restricted: 5,
  interior: 4,
  entry: 3,
  perimeter: 2,
  parking: 1,
};

const SEVERITY_RANK: Readonly<Record<SecuritySeverity, number>> = { info: 0, notice: 1, alert: 2 };
/** Declaration order of SecurityReasonCode — how `reasonCodes` is kept sorted. */
const CODE_ORDER: readonly SecurityReasonCode[] = ["after_hours_presence", "camera_offline", "threat_signal"];

// ── the event, as triage reads it ─────────────────────────────────────────

/**
 * One SecurityEvent row. `source` and `kind` are strings, not the Prisma
 * enums: a kind this build does not group (a lock reading once P2b PR-2
 * lands) must reach `scopeFor` and fall into `context`, not fail to type.
 */
export interface TriageEvent {
  id: bigint;
  source: string;
  kind: string;
  camera: string | null;
  sourceRef: string;
  labels: readonly string[];
  cameraZones: readonly string[];
  startedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
  summary: string;
}

// ── scope and area choice (§6.2) ──────────────────────────────────────────

/** An active area that matched an event (`matchAreasForEvent`, security-zones.service.ts). */
export interface AreaMatch {
  zoneId: string;
  zoneName: string;
  zoneKind: SecurityZoneKind;
  /** The area's active link ids that matched this event. */
  linkIds: string[];
  /** `part` when a part-of-view (camera_zone) link matched, else `whole`. */
  specificity: "part" | "whole";
}

/** What makes two events candidates for the same incident. */
export interface ScopeKey {
  scope: SecurityIncidentScope;
  zoneId: string | null;
  scopeCamera: string | null;
}

export type ScopeDecision =
  | { outcome: "low" }
  | { outcome: "context" }
  | {
      outcome: "group";
      key: ScopeKey;
      /** The primary area (scope `area` only). */
      area: AreaMatch | null;
      /** The other matched areas, sorted. */
      alsoZoneIds: string[];
      /** The primary area's matching link ids. */
      matchedLinkIds: string[];
      /** An online row: joins a fitting incident, never opens one. */
      joinOnly: boolean;
    };

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** D12: kind rank, then a part-of-view link over a whole-camera one, then the lowest zone id. `matches` is non-empty. */
export function rankPick(matches: readonly AreaMatch[]): AreaMatch {
  if (matches.length === 0) throw new Error("rankPick: no areas");
  return [...matches].sort(
    (a, b) =>
      ZONE_KIND_RANK[b.zoneKind] - ZONE_KIND_RANK[a.zoneKind] ||
      (a.specificity === b.specificity ? 0 : a.specificity === "part" ? -1 : 1) ||
      byString(a.zoneId, b.zoneId),
  )[0]!;
}

const CAMERA_KINDS: ReadonlySet<string> = new Set(["detection", "detection_ongoing", "camera_offline", "camera_online"]);

/** §6.2's table. `matches` are the active areas the event matched (camera rows only). */
export function scopeFor(event: TriageEvent, matches: readonly AreaMatch[]): ScopeDecision {
  if (event.kind === "detection_low") return { outcome: "low" };
  if (!(GROUPABLE_KINDS as readonly string[]).includes(event.kind)) return { outcome: "context" };
  const joinOnly = (JOIN_ONLY_KINDS as readonly string[]).includes(event.kind);
  const site = (scope: SecurityIncidentScope): ScopeDecision => ({
    outcome: "group",
    key: { scope, zoneId: null, scopeCamera: null },
    area: null,
    alsoZoneIds: [],
    matchedLinkIds: [],
    joinOnly,
  });
  if (event.kind === "threat") return site("site_threat");
  if (event.kind === "source_offline" || event.kind === "source_online") return site("site_camera_system");
  if (!CAMERA_KINDS.has(event.kind) || event.camera === null) return { outcome: "context" };
  if (matches.length === 0) {
    return {
      outcome: "group",
      key: { scope: "camera", zoneId: null, scopeCamera: event.camera },
      area: null,
      alsoZoneIds: [],
      matchedLinkIds: [],
      joinOnly,
    };
  }
  const primary = rankPick(matches);
  return {
    outcome: "group",
    key: { scope: "area", zoneId: primary.zoneId, scopeCamera: null },
    area: primary,
    alsoZoneIds: [...new Set(matches.map((m) => m.zoneId).filter((id) => id !== primary.zoneId))].sort(byString),
    matchedLinkIds: [...primary.linkIds].sort(byString),
    joinOnly,
  };
}

// ── join (§6.3) ───────────────────────────────────────────────────────────

/**
 * An event's event-time span: `[startedAt, endedAt ?? startedAt]`, never
 * backwards. A `detection_ongoing` row has no end yet, but it is written only
 * while its person is still tracked, so it spans `[startedAt, createdAt]`:
 * the presence it proves (PR-D).
 */
export interface EventSpan {
  s: Date;
  e: Date;
}

export function eventSpan(
  event: Pick<TriageEvent, "startedAt" | "endedAt"> & Partial<Pick<TriageEvent, "kind" | "createdAt">>,
): EventSpan {
  const s = event.startedAt;
  const end = event.endedAt ?? (event.kind === "detection_ongoing" ? (event.createdAt ?? null) : null);
  return { s, e: end && end.getTime() > s.getTime() ? end : s };
}

/** The columns the join window reads. */
export interface GroupableIncident {
  id: string;
  firstActivityAt: Date;
  lastActivityAt: Date;
  openedInMode: SecurityMode;
}

/** D13's four conditions. */
export function fitsIncident(i: GroupableIncident, span: EventSpan, mode: SecurityMode): boolean {
  const first = i.firstActivityAt.getTime();
  const last = i.lastActivityAt.getTime();
  const s = span.s.getTime();
  const e = span.e.getTime();
  return (
    s <= last + QUIET_MS &&
    e >= first - SETTLE_MS &&
    Math.max(last, e) - Math.min(first, s) <= MAX_SPAN_MS &&
    mode === i.openedInMode
  );
}

/** The collecting incident of the event's scope it joins: the latest activity wins, then the smallest id. */
export function pickIncident<T extends GroupableIncident>(candidates: readonly T[], span: EventSpan, mode: SecurityMode): T | null {
  const fits = candidates.filter((c) => fitsIncident(c, span, mode));
  fits.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || byString(a.id, b.id));
  return fits[0] ?? null;
}

export type TriagePlan<T> =
  | { action: "low" }
  | { action: "context" }
  | { action: "join"; incident: T }
  | { action: "open" };

/** Join a fitting incident, open one, or — for an online row with nothing to join — leave it as context. */
export function planTriage<T extends GroupableIncident>(
  decision: ScopeDecision,
  candidates: readonly T[],
  span: EventSpan,
  mode: SecurityMode,
): TriagePlan<T> {
  if (decision.outcome === "low") return { action: "low" };
  if (decision.outcome === "context") return { action: "context" };
  const pick = pickIncident(candidates, span, mode);
  if (pick) return { action: "join", incident: pick };
  return decision.joinOnly ? { action: "context" } : { action: "open" };
}

// ── counts (DS-005 after the trim) ────────────────────────────────────────

/**
 * `{"<camera>": {"<label>": n, "_status": n, "_ongoing": n}, "": {"_threat": n, "_status": n}}`.
 * A person's "still in view" row (PR-D) is `_ongoing`, not a second `person`:
 * their `end` row counts them.
 */
export type CountsByCamera = Record<string, Record<string, number>>;

/** The stored Json as counts: plain objects of non-negative integers only; anything else is dropped. */
export function parseCounts(json: unknown): CountsByCamera {
  const out: CountsByCamera = {};
  if (!json || typeof json !== "object" || Array.isArray(json)) return out;
  for (const [camera, labels] of Object.entries(json as Record<string, unknown>)) {
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) continue;
    const kept: Record<string, number> = {};
    for (const [label, n] of Object.entries(labels as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) kept[label] = n;
    }
    if (Object.keys(kept).length > 0) out[camera] = kept;
  }
  return out;
}

/** Where one event is counted: its camera ('' for site rows) and label (`_status` / `_threat` for non-detections). */
export function countKey(event: Pick<TriageEvent, "kind" | "camera" | "labels">): { camera: string; label: string } {
  const camera = event.camera ?? "";
  if (event.kind === "threat") return { camera, label: "_threat" };
  if (event.kind === "detection") return { camera, label: event.labels[0] || "_other" };
  if (event.kind === "detection_ongoing") return { camera, label: "_ongoing" };
  return { camera, label: "_status" };
}

function addCount(counts: CountsByCamera, event: TriageEvent): CountsByCamera {
  const { camera, label } = countKey(event);
  const next: CountsByCamera = { ...counts, [camera]: { ...(counts[camera] ?? {}) } };
  next[camera]![label] = (next[camera]![label] ?? 0) + 1;
  return next;
}

/**
 * Review #4 (DS-005) — each camera's own event-time span (`""` = site rows),
 * as ISO strings: `{"<camera>": {first, last}}`. A viewer who cannot see every
 * camera gets the incident's times (and whether it is still happening) from
 * her cameras alone, so a person on a hidden camera never moves them. Its own
 * column, not inside `countsByCamera`, whose every number is an event count.
 */
export type SpanByCamera = Record<string, { first: string; last: string }>;

/** The stored Json as spans (Dates): well-formed `{first, last}` ISO pairs only; anything else is dropped. */
export function parseSpans(json: unknown): Record<string, { first: Date; last: Date }> {
  const out: Record<string, { first: Date; last: Date }> = {};
  if (!json || typeof json !== "object" || Array.isArray(json)) return out;
  for (const [camera, v] of Object.entries(json as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const { first, last } = v as { first?: unknown; last?: unknown };
    if (typeof first !== "string" || typeof last !== "string") continue;
    const f = new Date(first);
    const l = new Date(last);
    if (Number.isNaN(f.getTime()) || Number.isNaN(l.getTime())) continue;
    out[camera] = { first: f, last: l };
  }
  return out;
}

function addSpan(spans: SpanByCamera, event: TriageEvent, span: EventSpan): SpanByCamera {
  const key = event.camera ?? "";
  const prior = parseSpans(spans)[key];
  const first = prior && prior.first.getTime() < span.s.getTime() ? prior.first : span.s;
  const last = prior && prior.last.getTime() > span.e.getTime() ? prior.last : span.e;
  return { ...spans, [key]: { first: first.toISOString(), last: last.toISOString() } };
}

/** The columns an incident's first event sets. */
export interface OpeningFields {
  firstActivityAt: Date;
  lastActivityAt: Date;
  lastArrivalAt: Date;
  eventCount: number;
  countsByCamera: CountsByCamera;
  cameras: string[];
  spanByCamera: SpanByCamera;
}

export function openingFields(event: TriageEvent, span: EventSpan): OpeningFields {
  return {
    firstActivityAt: span.s,
    lastActivityAt: span.e,
    lastArrivalAt: event.createdAt,
    eventCount: 1,
    countsByCamera: addCount({}, event),
    cameras: event.camera ? [event.camera] : [],
    spanByCamera: addSpan({}, event, span),
  };
}

export interface JoinableIncident extends GroupableIncident {
  lastArrivalAt: Date;
  eventCount: number;
  countsByCamera: unknown;
  cameras: readonly string[];
  spanByCamera: unknown;
}

/** What joining changes (§6.3): the span (min/max), the arrival clock, the count, the counts per camera, the cameras. */
export function joinPatch(i: JoinableIncident, event: TriageEvent, span: EventSpan): OpeningFields {
  const cameras = new Set(i.cameras);
  if (event.camera) cameras.add(event.camera);
  return {
    firstActivityAt: span.s.getTime() < i.firstActivityAt.getTime() ? span.s : i.firstActivityAt,
    lastActivityAt: span.e.getTime() > i.lastActivityAt.getTime() ? span.e : i.lastActivityAt,
    lastArrivalAt: event.createdAt.getTime() > i.lastArrivalAt.getTime() ? event.createdAt : i.lastArrivalAt,
    eventCount: i.eventCount + 1,
    countsByCamera: addCount(parseCounts(i.countsByCamera), event),
    cameras: [...cameras].sort(byString),
    spanByCamera: addSpan(toSpanJson(i.spanByCamera), event, span),
  };
}

/** A stored spans column, re-serialised from its validated entries. */
function toSpanJson(json: unknown): SpanByCamera {
  const out: SpanByCamera = {};
  for (const [camera, { first, last }] of Object.entries(parseSpans(json))) {
    out[camera] = { first: first.toISOString(), last: last.toISOString() };
  }
  return out;
}

// ── the rules (§6.5) ──────────────────────────────────────────────────────

/** A reason row to write: the code, its severity, and the evidence snapshot. */
export interface ReasonDraft {
  code: SecurityReasonCode;
  severity: SecuritySeverity;
  evidenceEventId: bigint;
  /** NULL = site-wide (a threat, the camera system). */
  evidenceCamera: string | null;
  evidenceSource: string;
  evidenceKind: string;
  evidenceLabel: string | null;
  evidenceAt: Date;
  evidenceSummary: string;
  /** The rule's numbers (§4): strings, safe integers or null only. */
  detail: Record<string, string | number | null>;
}

function evidenceOf(
  code: SecurityReasonCode,
  event: TriageEvent,
  label: string | null,
  detail: ReasonDraft["detail"],
): ReasonDraft {
  return {
    code,
    severity: RULESET[code].severity,
    evidenceEventId: event.id,
    evidenceCamera: event.camera,
    evidenceSource: event.source,
    evidenceKind: event.kind,
    evidenceLabel: label === null ? null : label.slice(0, 64),
    evidenceAt: event.startedAt,
    evidenceSummary: event.summary.slice(0, 500),
    detail,
  };
}

/**
 * after_hours_presence (alert, D20): a `person` detection in an interior or
 * restricted area whose `[startedAt, endedAt]` touches an instant the site was
 * not open — checked at the start, at every mode row inside, and at the end.
 * `zoneKind` is the INCIDENT's snapshot (the most sensitive area, D12).
 * v2 (PR-D): a `detection_ongoing` row counts too, over `[startedAt,
 * createdAt]` (`eventSpan`) — the person was in view that whole time.
 */
export function afterHoursPresence(input: {
  scope: SecurityIncidentScope;
  zoneKind: SecurityZoneKind | null;
  event: TriageEvent;
  timeline: ModeTimeline;
}): ReasonDraft | null {
  const rule = RULESET.after_hours_presence;
  const { event } = input;
  if (input.scope !== "area" || input.zoneKind === null) return null;
  if (!(rule.zoneKinds as readonly string[]).includes(input.zoneKind)) return null;
  if (!(rule.kinds as readonly string[]).includes(event.kind) || !event.labels.includes(rule.label)) return null;
  const span = eventSpan(event);
  const nonOpen = nonOpenWithin(input.timeline, span.s, span.e);
  if (!nonOpen) return null;
  return evidenceOf("after_hours_presence", event, rule.label, {
    mode: nonOpen.mode,
    modeSource: nonOpen.source,
    nonOpenAt: nonOpen.at.toISOString(),
    zoneKind: input.zoneKind,
  });
}

/** The ActivityRow id a mirrored threat points at (`activity:<id>`), or null. */
export function parseActivityRef(sourceRef: string): bigint | null {
  const m = /^activity:(\d{1,19})$/.exec(sourceRef);
  return m ? BigInt(m[1]!) : null;
}

/**
 * threat_signal (notice, D19): a mirrored network/sign-in warning — except
 * Droplet's own push-egress bookkeeping (`sub = 'web_push'`), which alerts
 * themselves produce whenever push is off. `activity` is the source row's
 * `sub`, or null when the chain row is gone (the 90-day purge): then it fires.
 */
export function threatSignal(event: TriageEvent, activity: { sub: string | null } | null): ReasonDraft | null {
  if (event.kind !== "threat") return null;
  if (activity && activity.sub !== null && (RULESET.threat_signal.ignoreActivitySubs as readonly string[]).includes(activity.sub)) {
    return null;
  }
  const id = parseActivityRef(event.sourceRef);
  return evidenceOf("threat_signal", event, event.labels[0] ?? null, {
    activityId: id === null ? null : id.toString(),
    kind: event.labels[0] ?? null,
  });
}

/** The recovery kind for an offline row. */
export function onlineKindFor(kind: string): "camera_online" | "source_online" {
  return kind === "source_offline" ? "source_online" : "camera_online";
}

export type OfflineVerdict =
  | { verdict: "wait" }
  | { verdict: "blip" }
  | { verdict: "fire"; reason: ReasonDraft };

/**
 * camera_offline (notice, D18): an offline row `o` with NO recovery of the
 * same camera (NULL = Frigate) in `(o.startedAt, o.startedAt + 60 s]`, judged
 * once `now ≥ o.startedAt + 60 s`. `onlines` are that camera's recovery rows
 * at or after `o.startedAt`, in time order, read from the store by
 * (camera, startedAt) — not from membership, so a recovery that went to
 * another incident (a mode split) still counts as a blip.
 */
export function cameraOfflineVerdict(
  offline: TriageEvent,
  onlines: ReadonlyArray<{ startedAt: Date }>,
  now: Date,
): OfflineVerdict {
  const o = offline.startedAt.getTime();
  const min = RULESET.camera_offline.minOfflineMs;
  const after = onlines.filter((r) => r.startedAt.getTime() > o).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const back = after[0] ?? null;
  if (back && back.startedAt.getTime() <= o + min) return { verdict: "blip" };
  if (!back && now.getTime() < o + min) return { verdict: "wait" };
  return {
    verdict: "fire",
    reason: evidenceOf("camera_offline", offline, null, {
      offlineForSec: back ? Math.round((back.startedAt.getTime() - o) / 1000) : null,
      backAt: back ? back.startedAt.toISOString() : null,
    }),
  };
}

// ── what a reason does to its incident ────────────────────────────────────

/**
 * Evidence kept per (code, camera): what is already stored plus these drafts,
 * at most EVIDENCE_PER_CAMERA, never a duplicate of a stored evidence row.
 */
export function capEvidence(
  existing: ReadonlyArray<{ code: SecurityReasonCode; evidenceCamera: string | null; evidenceEventId: bigint }>,
  drafts: readonly ReasonDraft[],
): ReasonDraft[] {
  const key = (code: string, camera: string | null) => `${code}\u0000${camera ?? ""}`;
  const count = new Map<string, number>();
  const stored = new Set<string>();
  for (const r of existing) {
    count.set(key(r.code, r.evidenceCamera), (count.get(key(r.code, r.evidenceCamera)) ?? 0) + 1);
    stored.add(`${r.code}\u0000${r.evidenceEventId}`);
  }
  const kept: ReasonDraft[] = [];
  for (const d of drafts) {
    if (stored.has(`${d.code}\u0000${d.evidenceEventId}`)) continue;
    const k = key(d.code, d.evidenceCamera);
    const n = count.get(k) ?? 0;
    if (n >= EVIDENCE_PER_CAMERA) continue;
    count.set(k, n + 1);
    stored.add(`${d.code}\u0000${d.evidenceEventId}`);
    kept.push(d);
  }
  return kept;
}

/** The incident columns a reason can move. */
export interface ReasonState {
  severity: SecuritySeverity;
  reasonCodes: readonly SecurityReasonCode[];
  state: SecurityIncidentState;
  notifyState: SecurityIncidentNotify;
  alertedAt: Date | null;
}

export interface ReasonPatch {
  severity?: SecuritySeverity;
  reasonCodes?: SecurityReasonCode[];
  state?: SecurityIncidentState;
  stateChangedAt?: Date;
  stateChangedById?: null;
  alertedAt?: Date;
  notifyState?: SecurityIncidentNotify;
}

export function maxSeverity(a: SecuritySeverity, b: SecuritySeverity): SecuritySeverity {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

/**
 * What adding these codes changes (§6.5), empty when nothing:
 *   · severity = max, never lowered; reasonCodes = the sorted distinct union;
 *   · no_action → open when the severity leaves info;
 *   · reaching alert: alertedAt = now, notifyState = pending, and an
 *     acknowledged incident goes back to open — once, because alert is the
 *     maximum (D22).
 */
export function reasonPatch(i: ReasonState, drafts: readonly ReasonDraft[], now: Date): ReasonPatch {
  const patch: ReasonPatch = {};
  const codes = new Set<SecurityReasonCode>(i.reasonCodes);
  let severity = i.severity;
  for (const d of drafts) {
    codes.add(d.code);
    severity = maxSeverity(severity, d.severity);
  }
  const sorted = CODE_ORDER.filter((c) => codes.has(c));
  if (sorted.length !== i.reasonCodes.length || sorted.some((c, n) => c !== i.reasonCodes[n])) patch.reasonCodes = sorted;
  if (severity === i.severity) return patch;
  patch.severity = severity;
  const reopen = (): void => {
    patch.state = "open";
    patch.stateChangedAt = now;
    patch.stateChangedById = null;
  };
  if (i.state === "no_action") reopen();
  if (severity === "alert") {
    patch.alertedAt = now;
    patch.notifyState = "pending";
    if (i.state === "acknowledged") reopen();
  }
  return patch;
}
