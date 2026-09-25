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
 *
 * Version 3 (WARP-2980 P5 PR-B, p5b spec §4): the pattern codes. PATTERN_RULES
 * holds out_of_place, unusual_volume and long_dwell — P5-A's arithmetic
 * (lib/security-baseline-math.ts) behind them, the severity modifiers of brief
 * §4.3 and the baseline numbers — and is fingerprinted WITH RULESET, so a
 * pattern threshold changed under the same version fails too. Every pattern
 * code is `release: "trial"`: judged per evidence and written to
 * SecurityPatternFlag, never to a reason — it never changes an incident's
 * severity, state, codes or notifications (the reasons CHECK refuses it until
 * P5 PR-D flips a release, which moves the fingerprint and so the version).
 * The build stamps this version too: cells are raw counts and the arithmetic
 * is code, so the rules never gate on a build's version (an old build is still
 * valid input). Expected activity ("suppressions" in code) quiets the pattern
 * codes only, never after_hours_presence (spec D12): `suppressionFor` takes a
 * PatternCode, and the engine never asks it about a P3 code.
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
import {
  BASELINE,
  DWELL_LABELS,
  DWELL_MIN_SAMPLES,
  DWELL_MIN_SEC,
  PATTERN_CODES,
  RARITY_MAX_P,
  VOLUME_MAX_TAIL_P,
  VOLUME_MIN_K,
  dwellThresholdSec,
  hourlyRate,
  isRare,
  isReady,
  rarityP,
  slotRate,
  smoothCounts,
  volumeThreshold,
  wouldFlagDwell,
  wouldFlagVolume,
  type CellCounts,
  type CellDwell,
  type PatternCode,
  type PatternRelease,
} from "./security-baseline-math.js";
import { poissonUpperTail } from "./security-stats.js";
import { dayTypeOf, type SecurityDayTypeValue } from "./security-baseline-slots.js";
import { isoWeekdayOf, localPartsOf, ymdAddDays } from "./zoned-time.js";

export const SECURITY_RULESET_VERSION = 3;

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

/**
 * v3 (WARP-2980 P5 PR-B) — the pattern rules. Every code `trial` until P5 PR-D
 * (spec D2). `severity`: brief §4.3's modifiers from `base` — the mode raises
 * one step, a restricted area one step, busier-than-usual at an open entry is
 * `info` — then capped: only a person reaches alert (spec D9).
 */
export const PATTERN_RULES = {
  codes: {
    out_of_place: {
      release: "trial",
      kinds: ["detection"],
      maxP: RARITY_MAX_P,
      severity: { base: "notice", maxPerson: "alert", maxOther: "notice" },
    },
    unusual_volume: {
      release: "trial",
      kinds: ["detection"],
      maxTailP: VOLUME_MAX_TAIL_P,
      minK: VOLUME_MIN_K,
      severity: { base: "notice", maxPerson: "notice", maxOther: "notice", infoWhen: { mode: "open", zoneKind: "entry" } },
    },
    long_dwell: {
      release: "trial",
      kinds: ["detection"],
      labels: DWELL_LABELS,
      minSec: DWELL_MIN_SEC,
      minSamples: DWELL_MIN_SAMPLES,
      severity: { base: "notice", maxPerson: "alert", maxOther: "notice" },
    },
  },
  raiseModes: ["closed", "away"],
  raiseZoneKinds: ["restricted"],
  baseline: BASELINE,
} as const;

/** What lib/ruleset-fingerprint.test.ts pins to SECURITY_RULESET_VERSION: every number either set of rules reads. */
export const FINGERPRINTED_RULES = { ruleset: RULESET, patterns: PATTERN_RULES } as const;

