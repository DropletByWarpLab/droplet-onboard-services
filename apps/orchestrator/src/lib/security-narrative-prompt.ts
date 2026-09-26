/**
 * WARP-2979 (ADR-059 P4 §6.8, DS-007) — what Droplet's "Summary by Droplet"
 * is written FROM, and the instructions it is written under. Pure.
 *
 * One incident per call, never several (D16: a shared prompt could carry one
 * incident's time or place into another's summary, and could not respect
 * DS-005 per incident). The user message is exactly
 * `JSON.stringify(input)`; the system prompt is v1's, verbatim.
 *
 * The input is built from structured rows only, and only from the columns
 * named here — so a person's name cannot reach it by accident:
 *   · codes first (alert before notice), each with the incident page's own
 *     sentence and a few facts as strings or integers;
 *   · events: every evidence event first, then the other members in time
 *     order, at most NARRATIVE_MAX_EVENTS; the JSON at most
 *     NARRATIVE_INPUT_MAX_CHARS — over it, members go from the middle
 *     outward (the start and the end of what happened stay), then evidence
 *     from the end;
 *   · times in the site's own zone (`siteClockCopy`), else none at all —
 *     never UTC as a stand-in for "unknown" (P2b §6.4);
 *   · names: the area's snapshot name, cameras' display names;
 *   · NEVER: people's names (acknowledgers, who set the mode, display names,
 *     usernames), user ids, event ids, Frigate ids, `sourceRef`s, URLs,
 *     scores, thumbnails, clips or any image.
 *
 * The audience (§6.11.3) is everything the text could name: every camera of
 * the incident and of its reasons (the counts cover them all), whether it is
 * about network and sign-in warnings, and whether a lock is named (P4 PR-4).
 * A viewer who cannot see all of it never gets the summary.
 *
 * The version is pinned with the prompt and the schema id by
 * narrative-prompt-fingerprint.test.ts.
 */
import type {
  Prisma,
  SecurityEventKind,
  SecurityEventSource,
  SecurityIncidentScope,
  SecurityMode,
  SecurityReasonCode,
  SecuritySeverity,
  SecurityZoneKind,
} from "@prisma/client";
import { stripUnsafeDisplayChars } from "../services/security-audit.js";
import { siteClockCopy } from "./security-hours.js";
import { REASON_CODE_ORDER } from "./security-rules.js";
import { localPartsOf } from "./zoned-time.js";

export const SECURITY_NARRATIVE_PROMPT_VERSION = 1;

/** v1, verbatim (p4-spec §6.8). A change needs a version bump (the fingerprint test). */
export const SECURITY_NARRATIVE_SYSTEM_PROMPT = [
  "You write a short factual summary of one security incident for the owner of a small business or a home.",
  "Use only the facts in the JSON you are given. Add nothing that is not in it.",
  "Rules:",
  "- Two to four plain sentences, under 600 characters. No lists, no headings, no markdown.",
  '- Say "someone" or "a person". Never name, guess or describe who anyone was, or why they were there.',
  "- Use the times exactly as written in the JSON. Do not convert, round or invent times. If the JSON has no times, give none.",
  "- Use place, camera and lock names exactly as written in the JSON.",
  '- "codes" are the reasons Droplet flagged this incident. Do not contradict them and do not add reasons.',
  "- If an event says it was found when Droplet checked, say that; do not give it as the moment it happened.",
  "- Do not give advice. Do not say the site is safe, secure, protected, monitored or guarded.",
  "Write only the summary.",
].join("\n");

/** The input contract's shape, as the model is told it by example. Part of the fingerprint. */
export const NARRATIVE_INPUT_SCHEMA_ID =
  "NarrativeInputV1{v:1,place:{name,kind:way in|inside|outside|parking|staff only}|null," +
  "scope:area|camera|network and sign-in|camera system,day|null,siteMode:open|closed|away," +
  "modeSetBy:opening hours|by hand|null,codes:[{code,sentence,facts}]," +
  "events:[{at|null,until|null,what,source,part|null,found:live|when Droplet checked}]," +
  "counts:{events,shown},times:[string]}";

