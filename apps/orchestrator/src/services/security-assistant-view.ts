/**
 * WARP-2979 (ADR-059 P4 §6.12.3, §6.12.5, D26) — what the Security chat tools
 * are allowed to say. PURE: every output the assistant routes send is built
 * HERE, field by field, from the dashboard's own projections.
 *
 * WHITELISTED, NEVER PASSED THROUGH. Nothing a person typed or is named by
 * leaves through these builders:
 *   · no acknowledger, resolver, verdict-giver or notice recipient — an
 *     acknowledgement is `{at}` only;
 *   · no stored event `summary`. A `mode_changed` row's summary is "Closed up
 *     by Maria", and a mirrored threat's is the activity log's own text,
 *     which can name an account. `what` is rebuilt from the row's kind and
 *     labels instead;
 *   · no reason `detail` JSON, no Frigate ids, no `sourceRef`s, no scores.
 * The model conflates "acknowledged by Maria" with "Maria was seen" (D26),
 * and Droplet knows that a person was seen, never who.
 *
 * Names that DO appear are places and devices a person chose: area names and
 * camera display names — the same the dashboard shows this viewer.
 *
 * SIZE. The mcp-server bounds a tool result at 8,000 chars
 * (tool-result-bounding.ts); a list cut there loses its cursor. So every
 * list is fitted HERE under `ASSISTANT_BODY_BUDGET` by `fitList`, which
 * drops whole items from the end and hands back where to resume.
 *
 * WARP-2980 (ADR-059 P5 PR-E, spec §6.18) — A5's answer, "what normal looks
 * like" for one place, is built here too, from PR-A's `ExplainPatternView`:
 *   · the numbers are that view's, never recomputed — so what the assistant
 *     says can never disagree with a flag or with the Patterns page;
 *   · expected activity is plain words built from its CODES — never the
 *     reason a person typed ("Maria restocks at night") or who set it;
 *   · the view's own camera list and learning rows stay behind: the answer
 *     names the place, not the cameras (A4 already says what covers it).
 */
import type { SecurityEventKind, SecurityIncidentScope, SecurityIncidentState, SecurityReasonCode, SecuritySeverity, SecurityZoneKind } from "@prisma/client";
import { assistantInstant } from "../lib/security-assistant-period.js";
import { PATTERN_CODES, type PatternCode, type PatternRelease } from "../lib/security-baseline-math.js";
import type { ExplainPatternView } from "./security-patterns-read.js";

/** Leaves the tool's `type` and the transport's framing room under the 8,000-char tool cap. */
export const ASSISTANT_BODY_BUDGET = 7_400;

export type AssistantInstant = ReturnType<typeof assistantInstant>;

/** Plain words for a reason code: what is TRUE, never a guess about who or why. */
export const CODE_SENTENCE: Readonly<Record<SecurityReasonCode, string>> = {
  after_hours_presence: "A person was seen while the site was closed or set to away",
  camera_offline: "A camera stopped reporting",
  threat_signal: "A network or sign-in warning",
  camera_offline_during_activity: "A camera stopped reporting soon after a person was seen there while the site was closed or away",
  // P5's pattern codes never reach an incident's reasons yet (trial only); the words are here so a later build cannot send a bare code.
  out_of_place: "Activity at a place and time Droplet does not usually see",
  unusual_volume: "More activity than Droplet usually sees here",
  long_dwell: "Someone stayed longer than Droplet usually sees here",
};

/** The dashboard's area types, in plain words (AreaDialog's KIND_LABEL). */
export const ZONE_KIND_WORD: Readonly<Record<SecurityZoneKind, string>> = {
  entry: "way in",
  interior: "inside",
  perimeter: "outside",
  parking: "parking",
  restricted: "staff only",
};

export const TITLE_THREAT = "Network and sign-in";
export const TITLE_CAMERA_SYSTEM = "Camera system";

/** The kinds a tool names (§6.12.3), each covering the stored kinds it means. */
export const ASSISTANT_EVENT_KINDS = {
  detection: ["detection"],
  camera_offline: ["camera_offline", "source_offline"],
  camera_online: ["camera_online", "source_online"],
  threat: ["threat"],
  mode_changed: ["mode_changed"],
} as const satisfies Record<string, readonly SecurityEventKind[]>;
export type AssistantEventKind = keyof typeof ASSISTANT_EVENT_KINDS;

/**
 * Every stored kind a tool may return. `detection_low` never (below the
 * gate); `detection_ongoing` never either — the person's own `detection` row
 * is the record, and counting both would read as two people. Whether an
 * incident is still happening is its own field.
 */
export const ASSISTANT_STORED_KINDS: readonly SecurityEventKind[] = Object.values(ASSISTANT_EVENT_KINDS).flat();

