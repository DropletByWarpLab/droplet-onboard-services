/**
 * WARP-2978 (ADR-059 P3 §8) — the words an incident is shown in, for the
 * Incidents list, the incident page and the /d/security widget. Pure.
 *
 * Two rules:
 *   1. DS-005 — every line is built from what the box sent for THIS viewer:
 *      their visible codes, counts, acknowledgements and notices. Nothing is
 *      inferred or filled in: with no `lastAck` there is no name, with no
 *      measured duration there is no duration, and an unknown code or scope
 *      (a later box) renders a generic line rather than nothing.
 *   2. Every time is SITE time — the zone the caller passes (the mode's
 *      `displayTimezone`, else the device's), never UTC.
 *
 * `INCIDENT_COPY` is plain strings with `{slot}`s filled by `fill()`, so the
 * Security copy lint scans every word.
 *
 * Nothing here reads `labels`: its `_`-keys (`_status`, `_threat`, and PR-D's
 * `_ongoing`) are the box's bookkeeping, never a label. A card counts events
 * (`eventCount`, every row the incident page lists), never people.
 *
 * WARP-2980 (P5 PR-B) — P5's pattern codes are named here by the Patterns
 * page's own words (`PATTERN_NAME`, one copy for both). They reach this page
 * as reasons only once P5 PR-D counts them; their numbers, the Trial chip and
 * the verdict are P5 PR-C's to render.
 */
import { formatSiteTime, formatSiteWhen, siteDateOf } from "@/lib/security-time";
import type {
  IncidentAckView,
  IncidentNoticeView,
  IncidentReasonView,
  IncidentSummary,
  SecurityHealthRow,
  SecurityIncidentState,
  SecurityMode,
  SecurityReasonCode,
  SecuritySeverity,
} from "@/lib/types";
import { PATTERN_NAME } from "./patterns-copy";
import { fill } from "./TimezoneSelect";