export const NARRATIVE_MAX_EVENTS = 20;
export const NARRATIVE_INPUT_MAX_CHARS = 3_600;

export type NarrativePlaceKind = "way in" | "inside" | "outside" | "parking" | "staff only";
export type NarrativeScope = "area" | "camera" | "network and sign-in" | "camera system";

export interface NarrativeEvent {
  /** "2:14 AM" in the site zone, or null (no zone). */
  at: string | null;
  until: string | null;
  /** person | car | dog | cat | another detection label as Frigate names it | a status or warning phrase. */
  what: string;
  /** The camera's display name, "the camera system" or "the network". */
  source: string;
  /** The part of the camera's view (Frigate zone keys), e.g. "the 'till' part of the view". */
  part: string | null;
  /** Lock rows read on a poll are "when Droplet checked" (P4 PR-4); everything else is live. */
  found: "live" | "when Droplet checked";
}

export interface NarrativeCode {
  code: SecurityReasonCode;
  sentence: string;
  facts: Record<string, string | number>;
}

export interface NarrativeInputV1 {
  v: 1;
  place: { name: string; kind: NarrativePlaceKind } | null;
  scope: NarrativeScope;
  /** "Tuesday 22 September" in the site zone; null with no zone. */
  day: string | null;
  siteMode: SecurityMode;
  /** How the mode the incident opened in was set — never who. Null when that is not known. */
  modeSetBy: "opening hours" | "by hand" | null;
  codes: NarrativeCode[];
  events: NarrativeEvent[];
  counts: { events: number; shown: number };
  /** Every clock string in the input, for the output check. */
  times: string[];
}

/** Everything the text could name (§6.11.3). Stored as `SecurityIncident.narrativeAudience`. */
export interface NarrativeAudience {
  cameras: string[];
  threats: boolean;
  locks: boolean;
}

/** The incident columns the builder reads, and no others. */
export interface NarrativeIncidentRow {
  scope: SecurityIncidentScope;
  zoneName: string | null;
  zoneKind: SecurityZoneKind | null;
  scopeCamera: string | null;
  openedInMode: SecurityMode;
  firstActivityAt: Date;
  eventCount: number;
  cameras: readonly string[];
}

/** The reason columns the builder reads. */
export interface NarrativeReasonRow {
  code: SecurityReasonCode;
  severity: SecuritySeverity;
  evidenceEventId: bigint | string;
  evidenceCamera: string | null;
  evidenceKind: SecurityEventKind;
  evidenceLabel: string | null;
  evidenceAt: Date;
  detail: Prisma.JsonValue | unknown;
  relatedCamera: string | null;
  relatedLock: boolean;
}

/** A member event's columns the builder reads (`sourceRef` only to pair a person's two rows — never output). */
export interface NarrativeMemberRow {
  id: bigint | string;
  source: SecurityEventSource;
  sourceRef: string;
  kind: SecurityEventKind;
  camera: string | null;
  labels: readonly string[];
  cameraZones: readonly string[];
  startedAt: Date;
  endedAt: Date | null;
}

export interface NarrativeSource {
  incident: NarrativeIncidentRow;
  reasons: readonly NarrativeReasonRow[];
  /** The loaded members, any order. */
  members: readonly NarrativeMemberRow[];
  /** How the mode at the first activity was set, from the mode history; null when not known. */
  modeSource: "schedule" | "manual" | null;
  /** Frigate camera name → display name. */
  cameraLabels: ReadonlyMap<string, string>;
  /** The site's zone (`resolveSecurityTimezone`), or null: then no times at all. */
  tz: string | null;
}

const PLACE_KIND: Readonly<Record<SecurityZoneKind, NarrativePlaceKind>> = {
  entry: "way in",
  interior: "inside",
  perimeter: "outside",
  parking: "parking",
  restricted: "staff only",
};

const SCOPE: Readonly<Record<SecurityIncidentScope, NarrativeScope>> = {
  area: "area",
  camera: "camera",
  site_threat: "network and sign-in",
  site_camera_system: "camera system",
};