const KIND_OF: Partial<Record<SecurityEventKind, AssistantEventKind>> = Object.fromEntries(
  Object.entries(ASSISTANT_EVENT_KINDS).flatMap(([name, kinds]) => kinds.map((k) => [k, name as AssistantEventKind])),
);

const MODE_WORD: Readonly<Record<string, string>> = { open: "open", closed: "closed", away: "away" };

/**
 * What happened, from the row's kind and labels only — never its stored
 * summary (see the header). Threat rows say which log they came from.
 */
export function eventWhat(kind: string, labels: readonly string[], camera: string | null): string {
  switch (kind) {
    case "detection":
    case "detection_ongoing":
    case "detection_low":
      return `${labels[0] ?? "something"} seen`;
    case "camera_offline":
      return "camera stopped reporting";
    case "camera_online":
      return "camera reporting again";
    case "source_offline":
      return "camera system stopped reporting";
    case "source_online":
      return "camera system reporting again";
    case "threat":
      return labels[0] === "auth" ? "sign-in warning" : "network warning";
    case "mode_changed":
      return `site set to ${MODE_WORD[labels[0] ?? ""] ?? "a new mode"}`;
    default:
      void camera;
      return "activity";
  }
}

/** Who reported it: the camera's display name, or the site-wide source in words. */
export function eventSource(kind: string, camera: string | null, cameraLabels: ReadonlyMap<string, string>): string {
  if (camera) return cameraLabels.get(camera) ?? camera;
  if (kind === "threat") return TITLE_THREAT;
  if (kind === "mode_changed") return "Site mode";
  return TITLE_CAMERA_SYSTEM;
}

export function assistantKindOf(kind: string): AssistantEventKind | null {
  return KIND_OF[kind as SecurityEventKind] ?? null;
}

/** The incident's heading: its area, its camera, or the site-wide source. */
export function incidentTitle(
  i: { scope: SecurityIncidentScope; zone: { name: string } | null; camera: string | null },
  cameraLabels: ReadonlyMap<string, string>,
): string {
  if (i.scope === "site_threat") return TITLE_THREAT;
  if (i.scope === "site_camera_system") return TITLE_CAMERA_SYSTEM;
  if (i.zone) return i.zone.name;
  if (i.camera) return cameraLabels.get(i.camera) ?? i.camera;
  return "Incident";
}

/** Severity in the words the descriptions use: alert, notice, or plain activity. */
export function severityWord(s: SecuritySeverity): "alert" | "notice" | "activity" {
  return s === "info" ? "activity" : s;
}

/** State with no names: open, acknowledged, resolved, or plain activity. */
export function stateWord(s: SecurityIncidentState): "open" | "acknowledged" | "resolved" | "activity" {
  return s === "no_action" ? "activity" : s;
}

export function codesOut(codes: readonly SecurityReasonCode[]): Array<{ code: SecurityReasonCode; sentence: string }> {
  return codes.map((code) => ({ code, sentence: CODE_SENTENCE[code] }));
}

export function incidentUrl(id: string): string {
  return `/security/incidents/${id}`;
}

/** Case-insensitive, trimmed — the `lower(btrim())` rule the area and camera filters use. */
export function nameKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Keep whole items from the front while `wrap(items)` serialises within
 * `budget`. Returns the kept count; the caller resumes after the last kept
 * item. Always keeps at least one item when there is one: a single item is
 * bounded by its own field limits, and an answer of nothing with a cursor
 * would read as "nothing happened".
 */
export function fitList<T>(items: readonly T[], wrap: (kept: readonly T[]) => unknown, budget = ASSISTANT_BODY_BUDGET): number {
  let n = items.length;
  while (n > 1 && JSON.stringify(wrap(items.slice(0, n))).length > budget) n--;
  return n;
}

// ── A5 (WARP-2980 PR-E): what normal looks like ─────────────────────────────

/** `usual: null` because the person may not see every camera behind the place (spec §6.13, D22). */
export const PATTERN_WHY_HIDDEN = "not all cameras visible";
/** `usual: null` because the ready build kept no cells for this label at this place. */
export const PATTERN_WHY_NO_CELL = "nothing learned for this label here";

/** What expected activity holds back, in words — the three pattern codes, and only those. */
const PATTERN_FLAG_WORDS: Readonly<Record<PatternCode, string>> = {
  out_of_place: "not usually seen here",
  unusual_volume: "busier than usual",
  long_dwell: "staying longer than usual",
};

