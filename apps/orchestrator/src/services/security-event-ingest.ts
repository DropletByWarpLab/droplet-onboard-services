/**
 * WARP-2977 (ADR-059 §3.2–3.3) — turn what the sources say into
 * `SecurityEvent` rows. Pure: no Prisma, no MQTT, no clock. The writer
 * (`security-events.service.ts`) owns persistence; this file owns meaning.
 *
 * Three sources in P2:
 *   · Frigate detections, persisted on `end` — one row per tracked object,
 *     carrying its whole life (start, end, best score, zones entered).
 *   · Frigate per-camera health, `frigate/<camera>/status/detect`, plus
 *     Frigate's own LWT `frigate/available`. Only TRANSITIONS are events.
 *   · warn/err `network` and `auth` ActivityRows, mirrored (the rows
 *     `list_threat_events` already treats as the threat feed).
 *
 * 🔴 Ingest reads the RAW Frigate message, never `processCameraEvent`'s
 * decision. That gate rate-limits toasts and push: it drops a second person
 * while the first is still being tracked (`drop_active`) and anything inside
 * the 5 s cooldown, and the `end` of a dropped event then arrives as
 * `drop_stale`. Persisting behind the gate would silently lose exactly the
 * busy moments a command center exists to show.
 */

/** ADR-059 §3.3 detection gate. Below either, the row is kept as `detection_low`. */
export const SECURITY_MIN_SCORE = 0.7;
export const SECURITY_MIN_DURATION_SEC = 2;

/**
 * Mirrors the Prisma `SecurityEventSource` enum. `site_mode` (WARP-2977 P2b)
 * rows are written in-transaction by the site-mode service, never through
 * `recordSecurityEvent`; the union carries them so every reader of a stored
 * row is exhaustive over what the store can hold.
 */
export type SecurityEventSource = "frigate" | "frigate_status" | "activity_mirror" | "site_mode";

export type SecurityEventKind =
  | "detection"
  | "detection_low"
  | "camera_offline"
  | "camera_online"
  | "source_offline"
  | "source_online"
  | "threat"
  /** WARP-2977 P2b — the site mode changed. labels = [mode, modeSource]; site-wide (camera null). */
  | "mode_changed";

export type SecuritySeverity = "info" | "notice" | "alert";

/** One row's worth of `SecurityEvent`, before the database assigns an id. */
export interface SecurityEventDraft {
  source: SecurityEventSource;
  kind: SecurityEventKind;
  severity: SecuritySeverity;
  /** Frigate camera name. Null for rows no camera produced — they are not camera-grant filtered. */
  camera: string | null;
  /** Where the row came from, for a human or a later join: `<camera>/<frigateId>`, `activity:<id>`. */
  sourceRef: string;
  /** Unique per observation. MQTT QoS 1 redelivers; a redelivered `end` must not add a row. */
  dedupeKey: string;
  labels: string[];
  /** Frigate's in-frame zones the object entered (`entered_zones`). The P2b zone links join on these. */
  cameraZones: string[];
  score: number | null;
  startedAt: Date;
  endedAt: Date | null;
  summary: string;
}

// Frigate ids look like `1695132000.123456-abc123`; camera and zone names are
// config keys. Anything else is not from Frigate and is not stored.
const FRIGATE_ID = /^[a-zA-Z0-9._-]{1,128}$/;
/**
 * A Frigate camera or zone name (a config key). Exported (WARP-2977 P2b) so
 * the area links, the sources list and the `SecurityZoneLink_ref` CHECK all
 * use the one grammar the ingest stores — a link to a name the ingest would
 * refuse could never match a row.
 */
export const FRIGATE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_ZONES = 16;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function epochSeconds(v: unknown): Date | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return new Date(Math.round(v * 1000));
}