const SEVERITY_RANK: Readonly<Record<SecuritySeverity, number>> = { info: 0, notice: 1, alert: 2 };
const WEEKDAY_LONG = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
/** A detection label as Frigate names it, passed through as a word; anything else reads as "something". */
const PLAIN_LABEL = /^[a-z][a-z _-]{0,30}$/;

// The incident page's own sentences (web-dashboard incident-copy.ts `codeSentence`), word for word — pinned by the test.
const SENTENCE = {
  afterHoursClosed: "Someone was seen inside while the site was closed",
  afterHoursAway: "Someone was seen inside while the site was set to away",
  cameraOffline: "A camera stopped reporting for more than a minute",
  cameraSystemOffline: "The camera system stopped reporting for more than a minute",
  threat: "A network or sign-in warning",
  droppedDuringActivityClosed: "A camera covering this area stopped reporting soon after someone was seen here, while the site was closed",
  droppedDuringActivityAway: "A camera covering this area stopped reporting soon after someone was seen here, while the site was set to away",
  outOfPlace: "Not usual at this time",
  unusualVolume: "Busier than usual",
  longDwell: "Stayed longer than usual",
} as const;

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One sentence per code — the incident page's words. */
export function codeSentence(code: SecurityReasonCode, detail: unknown, evidenceCamera: string | null): string {
  const mode = str(asRecord(detail).mode);
  switch (code) {
    case "after_hours_presence":
      return mode === "away" ? SENTENCE.afterHoursAway : SENTENCE.afterHoursClosed;
    case "camera_offline":
      return evidenceCamera === null ? SENTENCE.cameraSystemOffline : SENTENCE.cameraOffline;
    case "threat_signal":
      return SENTENCE.threat;
    case "camera_offline_during_activity":
      return mode === "away" ? SENTENCE.droppedDuringActivityAway : SENTENCE.droppedDuringActivityClosed;
    case "out_of_place":
      return SENTENCE.outOfPlace;
    case "unusual_volume":
      return SENTENCE.unusualVolume;
    case "long_dwell":
      return SENTENCE.longDwell;
  }
}

/** A display name made safe to put in front of a model and on a page. */
const clean = (s: string): string => stripUnsafeDisplayChars(s).trim();

function cameraName(camera: string, labels: ReadonlyMap<string, string>): string {
  return clean(labels.get(camera) ?? camera) || clean(camera);
}

function modeSetBy(source: unknown): "opening hours" | "by hand" | null {
  return source === "schedule" ? "opening hours" : source === "manual" ? "by hand" : null;
}

/** "closed (opening hours)" / "away (by hand)" / "closed". */
function modeFact(detail: Record<string, unknown>): string | null {
  const mode = str(detail.mode);
  if (mode !== "closed" && mode !== "away" && mode !== "open") return null;
  const by = modeSetBy(detail.modeSource);
  return by ? `${mode} (${by})` : mode;
}

function day(instant: Date, tz: string): string {
  const p = localPartsOf(instant, tz);
  const [, month, date] = p.ymd.split("-").map(Number);
  return `${WEEKDAY_LONG[p.isoWeekday]} ${date} ${MONTH_LONG[month! - 1]}`;
}

function partOf(zones: readonly string[]): string | null {
  const keys = zones.map(clean).filter((z) => z.length > 0);
  if (keys.length === 0) return null;
  if (keys.length === 1) return `the '${keys[0]}' part of the view`;
  return `the ${keys
    .slice(0, -1)
    .map((k) => `'${k}'`)
    .join(", ")} and '${keys[keys.length - 1]}' parts of the view`;
}

/** What happened, in plain words; null for a row a summary never names (mode changes, low detections). */
function whatOf(kind: SecurityEventKind, labels: readonly string[]): string | null {
  switch (kind) {
    case "detection":
    case "detection_ongoing": {
      const label = (labels[0] ?? "").toLowerCase();
      return PLAIN_LABEL.test(label) ? label : "something";
    }
    case "camera_offline":
      return "camera stopped reporting";
    case "camera_online":
      return "camera back";
    case "source_offline":
      return "camera system stopped";
    case "source_online":
      return "camera system back";
    case "threat":
      return "network or sign-in warning";
    case "detection_low":
    case "mode_changed":
      return null;
  }
}