export const INCIDENT_COPY = {
  // ── titles and badges ──
  titleThreat: "Network and sign-in",
  titleCameraSystem: "Camera system",
  titleUnknown: "Incident",
  badgeAlert: "Alert",
  badgeNotice: "Notice",

  // ── the card's second line: short names for the codes ──
  codeShort: {
    after_hours_presence: "Someone inside after hours",
    camera_offline: "A camera stopped reporting",
    threat_signal: "A network or sign-in warning",
    // WARP-2979 (P4) — a camera a person linked went quiet right after someone was there.
    camera_offline_during_activity: "A camera stopped reporting after someone was seen",
  },
  codeShortUnknown: "Flagged by Droplet",
  // Under a camera's or the camera system's own title, which camera is already said.
  codeShortStoppedReporting: "Stopped reporting",
  eventOne: "1 event",
  eventMany: "{n} events",

  // ── the card's third line and the page's state chip ──
  needsAttention: "Needs attention",
  acknowledged: "Acknowledged",
  acknowledgedBy: "Acknowledged by {name} at {at}",
  resolved: "Resolved",
  resolvedBy: "Resolved by {name}",
  stillHappening: "Still happening",

  // ── the page header ──
  openedIn: {
    closed: "The site was closed",
    away: "The site was set to away",
    open: "The site was open",
  },

  // ── Why Droplet flagged this ──
  sentenceAfterHoursClosed: "Someone was seen inside while the site was closed",
  sentenceAfterHoursAway: "Someone was seen inside while the site was set to away",
  sentenceCameraOffline: "A camera stopped reporting for more than a minute",
  sentenceCameraSystemOffline: "The camera system stopped reporting for more than a minute",
  sentenceThreat: "A network or sign-in warning",
  // WARP-2979 (p4-spec §6.7.2).
  sentenceDroppedDuringActivityClosed: "A camera covering this area stopped reporting soon after someone was seen here, while the site was closed",
  sentenceDroppedDuringActivityAway: "A camera covering this area stopped reporting soon after someone was seen here, while the site was set to away",
  stoppedAt: "stopped at {at}",
  seenOn: "someone on {camera} at {at}",
  sentenceUnknown: "A reason Droplet flagged",
  modeClosedSchedule: "Closed (opening hours)",
  modeClosedManual: "Closed up",
  modeAway: "Away",
  backAfter: "back after {for}",
  threatSignIn: "Sign-in",
  threatNetwork: "Network",
  labelWords: { person: "Person", car: "Car", dog: "Dog", cat: "Cat" },

  // ── Who was told ──
  noticeSentPhone: "{name} · sent to their phone at {at}",
  noticeSentApp: "{name} · shown in Droplet at {at}",
  noticeSending: "{name} · being sent",
  noticeNotReached: "{name} · not reached: {why}",
  notReachedGate: "phone notifications are turned off on this box",
  notReachedNoPhone: "no phone is set up and Droplet wasn't open",
  notReachedFailed: "the phone notification didn't go through",
  notReachedUnknown: "it couldn't be delivered",
  noticeNoAccess: "{name} · not told: no longer has access to Security",
  noticeNotVisible: "{name} · not told: can't see {cameras}",
  noticeNotVisibleUnknown: "{name} · not told: can't see the camera involved",
  noticeCapped: "{name} · not told: too many alerts in the last hour",
  noticeNoAddress: "{name} · not told: this account can't receive notifications",
  noticeUnknown: "{name} · Droplet can't tell whether it arrived",
  noticeFallback: "told because nobody chosen could be",
  or: " or ",

  // ── Acknowledgements ──
  ackAcknowledged: "{name} acknowledged",
  ackResolved: "{name} resolved",
  ackClient: "{client} (as the device reported it)",
  ackViaNotification: "from the alert notification",
  ackSignInConfirmed: "Sign-in confirmed",
  ackSignInNotConfirmed: "Sign-in not confirmed",
  ackSignInNotRecorded: "No sign-in recorded",

  // ── the empty list ──
  emptyAttention: "Nothing needs attention",
  emptyAttentionBody: "Every source is reporting. Acknowledged and resolved incidents are under All.",
  emptyAll: "No incidents yet",
  emptyAllBody: "Droplet sorts new events into incidents as they happen. Every event is under Everything.",
  emptyPartialBody: "Some sources are quiet or not reporting, so check them under Everything before reading this as a quiet site.",
  emptyNotSorting: "Droplet isn't sorting events into incidents",
  emptyNotListening: "Droplet isn't hearing from your cameras",
  emptyNotCheckingNetwork: "Droplet isn't checking the network and sign-in log",
  emptyNotCheckingHours: "Droplet isn't checking the opening hours",
  emptyUnchecked: "Droplet couldn't check its sources",
  emptyNotReportingBody: "So an empty list here doesn't mean nothing happened. Everything shows each source and what's wrong.",
  emptyNotCovered: "No cameras cover {area} yet",
  emptyNotCoveredBody: "So nothing can show up here. Someone who manages Security can choose which cameras cover it.",
} as const;

/** How long Frigate keeps clips (docker/frigate/config.yml); after it, a clip link would 404. */
export const CLIP_RETENTION_MS = 14 * 86_400_000;

type CameraLabel = (name: string) => string;
type Codes = IncidentSummary["reasonCodes"];

const lowerFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

/**
 * Every code's short name: P3's own, then P5's by the Patterns page's name.
 * Typed as the whole union, so a code added to SecurityReasonCode without a
 * name fails the build rather than reading "Flagged by Droplet".
 */
const CODE_SHORT: Readonly<Record<SecurityReasonCode, string>> = { ...INCIDENT_COPY.codeShort, ...PATTERN_NAME };

function codeShort(code: string): string {
  return (CODE_SHORT as Record<string, string>)[code] ?? INCIDENT_COPY.codeShortUnknown;
}