/** Each pattern code's release, from the fingerprinted rules (routes 29/31 and the patterns health row read it). */
export const PATTERN_RELEASE: Readonly<Record<PatternCode, PatternRelease>> = Object.fromEntries(
  PATTERN_CODES.map((c) => [c, PATTERN_RULES.codes[c].release]),
) as Record<PatternCode, PatternRelease>;

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
/**
 * Declaration order of SecurityReasonCode — how `reasonCodes`, a viewer's
 * codes and `verdictCodes` are kept sorted. security-rules.test.ts compares it
 * with the enum block of prisma/schema.prisma.
 */
export const REASON_CODE_ORDER = [
  "after_hours_presence",
  "camera_offline",
  "threat_signal",
  "out_of_place",
  "unusual_volume",
  "long_dwell",
] as const satisfies readonly SecurityReasonCode[];
// Exhaustive at compile time: a code added to the enum without a place here fails tsc.
type UnorderedCode = Exclude<SecurityReasonCode, (typeof REASON_CODE_ORDER)[number]>;
const everyCodeOrdered: [UnorderedCode] extends [never] ? true : UnorderedCode = true;
void everyCodeOrdered;

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

/** The P3 codes: each has ONE severity in RULESET. The pattern codes (P5) never reach `evidenceOf`. */
export type P3Code = keyof typeof RULESET;