function sourceOf(kind: SecurityEventKind, camera: string | null, labels: ReadonlyMap<string, string>): string {
  if (kind === "threat") return "the network";
  if (kind === "source_offline" || kind === "source_online" || camera === null) return "the camera system";
  return cameraName(camera, labels);
}

function eventOf(row: NarrativeMemberRow, src: NarrativeSource): NarrativeEvent | null {
  const what = whatOf(row.kind, row.labels);
  if (what === null) return null;
  const at = src.tz ? siteClockCopy(row.startedAt, src.tz) : null;
  const end = src.tz && row.endedAt && row.endedAt.getTime() > row.startedAt.getTime() ? siteClockCopy(row.endedAt, src.tz) : null;
  return {
    at,
    until: end !== null && end !== at ? end : null,
    what,
    source: sourceOf(row.kind, row.camera, src.cameraLabels),
    part: row.kind === "detection" || row.kind === "detection_ongoing" ? partOf(row.cameraZones) : null,
    found: "live",
  };
}

/** The reasons in the codes' order: alert before notice, then the enum's order, then evidence time. */
function orderedReasons(reasons: readonly NarrativeReasonRow[]): NarrativeReasonRow[] {
  const rank = (c: SecurityReasonCode) => REASON_CODE_ORDER.indexOf(c);
  return [...reasons].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      rank(a.code) - rank(b.code) ||
      a.evidenceAt.getTime() - b.evidenceAt.getTime() ||
      String(a.evidenceEventId).localeCompare(String(b.evidenceEventId)),
  );
}

function factsOf(r: NarrativeReasonRow, src: NarrativeSource): Record<string, string | number> {
  const d = asRecord(r.detail);
  const facts: Record<string, string | number> = {};
  const offline = d.offlineForSec;
  const offlineSec = typeof offline === "number" && Number.isSafeInteger(offline) && offline >= 0 ? offline : null;
  switch (r.code) {
    case "after_hours_presence": {
      const m = modeFact(d);
      if (m) facts.mode = m;
      break;
    }
    case "camera_offline":
      facts.camera = r.evidenceCamera ? cameraName(r.evidenceCamera, src.cameraLabels) : "the camera system";
      if (offlineSec !== null) facts.offlineForSec = offlineSec;
      break;
    case "threat_signal": {
      const kind = str(d.kind) ?? r.evidenceLabel;
      facts.warning = kind === "auth" ? "sign-in" : kind === "network" ? "network" : "network or sign-in";
      break;
    }
    case "camera_offline_during_activity": {
      const m = modeFact(d);
      if (m) facts.mode = m;
      if (r.evidenceCamera) facts.camera = cameraName(r.evidenceCamera, src.cameraLabels);
      if (offlineSec !== null) facts.offlineForSec = offlineSec;
      if (r.relatedCamera) facts.seenOn = cameraName(r.relatedCamera, src.cameraLabels);
      const seenAt = str(asRecord(d.activity).at);
      const seen = seenAt ? new Date(seenAt) : null;
      if (src.tz && seen && Number.isFinite(seen.getTime())) facts.seenAt = siteClockCopy(seen, src.tz);
      break;
    }
    default:
      break;
  }
  return facts;
}

const CLOCK_FACTS = ["seenAt"] as const;

function timesOf(codes: readonly NarrativeCode[], events: readonly NarrativeEvent[]): string[] {
  const out: string[] = [];
  const add = (t: string | null | undefined) => {
    if (t && !out.includes(t)) out.push(t);
  };
  for (const e of events) {
    add(e.at);
    add(e.until);
  }
  for (const c of codes) for (const k of CLOCK_FACTS) add(typeof c.facts[k] === "string" ? (c.facts[k] as string) : null);
  return out;
}