function humanLabel(label: string): string {
  const spaced = label.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A `frigate/events` message → a detection row, or null when the message is
 * not an `end` or is not well-formed. `new` and `update` carry a partial
 * picture of the same object; only `end` has its duration and best score.
 */
export function frigateEndToDraft(message: unknown): SecurityEventDraft | null {
  if (!isRecord(message) || message.type !== "end") return null;
  const after = message.after;
  if (!isRecord(after)) return null;

  const id = typeof after.id === "string" ? after.id : "";
  const camera = typeof after.camera === "string" ? after.camera : "";
  const label = typeof after.label === "string" ? after.label : "";
  if (!FRIGATE_ID.test(id) || !FRIGATE_NAME.test(camera) || !FRIGATE_NAME.test(label)) return null;

  const startedAt = epochSeconds(after.start_time);
  if (!startedAt) return null;
  const endedAt = epochSeconds(after.end_time);

  const topScore = after.top_score;
  const score =
    typeof topScore === "number" && Number.isFinite(topScore) && topScore >= 0 && topScore <= 1
      ? topScore
      : null;

  const cameraZones = Array.isArray(after.entered_zones)
    ? [...new Set(after.entered_zones.filter((z): z is string => typeof z === "string" && FRIGATE_NAME.test(z)))].slice(
        0,
        MAX_ZONES,
      )
    : [];

  const durationSec = endedAt ? (endedAt.getTime() - startedAt.getTime()) / 1000 : null;
  // An `end` without an end time or a score cannot show it cleared the gate,
  // so it is kept as low — stored, never counted.
  const low =
    after.false_positive === true ||
    score === null ||
    score < SECURITY_MIN_SCORE ||
    durationSec === null ||
    durationSec < SECURITY_MIN_DURATION_SEC;

  return {
    source: "frigate",
    kind: low ? "detection_low" : "detection",
    severity: "info",
    camera,
    sourceRef: `${camera}/${id}`,
    dedupeKey: `frigate:${id}`,
    labels: [label],
    cameraZones,
    score,
    startedAt,
    endedAt,
    summary: cameraZones.length > 0 ? `${humanLabel(label)} in ${cameraZones.join(", ")}` : humanLabel(label),
  };
}

/** Health of one camera's detect stream, or of Frigate itself. */
export type SourceHealth = "online" | "offline" | "disabled";

export interface StatusReading {
  /** Null for `frigate/available` — Frigate as a whole. */
  camera: string | null;
  health: SourceHealth;
}

/**
 * Frigate 0.17 publishes `frigate/<camera>/status/<role>` with
 * `online` | `offline` | `disabled`, and its LWT `frigate/available` with
 * `online` | `offline` (plus `stopped` on a clean shutdown). Only the
 * `detect` role is read: detections are what the command center is built
 * on, and a camera whose detect stream is down is blind.
 */
export function parseFrigateStatus(topic: string, payload: string): StatusReading | null {
  const value = payload.trim().toLowerCase();
  if (topic === "frigate/available") {
    if (value === "online") return { camera: null, health: "online" };
    if (value === "offline" || value === "stopped") return { camera: null, health: "offline" };
    return null;
  }
  const m = /^frigate\/([^/]+)\/status\/detect$/.exec(topic);
  if (!m || !FRIGATE_NAME.test(m[1])) return null;
  if (value === "online" || value === "offline" || value === "disabled") return { camera: m[1], health: value };
  return null;
}

/**
 * A status reading → a row, only when it changes what was last recorded.
 *
 *   · `previous` is the last health recorded for that camera (or Frigate),
 *     read back from the store at boot — so a restart does not re-announce
 *     every camera, and a retained `online` on reconnect is not news.
 *   · Unknown → online is not an event (first sight of a healthy camera).
 *     Unknown → offline is: a camera that is down when Droplet starts is
 *     worth a row.
 *   · `disabled` is the owner turning a camera off. It is not a tamper
 *     signal, so it records nothing — but it IS remembered, so the next
 *     `online` after it is not reported as a recovery either.
 */
export function statusTransitionToDraft(
  reading: StatusReading,
  previous: SourceHealth | null,
  now: Date,
): SecurityEventDraft | null {
  if (reading.health === previous) return null;
  if (reading.health === "disabled") return null;
  if (reading.health === "online" && (previous === null || previous === "disabled")) return null;

  const offline = reading.health === "offline";
  const who = reading.camera ?? "frigate";
  return {
    source: "frigate_status",
    kind: reading.camera
      ? offline
        ? "camera_offline"
        : "camera_online"
      : offline
        ? "source_offline"
        : "source_online",
    severity: offline ? "notice" : "info",
    camera: reading.camera,
    sourceRef: reading.camera ? `${reading.camera}/status/detect` : "frigate/available",
    dedupeKey: `frigate_status:${who}:${reading.health}:${now.getTime()}`,
    labels: [],
    cameraZones: [],
    score: null,
    startedAt: now,
    endedAt: null,
    summary: reading.camera
      ? offline
        ? `Camera ${reading.camera} stopped reporting`
        : `Camera ${reading.camera} is reporting again`
      : offline
        ? "The camera system stopped reporting"
        : "The camera system is reporting again",
  };
}

/** The ActivityRow fields the threat mirror reads. */
export interface ThreatActivityRow {
  id: bigint;
  at: Date;
  kind: "network" | "auth";
  severity: "warn" | "err";
  what: string;
}

/** A warn/err `network` or `auth` ActivityRow → a threat row. The chain row stays the record; this is a pointer. */
export function threatRowToDraft(row: ThreatActivityRow): SecurityEventDraft {
  return {
    source: "activity_mirror",
    kind: "threat",
    severity: row.severity === "err" ? "alert" : "notice",
    camera: null,
    sourceRef: `activity:${row.id}`,
    dedupeKey: `activity:${row.id}`,
    labels: [row.kind],
    cameraZones: [],
    score: null,
    startedAt: row.at,
    endedAt: null,
    summary: row.what.slice(0, 500),
  };
}