function evidenceOf(
  code: P3Code,
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

/** What `capEvidence` reads of a stored row or a draft: a reason or (PR-B) a pattern flag. */
export interface EvidenceKey {
  code: SecurityReasonCode;
  evidenceCamera: string | null;
  evidenceEventId: bigint;
}

/**
 * Evidence kept per (code, camera): what is already stored plus these drafts,
 * at most EVIDENCE_PER_CAMERA, never a duplicate of a stored evidence row.
 * Reasons and pattern flags are capped by this one function.
 */
export function capEvidence<D extends EvidenceKey>(existing: ReadonlyArray<EvidenceKey>, drafts: readonly D[]): D[] {
  const key = (code: string, camera: string | null) => `${code}\u0000${camera ?? ""}`;
  const count = new Map<string, number>();
  const stored = new Set<string>();
  for (const r of existing) {
    count.set(key(r.code, r.evidenceCamera), (count.get(key(r.code, r.evidenceCamera)) ?? 0) + 1);
    stored.add(`${r.code}\u0000${r.evidenceEventId}`);
  }
  const kept: D[] = [];
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
  const sorted = REASON_CODE_ORDER.filter((c) => codes.has(c));
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

// ── the pattern rules (WARP-2980 P5 PR-B, spec §4.2) ──────────────────────

/** The three stored cells around the event's hour (h−1, h, h+1 of its day type) and the dwell half of h. */
export interface PatternCells {
  prev: CellCounts | null;
  cur: CellCounts | null;
  next: CellCounts | null;
  dwell: CellDwell;
}

/** One pattern code's hit, with ITS numbers (§4.5: safe integers and exact strings only). */
export interface PatternHit {
  code: PatternCode;
  detail: Record<string, string | number | null>;
}

/**
 * D7: P5-A's functions and nothing else, so a flag never disagrees with the
 * explanation (route 31): out_of_place ⟺ isRare(p); unusual_volume ⟺ λ exists
 * and k is past k* for the event's own slot; long_dwell ⟺ person, ≥ 30
 * samples, longer than max(p99, 120 s). Empty unless the cell is ready (n′ ≥
 * 10). `k` null = volume not judged.
 */
export function patternHits(input: {
  label: string;
  durationSec: number | null;
  slotMinutes: number;
  k: number | null;
  cells: PatternCells;
}): PatternHit[] {
  const { cells } = input;
  const s = smoothCounts(cells.prev, cells.cur, cells.next);
  if (!isReady(s.n)) return [];
  const hits: PatternHit[] = [];
  const p = rarityP(s);
  if (isRare(p)) {
    hits.push({
      code: "out_of_place",
      detail: {
        daysObserved: cells.cur?.daysObserved ?? 0,
        daysWithEvent: cells.cur?.daysWithEvent ?? 0,
        // Multiples of 0.25: exact in binary, so String() is exact.
        smoothedDaysObserved: String(s.n),
        smoothedDaysWithEvent: String(s.d),
        p: p.toPrecision(3),
        flagsBelow: String(RARITY_MAX_P),
      },
    });
  }
  const perHour = hourlyRate(s);
  if (input.k !== null && perHour !== null) {
    const lambda = slotRate(perHour, input.slotMinutes);
    if (wouldFlagVolume(input.k, lambda)) {
      hits.push({
        code: "unusual_volume",
        detail: {
          k: input.k,
          flagsFrom: volumeThreshold(lambda),
          lambda: lambda.toPrecision(3),
          typicalPerHour: perHour.toPrecision(3),
          tailP: poissonUpperTail(input.k, lambda).toExponential(2),
          slotMinutes: input.slotMinutes,
        },
      });
    }
  }
  if (input.durationSec !== null && wouldFlagDwell(input.label, input.durationSec, cells.dwell)) {
    const threshold = dwellThresholdSec(input.label, cells.dwell)!;
    hits.push({
      code: "long_dwell",
      detail: {
        // Math.round is monotone, so the shown duration is never below the shown threshold.
        durationSec: Math.round(input.durationSec),
        p99Sec: Math.round(cells.dwell.durationP99Sec!),
        thresholdSec: Math.round(threshold),
        samples: cells.dwell.dwellSamples,
      },
    });
  }
  return hits;
}

const raise = (s: SecuritySeverity): SecuritySeverity => (s === "info" ? "notice" : "alert");
const minSeverity = (a: SecuritySeverity, b: SecuritySeverity): SecuritySeverity => (SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b);

/**
 * D9, D10: what a pattern flag would carry if it counted. `mode` is the
 * incident's `openedInMode` and `zoneKind` its snapshot (null on a camera key:
 * no area modifier). Base notice; closed/away +1; restricted +1;
 * busier-than-usual at an open entry is info; then the cap — only a person
 * reaches alert, and unusual_volume never does.
 */
export function patternSeverity(code: PatternCode, label: string, mode: SecurityMode, zoneKind: SecurityZoneKind | null): SecuritySeverity {
  const rule = PATTERN_RULES.codes[code].severity;
  let s: SecuritySeverity = rule.base;
  if ((PATTERN_RULES.raiseModes as readonly string[]).includes(mode)) s = raise(s);
  if (zoneKind !== null && (PATTERN_RULES.raiseZoneKinds as readonly string[]).includes(zoneKind)) s = raise(s);
  if ("infoWhen" in rule && mode === rule.infoWhen.mode && zoneKind === rule.infoWhen.zoneKind) s = "info";
  return minSeverity(s, label === "person" ? rule.maxPerson : rule.maxOther);
}

/** A window of `hourCount` hours from `hourFrom`, wrapping past midnight: ((hour − hourFrom + 24) % 24) < hourCount. */
export function hourInWindow(hour: number, hourFrom: number, hourCount: number): boolean {
  return (hour - hourFrom + 24) % 24 < hourCount;
}

/** An expected activity as the match reads it (SecuritySuppression's columns). */
export interface SuppressionMatchRow {
  id: string;
  targetKind: "area" | "camera";
  zoneId: string | null;
  camera: string | null;
  label: string;
  days: "every_day" | "weekdays" | "weekends";
  hourFrom: number;
  hourCount: number;
  codes: readonly SecurityReasonCode[];
  state: "active" | "removed" | "expired";
  createdAt: Date;
  expiresAt: Date;
}

/** The key an expected activity is for: `area:<id>` or `camera:<name>` — the keys flags are judged against. */
export function suppressionKey(row: Pick<SuppressionMatchRow, "targetKind" | "zoneId" | "camera">): string {
  return row.targetKind === "area" ? `area:${row.zoneId}` : `camera:${row.camera}`;
}

/** Where and when a slot is: the key, the label, and the slot's site-local date and hour. */
export interface SuppressionSlot {
  zoneKey: string;
  label: string;
  /** Site-local 'YYYY-MM-DD' of the slot. */
  ymd: string;
  hour: number;
}

/**
 * THE match rule — the engine (`suppressionFor`) and route 31's `expected`
 * both use it (review item 10). True iff it is active and not yet past
 * `expiresAt` (a lagging expiry job never extends one), its key and label are
 * the slot's, the hour is in its window, and its days hold the day the window
 * OPENED: a window past midnight belongs to the day it opens (the site's rule
 * for wrapped hours, ADR §3.6 as built), so "Weekdays, 10 PM–2 AM" covers
 * Friday night's 00–02 tail and not Sunday night's.
 */
export function suppressionCovers(row: SuppressionMatchRow, at: SuppressionSlot, now: Date): boolean {
  if (row.state !== "active" || row.expiresAt.getTime() <= now.getTime()) return false;
  if (suppressionKey(row) !== at.zoneKey || row.label !== at.label) return false;
  if (!hourInWindow(at.hour, row.hourFrom, row.hourCount)) return false;
  if (row.days === "every_day") return true;
  const opened = at.hour < row.hourFrom ? ymdAddDays(at.ymd, -1) : at.ymd;
  const dayType: SecurityDayTypeValue = dayTypeOf(isoWeekdayOf(opened));
  return row.days === "weekdays" ? dayType === "weekday" : dayType === "weekend";
}

/**
 * D11–D13: the expected activity that quiets this flag, or null. Takes a
 * PatternCode only — after_hours_presence cannot reach it by type or by path.
 * The oldest (createdAt, id) match wins, so the choice is deterministic.
 */
export function suppressionFor<R extends SuppressionMatchRow>(
  flag: SuppressionSlot & { code: PatternCode },
  active: readonly R[],
  now: Date,
): R | null {
  const hits = active.filter((r) => r.codes.includes(flag.code) && suppressionCovers(r, flag, now));
  hits.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || byString(a.id, b.id));
  return hits[0] ?? null;
}

/** Why the pattern rules are paused for a key right now (review item 11: the engine and route 31 ask the same questions). */
export type PatternPause = "zone_changed" | "stale_build" | "area_changed" | "camera_not_active";

/**
 * Gates (c) and (d): the ready build serves the rules only when it was cut in
 * the site's zone and its window ends no more than BASELINE.freshWindowDays
 * site dates before today (the patterns health row's out-of-date test).
 */
export function buildPause(zone: string, build: { timezone: string; windowTo: string }, now: Date): "zone_changed" | "stale_build" | null {
  if (build.timezone !== zone) return "zone_changed";
  const today = localPartsOf(now, zone).ymd;
  return build.windowTo < ymdAddDays(today, -PATTERN_RULES.baseline.freshWindowDays) ? "stale_build" : null;
}

/**
 * Gates (f) and (g) for one key's cells: an area's cells were built at its
 * current version (a link edit makes them stale until the area rebuild) and
 * hold the evidence camera; every camera behind the key is `active` — never
 * while one is learning or stale. `liveVersion` null = the area is archived
 * or gone.
 */
export function keyPause(
  key: { kind: "area"; liveVersion: number | null } | { kind: "camera" },
  cell: { zoneVersion: number | null; cameras: readonly string[] },
  cameraState: ReadonlyMap<string, string>,
  evidenceCamera?: string,
): "area_changed" | "camera_not_active" | null {
  if (key.kind === "area" && (key.liveVersion === null || cell.zoneVersion !== key.liveVersion)) return "area_changed";
  if (evidenceCamera !== undefined && !cell.cameras.includes(evidenceCamera)) return "area_changed";
  if (cell.cameras.length === 0 || cell.cameras.some((c) => cameraState.get(c) !== "active")) return "camera_not_active";
  return null;
}