/** The area's name (its snapshot), the camera's household name, or the site-wide words. */
export function incidentTitle(i: Pick<IncidentSummary, "scope" | "zone" | "camera">, cameraLabel: CameraLabel): string {
  switch (i.scope) {
    case "area":
      return i.zone?.name || INCIDENT_COPY.titleUnknown;
    case "camera":
      return i.camera ? cameraLabel(i.camera) : INCIDENT_COPY.titleUnknown;
    case "site_threat":
      return INCIDENT_COPY.titleThreat;
    case "site_camera_system":
      return INCIDENT_COPY.titleCameraSystem;
    default:
      return INCIDENT_COPY.titleUnknown;
  }
}

/** `Alert` (danger) / `Notice` (warn); plain activity carries no badge. */
export function severityBadge(severity: SecuritySeverity): { cls: string; text: string } | null {
  if (severity === "alert") return { cls: "badge danger", text: INCIDENT_COPY.badgeAlert };
  if (severity === "notice") return { cls: "badge warn", text: INCIDENT_COPY.badgeNotice };
  return null;
}

/** The first and last activity in site time: one time when under a minute apart; the day once when it doesn't change. */
export function spanText(first: string, last: string, tz: string, now: Date): string {
  const a = new Date(first);
  const b = new Date(last);
  const start = formatSiteWhen(a, tz, now);
  if (b.getTime() - a.getTime() < 60_000) return start;
  const end = siteDateOf(a, tz) === siteDateOf(b, tz) ? formatSiteTime(b, tz) : formatSiteWhen(b, tz, now);
  return `${start} – ${end}`;
}

function codesText(codes: Codes, scope: IncidentSummary["scope"]): string {
  const short = (c: string) =>
    c === "camera_offline" && (scope === "camera" || scope === "site_camera_system") ? INCIDENT_COPY.codeShortStoppedReporting : codeShort(c);
  return codes.map((c, n) => (n === 0 ? short(c) : lowerFirst(short(c)))).join(", ");
}

/** Line 2: the visible codes (else the visible event count, never 0), then the span. */
export function whatLine(i: IncidentSummary, tz: string, now: Date): string {
  const what =
    i.reasonCodes.length > 0
      ? codesText(i.reasonCodes, i.scope)
      : i.eventCount === 1
        ? INCIDENT_COPY.eventOne
        : i.eventCount > 1
          ? fill(INCIDENT_COPY.eventMany, { n: String(i.eventCount) })
          : "";
  return [what, spanText(i.firstActivityAt, i.lastActivityAt, tz, now)].filter(Boolean).join(" · ");
}

/** Line 3: the viewer-projected state (with who, only when the box said who), then `Still happening` while collecting. */
export function stateLine(i: IncidentSummary, tz: string, now: Date): string {
  const parts: string[] = [];
  switch (i.state) {
    case "open":
      parts.push(INCIDENT_COPY.needsAttention);
      break;
    case "acknowledged":
      parts.push(
        i.lastAck?.action === "acknowledge"
          ? fill(INCIDENT_COPY.acknowledgedBy, { name: i.lastAck.byName, at: formatSiteWhen(i.lastAck.at, tz, now) })
          : INCIDENT_COPY.acknowledged,
      );
      break;
    case "resolved":
      parts.push(i.lastAck?.action === "resolve" ? fill(INCIDENT_COPY.resolvedBy, { name: i.lastAck.byName }) : INCIDENT_COPY.resolved);
      break;
    default:
      break;
  }
  if (i.grouping === "collecting") parts.push(INCIDENT_COPY.stillHappening);
  return parts.join(" · ");
}

export function openedInLine(mode: SecurityMode): string {
  return (INCIDENT_COPY.openedIn as Record<string, string>)[mode] ?? "";
}