/** The input for one incident, and who may read what it produces. */
export function buildNarrativeInput(src: NarrativeSource): { input: NarrativeInputV1; audience: NarrativeAudience } {
  const i = src.incident;
  const reasons = orderedReasons(src.reasons);

  // Codes: one entry per code, from its first reason in the codes' order.
  const codes: NarrativeCode[] = [];
  for (const r of reasons) {
    if (codes.some((c) => c.code === r.code)) continue;
    codes.push({ code: r.code, sentence: codeSentence(r.code, r.detail, r.evidenceCamera), facts: factsOf(r, src) });
  }

  // Members: a person still in view (PR-D) whose finished row is also here is that row.
  const finished = new Set(src.members.filter((m) => m.kind === "detection" && m.source === "frigate").map((m) => m.sourceRef));
  const members = src.members.filter((m) => !(m.kind === "detection_ongoing" && finished.has(m.sourceRef)));
  const byId = new Map(members.map((m) => [String(m.id), m]));

  // Evidence first (the loaded row when there is one, else the reason's snapshot), once each.
  const evidenceIds = new Set<string>();
  const evidence: NarrativeEvent[] = [];
  for (const r of reasons) {
    const id = String(r.evidenceEventId);
    if (evidenceIds.has(id)) continue;
    evidenceIds.add(id);
    const row: NarrativeMemberRow = byId.get(id) ?? {
      id,
      source: "frigate",
      sourceRef: "",
      kind: r.evidenceKind,
      camera: r.evidenceCamera,
      labels: r.evidenceLabel ? [r.evidenceLabel] : [],
      cameraZones: [],
      startedAt: r.evidenceAt,
      endedAt: null,
    };
    const e = eventOf(row, src);
    if (e) evidence.push(e);
  }
  const rest = members
    .filter((m) => !evidenceIds.has(String(m.id)))
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))
    .map((m) => eventOf(m, src))
    .filter((e): e is NarrativeEvent => e !== null);

  const keptEvidence = evidence.slice(0, NARRATIVE_MAX_EVENTS);
  let others = trimMiddle(rest, NARRATIVE_MAX_EVENTS - keptEvidence.length);

  const place = i.scope === "area" && i.zoneName && i.zoneKind ? { name: clean(i.zoneName), kind: PLACE_KIND[i.zoneKind] } : null;
  const reasonMode = reasons.map((r) => asRecord(r.detail).modeSource).find((s) => s === "schedule" || s === "manual");
  const build = (ev: NarrativeEvent[]): NarrativeInputV1 => ({
    v: 1,
    place,
    scope: SCOPE[i.scope],
    day: src.tz ? day(i.firstActivityAt, src.tz) : null,
    siteMode: i.openedInMode,
    modeSetBy: modeSetBy(reasonMode ?? src.modeSource),
    codes,
    events: ev,
    counts: { events: Math.max(i.eventCount, ev.length), shown: ev.length },
    times: timesOf(codes, ev),
  });

  // Size: members from the middle outward, then evidence from the end.
  let ev = [...keptEvidence, ...others];
  let input = build(ev);
  while (JSON.stringify(input).length > NARRATIVE_INPUT_MAX_CHARS && ev.length > 0) {
    if (others.length > 0) others = trimMiddle(others, others.length - 1);
    else keptEvidence.pop();
    ev = [...keptEvidence, ...others];
    input = build(ev);
  }

  const cameras = new Set<string>(i.cameras);
  for (const r of src.reasons) {
    if (r.evidenceCamera) cameras.add(r.evidenceCamera);
    if (r.relatedCamera) cameras.add(r.relatedCamera);
  }
  for (const m of src.members) if (m.camera) cameras.add(m.camera);
  const audience: NarrativeAudience = {
    cameras: [...cameras].sort(),
    threats: i.scope === "site_threat" || src.reasons.some((r) => r.evidenceKind === "threat") || src.members.some((m) => m.kind === "threat"),
    locks: src.reasons.some((r) => r.relatedLock),
  };
  return { input, audience };
}

/** At most `n` of `xs`, dropping from the middle outward: the first and the last stay longest. */
function trimMiddle<T>(xs: readonly T[], n: number): T[] {
  if (n <= 0) return [];
  if (xs.length <= n) return [...xs];
  const head = Math.ceil(n / 2);
  const tail = n - head;
  return [...xs.slice(0, head), ...(tail > 0 ? xs.slice(xs.length - tail) : [])];
}