export interface PatternAnswer {
  timezone: string | null;
  at: AssistantInstant;
  place: { name: string; kind: "area" | "camera" };
  learning: { state: "learning" | "ready" | "out_of_date"; daysObserved: number; daysNeeded: 14 } | null;
  usual: {
    seenOnDays: number;
    ofDays: number;
    around: string;
    dayType: "weekdays" | "weekends";
    typicalPerHour: number | null;
    longestUsualVisitSec: number | null;
    enoughData: boolean;
  } | null;
  why: typeof PATTERN_WHY_HIDDEN | typeof PATTERN_WHY_NO_CELL | null;
  wouldFlag: { notUsual: boolean; busierFrom: number | null } | null;
  expected: Array<{ text: string; until: AssistantInstant }>;
  /** Expected-activity rules left out to stay under the tool cap. */
  moreExpected: number;
  /** False while any pattern code is still in trial: Droplet raises none of these flags yet. */
  live: boolean;
}

/** "2 AM", "12 PM": an hour of the site's day. */
export function hourWord(hour: number): string {
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "AM" : "PM"}`;
}

/** One expected-activity rule in whitelisted words: what it holds back — never the reason a person typed, never who. */
export function expectedWords(codes: readonly PatternCode[]): string {
  const words = PATTERN_CODES.filter((c) => codes.includes(c)).map((c) => PATTERN_FLAG_WORDS[c]);
  if (words.length === 0) return "A person marked this as expected";
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
  return `A person marked this as expected: Droplet won't flag it as ${list}`;
}

/** True only once every pattern code is live (P5 PR-D): until then the flags are measured, never raised. */
export function patternsLive(release: Readonly<Record<PatternCode, PatternRelease>>): boolean {
  return PATTERN_CODES.every((c) => release[c] === "live");
}

/**
 * How far along the place is. The slowest camera decides (an area's flags
 * need every camera behind it active); a place the engine pauses for an old
 * build, a zone change, an area edit or a camera gone quiet is out of date.
 */
export function patternLearning(view: Pick<ExplainPatternView, "key" | "sources" | "paused">): NonNullable<PatternAnswer["learning"]> {
  const daysObserved = view.sources.length > 0 ? Math.min(...view.sources.map((s) => s.daysObserved)) : 0;
  const outOfDate = (view.paused !== null && view.paused !== "camera_not_active") || view.sources.some((s) => s.state === "stale");
  const learning = view.sources.length < view.key.cameras.length || view.sources.some((s) => s.state !== "active");
  return { state: outOfDate ? "out_of_date" : learning ? "learning" : "ready", daysObserved, daysNeeded: 14 };
}

/** A5's answer from the acting person's own explanation (they see every camera behind the place). */
export function patternAnswer(view: ExplainPatternView, now: Date): PatternAnswer {
  const tz = view.at.timezone;
  const cell = view.cell;
  const expected = view.expected.map((e) => ({ text: expectedWords(e.codes), until: assistantInstant(new Date(e.until), tz, now) }));
  const answer = (kept: PatternAnswer["expected"]): PatternAnswer => ({
    timezone: tz,
    at: assistantInstant(new Date(view.at.instant), tz, now),
    place: { name: view.key.name, kind: view.key.kind },
    learning: patternLearning(view),
    usual: cell
      ? {
          seenOnDays: cell.daysWithEvent,
          ofDays: cell.daysObserved,
          around: hourWord(view.at.hour),
          dayType: view.at.dayType === "weekday" ? "weekdays" : "weekends",
          typicalPerHour: cell.volume.typicalPerHour === null ? null : Number(cell.volume.typicalPerHour.toPrecision(2)),
          longestUsualVisitSec: cell.dwell.longestUsualVisitSec,
          enoughData: cell.ready,
        }
      : null,
    why: cell ? null : PATTERN_WHY_NO_CELL,
    wouldFlag: cell ? { notUsual: cell.rarity.wouldFlag, busierFrom: cell.volume.flagsFrom } : null,
    expected: kept,
    moreExpected: expected.length - kept.length,
    live: patternsLive(view.release),
  });
  return answer(expected.slice(0, fitList(expected, (kept) => answer([...kept]))));
}

/**
 * A5's answer for an area the person sees through at least one camera but
 * not every one behind it: the place, and nothing derived from the cameras
 * they cannot see — no numbers, no learning, no expected activity (DS-005 on
 * derived numbers, D22).
 */
export function hiddenPatternAnswer(
  name: string,
  at: Date,
  tz: string | null,
  release: Readonly<Record<PatternCode, PatternRelease>>,
  now: Date,
): PatternAnswer {
  return {
    timezone: tz,
    at: assistantInstant(at, tz, now),
    place: { name, kind: "area" },
    learning: null,
    usual: null,
    why: PATTERN_WHY_HIDDEN,
    wouldFlag: null,
    expected: [],
    moreExpected: 0,
    live: patternsLive(release),
  };
}