/** The page's state chip. Plain activity has none: there is no state to show (D27). */
export function stateChip(state: SecurityIncidentState, severity: SecuritySeverity): { cls: string; text: string } | null {
  switch (state) {
    case "open":
      return { cls: severity === "alert" ? "badge danger" : "badge warn", text: INCIDENT_COPY.needsAttention };
    case "acknowledged":
      return { cls: "badge info", text: INCIDENT_COPY.acknowledged };
    case "resolved":
      return { cls: "badge ok", text: INCIDENT_COPY.resolved };
    default:
      return null;
  }
}

const detailString = (r: IncidentReasonView, key: string): string | null => {
  const v = r.detail?.[key];
  return typeof v === "string" ? v : null;
};
const detailNumber = (r: IncidentReasonView, key: string): number | null => {
  const v = r.detail?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** One sentence per code. */
export function codeSentence(r: IncidentReasonView): string {
  switch (r.code) {
    case "after_hours_presence":
      return detailString(r, "mode") === "away" ? INCIDENT_COPY.sentenceAfterHoursAway : INCIDENT_COPY.sentenceAfterHoursClosed;
    case "camera_offline":
      return r.evidence.camera === null ? INCIDENT_COPY.sentenceCameraSystemOffline : INCIDENT_COPY.sentenceCameraOffline;
    case "threat_signal":
      return INCIDENT_COPY.sentenceThreat;
    case "camera_offline_during_activity":
      return detailString(r, "mode") === "away"
        ? INCIDENT_COPY.sentenceDroppedDuringActivityAway
        : INCIDENT_COPY.sentenceDroppedDuringActivityClosed;
    case "out_of_place":
    case "unusual_volume":
    case "long_dwell":
      // A counted pattern code (P5 PR-D): its name, as the Patterns page says it.
      return PATTERN_NAME[r.code];
    default:
      return INCIDENT_COPY.sentenceUnknown;
  }
}

function labelWord(label: string | null): string | null {
  if (!label) return null;
  return (INCIDENT_COPY.labelWords as Record<string, string>)[label] ?? label[0]!.toUpperCase() + label.slice(1);
}

function modeWord(r: IncidentReasonView): string | null {
  const mode = detailString(r, "mode");
  if (mode === "away") return INCIDENT_COPY.modeAway;
  if (mode === "closed") return detailString(r, "modeSource") === "manual" ? INCIDENT_COPY.modeClosedManual : INCIDENT_COPY.modeClosedSchedule;
  return null;
}

function duration(sec: number): string {
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

/**
 * The evidence snapshot as one line: `Person · Back camera · 2:14 AM · Closed (opening hours)`.
 * Evidence from a person still in view (PR-D: the alert went out before they
 * left) leads with the box's own words for it — `Person still in view after
 * 30 s · Back camera · 2:14 AM · …`; the time is when they were first seen.
 */
export function evidenceLine(r: IncidentReasonView, cameraLabel: CameraLabel, tz: string, now: Date): string {
  const e = r.evidence;
  const time = formatSiteWhen(e.at, tz, now);
  const camera = e.camera ? cameraLabel(e.camera) : null;
  let parts: Array<string | null>;
  switch (r.code) {
    case "after_hours_presence":
      parts = [(e.kind === "detection_ongoing" && e.summary) || labelWord(e.label), camera, time, modeWord(r)];
      break;
    case "camera_offline": {
      const off = detailNumber(r, "offlineForSec");
      parts = [camera ?? INCIDENT_COPY.titleCameraSystem, time, off !== null ? fill(INCIDENT_COPY.backAfter, { for: duration(off) }) : null];
      break;
    }
    case "threat_signal":
      parts = [e.label === "auth" ? INCIDENT_COPY.threatSignIn : e.label === "network" ? INCIDENT_COPY.threatNetwork : null, e.summary, time];
      break;
    case "camera_offline_during_activity": {
      // `Back camera · stopped at 2:16 AM · someone on Stock cam at 2:15 AM` — the box sends this
      // reason only to a viewer who can see both cameras.
      const activity = r.detail?.activity;
      const seenAt = activity && typeof activity === "object" && typeof activity.at === "string" ? activity.at : null;
      const seenCamera = r.relatedCamera ? cameraLabel(r.relatedCamera) : null;
      parts = [
        camera,
        fill(INCIDENT_COPY.stoppedAt, { at: time }),
        seenAt && seenCamera ? fill(INCIDENT_COPY.seenOn, { camera: seenCamera, at: formatSiteWhen(seenAt, tz, now) }) : null,
      ];
      break;
    }
    case "out_of_place":
    case "unusual_volume":
    case "long_dwell":
      // What was seen, on which camera, when. The numbers behind the flag
      // (`detail`) are P5 PR-C's to word; none is shown raw here.
      parts = [labelWord(e.label), camera, time];
      break;
    default:
      parts = [camera, e.summary, time];
  }
  return parts.filter((p): p is string => Boolean(p)).join(" · ");
}

/** The cameras of the alert-severity evidence the viewer can see, by household name, deduplicated. */
export function alertCameras(reasons: readonly IncidentReasonView[], cameraLabel: CameraLabel): string[] {
  const out: string[] = [];
  for (const r of reasons) {
    if (r.severity !== "alert" || !r.evidence.camera) continue;
    const name = cameraLabel(r.evidence.camera);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** One notice. `cameras`: `alertCameras` of the reasons — what a `skipped_not_visible` recipient couldn't see. */
export function noticeLine(n: IncidentNoticeView, cameras: readonly string[], tz: string, now: Date): string {
  const name = n.name;
  const when = formatSiteWhen(n.settledAt ?? n.createdAt, tz, now);
  let line: string;
  switch (n.outcome) {
    case "sent":
      line = fill(n.channels.split(",").includes("push") ? INCIDENT_COPY.noticeSentPhone : INCIDENT_COPY.noticeSentApp, { name, at: when });
      break;
    case "queued":
      line = fill(INCIDENT_COPY.noticeSending, { name });
      break;
    case "not_sent": {
      const why =
        n.pushOutcome === "refused_gate"
          ? INCIDENT_COPY.notReachedGate
          : n.pushOutcome === "no_subscribers"
            ? INCIDENT_COPY.notReachedNoPhone
            : n.pushOutcome === "failed"
              ? INCIDENT_COPY.notReachedFailed
              : INCIDENT_COPY.notReachedUnknown;
      line = fill(INCIDENT_COPY.noticeNotReached, { name, why });
      break;
    }
    case "skipped_no_access":
      line = fill(INCIDENT_COPY.noticeNoAccess, { name });
      break;
    case "skipped_not_visible":
      line =
        cameras.length > 0
          ? fill(INCIDENT_COPY.noticeNotVisible, { name, cameras: cameras.join(INCIDENT_COPY.or) })
          : fill(INCIDENT_COPY.noticeNotVisibleUnknown, { name });
      break;
    case "skipped_capped":
      line = fill(INCIDENT_COPY.noticeCapped, { name });
      break;
    case "skipped_no_address":
      line = fill(INCIDENT_COPY.noticeNoAddress, { name });
      break;
    case "outcome_unknown":
      line = fill(INCIDENT_COPY.noticeUnknown, { name });
      break;
    default:
      line = name;
  }
  return n.reason === "fallback_owner" ? `${line} · ${INCIDENT_COPY.noticeFallback}` : line;
}

function signInLine(s: IncidentAckView["signIn"] | undefined): string | null {
  if (!s) return null;
  if (!s.recorded) return INCIDENT_COPY.ackSignInNotRecorded;
  return s.confirmedLive ? INCIDENT_COPY.ackSignInConfirmed : INCIDENT_COPY.ackSignInNotConfirmed;
}

/** `Maria acknowledged · 2:17 AM · Droplet for iPhone 1.4 (as the device reported it) · from the alert notification`. The note is shown apart. */
export function ackLine(a: IncidentAckView, tz: string, now: Date): string {
  return [
    fill(a.action === "resolve" ? INCIDENT_COPY.ackResolved : INCIDENT_COPY.ackAcknowledged, { name: a.byName }),
    formatSiteWhen(a.at, tz, now),
    a.client ? fill(INCIDENT_COPY.ackClient, { client: a.client }) : null,
    a.viaNotification ? INCIDENT_COPY.ackViaNotification : null,
    // Owner/admin only: the box sends null to anyone else, and then nothing is said.
    signInLine(a.signIn),
  ]
    .filter((p): p is string => Boolean(p))
    .join(" · ");
}

/** After Frigate's 14 days the clip is gone: the page says so instead of linking to a 404. */
export function clipExpired(startedAt: string, now: Date): boolean {
  return now.getTime() - new Date(startedAt).getTime() > CLIP_RETENTION_MS;
}

export type IncidentsEmptyKind = "not-covered" | "not-reporting" | "partial" | "quiet";

const CAMERA_ROWS: readonly SecurityHealthRow["id"][] = ["camera_ingest", "camera_system"];

/**
 * Which empty an empty incident list is (P2a's rule: "nothing happened" and
 * "nothing is reporting" never look the same). Reads the health rows of what
 * feeds incidents: the incident engine itself, the cameras, and — without an
 * area picked — the opening hours and, for owners and admins, the threat
 * check. A row the list depends on that the header doesn't carry counts as
 * not reporting (a box older than P3 has no `incidents` row).
 */
export function incidentsEmpty(opts: {
  filter: "attention" | "all";
  sources: SecurityHealthRow[] | null;
  healthError: boolean;
  canSeeThreats: boolean;
  area: { name: string; linkCount: number } | null;
}): { kind: IncidentsEmptyKind; head: string; body: string } {
  if (opts.area && opts.area.linkCount === 0) {
    return { kind: "not-covered", head: fill(INCIDENT_COPY.emptyNotCovered, { area: opts.area.name }), body: INCIDENT_COPY.emptyNotCoveredBody };
  }
  if (opts.healthError) return { kind: "not-reporting", head: INCIDENT_COPY.emptyUnchecked, body: INCIDENT_COPY.emptyNotReportingBody };
  const sources = opts.sources ?? [];
  const noCameras = sources.find((s) => s.id === "camera_ingest")?.state === "not_configured";
  const ids: SecurityHealthRow["id"][] = ["incidents", ...(noCameras ? [] : CAMERA_ROWS)];
  if (!opts.area) {
    ids.push("site_mode");
    if (opts.canSeeThreats) ids.push("threat_mirror");
  }
  const rows = ids.map((id) => ({ id, row: sources.find((s) => s.id === id) }));
  const down = rows.find(({ row }) => !row || row.state === "down");
  if (down) {
    const head =
      down.id === "incidents"
        ? INCIDENT_COPY.emptyNotSorting
        : down.id === "threat_mirror"
          ? INCIDENT_COPY.emptyNotCheckingNetwork
          : down.id === "site_mode"
            ? INCIDENT_COPY.emptyNotCheckingHours
            : INCIDENT_COPY.emptyNotListening;
    return { kind: "not-reporting", head, body: INCIDENT_COPY.emptyNotReportingBody };
  }
  const head = opts.filter === "attention" ? INCIDENT_COPY.emptyAttention : INCIDENT_COPY.emptyAll;
  if (!rows.every(({ row }) => row!.state === "ok" || row!.state === "not_configured")) {
    return { kind: "partial", head, body: INCIDENT_COPY.emptyPartialBody };
  }
  return { kind: "quiet", head, body: opts.filter === "attention" ? INCIDENT_COPY.emptyAttentionBody : INCIDENT_COPY.emptyAllBody };
}
