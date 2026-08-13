/**
 * Frigate NVR HTTP client — wraps the Frigate REST API.
 *
 * All camera stream/snapshot access goes through this client so that
 * camera IPs and RTSP URLs are never exposed to external clients.
 */

import { parseDocument, isMap, isScalar } from "yaml";

import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import {
  buildRecordBlock,
  buildSnapshotsBlock,
} from "./camera-retention-defaults.js";

const logger = createLogger("frigate-client");

const FRIGATE_URL = config.FRIGATE_URL;
const DEFAULT_TIMEOUT = 10_000; // 10s for normal calls
const SNAPSHOT_TIMEOUT = 15_000; // 15s for media

function timeout(ms = DEFAULT_TIMEOUT): AbortSignal {
  return AbortSignal.timeout(ms);
}

// --- Health ---

export async function healthCheck(): Promise<boolean> {
  try {
    const resp = await fetch(`${FRIGATE_URL}/api/version`, {
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// --- Cameras ---

export async function fetchCameras(): Promise<Record<string, unknown>> {
  const resp = await fetch(`${FRIGATE_URL}/api/stats`, { signal: timeout() });
  if (!resp.ok) throw new Error(`Frigate stats: ${resp.status}`);
  const data = await resp.json();
  return data.cameras ?? {};
}

export async function fetchConfig(): Promise<Record<string, unknown>> {
  const resp = await fetch(`${FRIGATE_URL}/api/config`, { signal: timeout() });
  if (!resp.ok) throw new Error(`Frigate config: ${resp.status}`);
  return resp.json();
}

// --- Events ---

export async function fetchEvents(
  limit = 20,
  camera?: string
): Promise<unknown[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (camera) params.set("camera", camera);
  const resp = await fetch(`${FRIGATE_URL}/api/events?${params}`, { signal: timeout() });
  if (!resp.ok) throw new Error(`Frigate events: ${resp.status}`);
  return resp.json();
}

/**
 * Filtered + paginated event fetch — wraps Frigate's full /api/events query
 * surface for the dashboard's Events page. Frigate paginates by `before`
 * timestamp (events ordered by start_time DESC); the caller treats the
 * oldest event's start_time in the previous page as the next page's
 * `before`. CSV-encoded `cameras` and `labels` match Frigate's wire
 * format. Limits are clamped at the route layer.
 */
export interface FrigateEventFilter {
  /** Comma-separated list of camera names (no spaces). */
  cameras?: string[];
  /** Comma-separated list of label strings (person, car, dog…). */
  labels?: string[];
  /** Min top_score, [0, 1]. */
  minScore?: number;
  /** Unix-seconds upper bound (exclusive) — fetch events earlier than this. */
  before?: number;
  /** Unix-seconds lower bound (inclusive) — fetch events at or later. */
  after?: number;
  /** If true, only events with a saved clip. */
  hasClip?: boolean;
  /** If true, only events with a saved snapshot. */
  hasSnapshot?: boolean;
  /** Page size — Frigate caps at 1000. The route validates a tighter cap. */
  limit?: number;
}

/**
 * Semantic event search (Frigate 0.14+). Wraps `/api/events/search`,
 * which uses CLIP embeddings indexed in chromadb to rank events by
 * similarity to a natural-language query string. Same filter params
 * as /api/events; the search query is what differentiates this from
 * the regular listing.
 *
 * Frigate returns 404 / 501 if the semantic-search dependency
 * (chromadb + the genai/embeddings stack) isn't enabled — the route
 * layer above translates that into a 503 with a config hint.
 */
export interface FrigateSearchFilter extends FrigateEventFilter {
  query: string;
  /** "thumbnail" | "description" — which embedding to query against.
   *  thumbnail = visual similarity, description = textual. */
  searchType?: "thumbnail" | "description";
}

export async function searchEventsSemantic(
  filter: FrigateSearchFilter,
): Promise<unknown[]> {
  const params = new URLSearchParams();
  params.set("query", filter.query);
  if (filter.searchType) params.set("search_type", filter.searchType);
  if (filter.cameras?.length) params.set("cameras", filter.cameras.join(","));
  if (filter.labels?.length) params.set("labels", filter.labels.join(","));
  if (filter.minScore !== undefined) params.set("min_score", String(filter.minScore));
  if (filter.before !== undefined) params.set("before", String(filter.before));
  if (filter.after !== undefined) params.set("after", String(filter.after));
  if (filter.hasClip !== undefined) params.set("has_clip", filter.hasClip ? "1" : "0");
  if (filter.hasSnapshot !== undefined) params.set("has_snapshot", filter.hasSnapshot ? "1" : "0");
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  params.set("include_thumbnails", "0");

  const resp = await fetch(`${FRIGATE_URL}/api/events/search?${params}`, {
    signal: timeout(20_000), // semantic search is slower than the bare list
  });
  if (!resp.ok) {
    if (resp.status === 404 || resp.status === 501) {
      throw new Error("semantic_search_disabled");
    }
    throw new Error(`Frigate search: ${resp.status}`);
  }
  return resp.json();
}

export async function fetchEventsFiltered(
  filter: FrigateEventFilter,
): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (filter.cameras?.length) params.set("cameras", filter.cameras.join(","));
  if (filter.labels?.length) params.set("labels", filter.labels.join(","));
  if (filter.minScore !== undefined) params.set("min_score", String(filter.minScore));
  if (filter.before !== undefined) params.set("before", String(filter.before));
  if (filter.after !== undefined) params.set("after", String(filter.after));
  if (filter.hasClip !== undefined) params.set("has_clip", filter.hasClip ? "1" : "0");
  if (filter.hasSnapshot !== undefined) params.set("has_snapshot", filter.hasSnapshot ? "1" : "0");
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  // Frigate's response includes a `thumbnail` blob field by default which
  // bloats the payload; the dashboard fetches the thumbnail through our
  // proxied /api/cameras/events/:id/thumbnail anyway.
  params.set("include_thumbnails", "0");

  const resp = await fetch(`${FRIGATE_URL}/api/events?${params}`, { signal: timeout() });
  if (!resp.ok) throw new Error(`Frigate events: ${resp.status}`);
  return resp.json();
}

// --- Stats ---

export async function fetchStats(): Promise<Record<string, unknown>> {
  const resp = await fetch(`${FRIGATE_URL}/api/stats`, { signal: timeout() });
  if (!resp.ok) throw new Error(`Frigate stats: ${resp.status}`);
  return resp.json();
}

/**
 * WARP-1850 — per-camera recording usage from `GET /api/recordings/storage`.
 *
 * Frigate computes this in `storage.py` (`calculate_camera_usages` +
 * `calculate_camera_bandwidth`) and returns a map:
 *
 *   { "<key>": { usage: <MiB|null>, bandwidth: <MiB/hr>, usage_percent?: <%> } }
 *
 * Two shape traps, both from the Frigate source rather than the docs:
 *
 * 1. **The key is `friendly_name` when a camera defines one**, otherwise the
 *    camera name (`camera_key = getattr(cam, "friendly_name", None) or camera`).
 *    Joining these keys to camera names directly will silently drop any
 *    camera with a friendly name — resolve through the config, don't assume.
 *
 * 2. **`usage` is `null`, not 0, for a camera with no segments** — it's a
 *    SQL `SUM` over zero rows. `0` and "not yet recorded anything" are
 *    different facts and the UI must not conflate them.
 *
 * Returns `{}` when Frigate has no recording stats yet (fresh boot, no
 * cameras). Throws on transport/HTTP failure so callers can degrade
 * honestly rather than render zeros.
 */
export async function fetchRecordingsStorage(): Promise<
  Record<string, { usage: number | null; bandwidth: number; usage_percent?: number }>
> {
  const resp = await fetch(`${FRIGATE_URL}/api/recordings/storage`, {
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`Frigate recordings storage: ${resp.status}`);
  const body = await resp.json();
  return body && typeof body === "object" ? body : {};
}

/** Trigger a full Frigate restart. Use sparingly — every camera goes
 *  dark for 5–15 seconds while go2rtc + the detector re-init. */
export async function restartFrigate(): Promise<void> {
  const resp = await fetch(`${FRIGATE_URL}/api/restart`, {
    method: "POST",
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`Frigate restart: ${resp.status}`);
}

/** Fetch Frigate's version string. Cheap; used by the system page. */
export async function fetchVersion(): Promise<string> {
  const resp = await fetch(`${FRIGATE_URL}/api/version`, { signal: timeout() });
  if (!resp.ok) throw new Error(`Frigate version: ${resp.status}`);
  return resp.text();
}

// --- PTZ control (Phase 6.1) ---
//
// Frigate exposes PTZ via /api/<camera>/ptz?action=...
// The action set we proxy: MOVE_*, ZOOM_IN, ZOOM_OUT, STOP, preset.
// Frigate also has a "FOCUS_*" set (focus-assist on supporting
// cameras); we leave that out for now — most home cameras autofocus.

export type PtzAction =
  | "MOVE_UP"
  | "MOVE_DOWN"
  | "MOVE_LEFT"
  | "MOVE_RIGHT"
  | "ZOOM_IN"
  | "ZOOM_OUT"
  | "STOP";

export async function ptzMove(
  cameraName: string,
  action: PtzAction,
): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/ptz?action=${action}`,
    { method: "PUT", signal: timeout() },
  );
  if (!resp.ok) throw new Error(`PTZ ${action}: ${resp.status}`);
}

export async function ptzGoToPreset(
  cameraName: string,
  preset: string,
): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/ptz?action=preset&preset=${encodeURIComponent(preset)}`,
    { method: "PUT", signal: timeout() },
  );
  if (!resp.ok) throw new Error(`PTZ preset: ${resp.status}`);
}

/** Look up which PTZ features the camera supports — Frigate exposes
 *  this on the per-camera config (`onvif.autotracking`, plus
 *  `support_*` flags Frigate computes from the ONVIF probe). */
export async function fetchPtzCapabilities(
  cameraName: string,
): Promise<{
  supportsPanTilt: boolean;
  supportsZoom: boolean;
  presets: string[];
}> {
  // The capabilities live under /api/config/cameras/<name>/onvif/info or
  // similar in newer Frigate. The simpler probe is /api/<name>/ptz/info
  // which returns { features: [...], presets: [...] } when supported.
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/ptz/info`,
    { signal: timeout() },
  );
  if (!resp.ok) {
    // 404 = no PTZ on this camera. That's a normal answer, not an error.
    if (resp.status === 404) {
      return { supportsPanTilt: false, supportsZoom: false, presets: [] };
    }
    throw new Error(`PTZ info: ${resp.status}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
  const features = Array.isArray(data.features)
    ? (data.features as unknown[]).map(String)
    : [];
  const presets = Array.isArray(data.presets)
    ? (data.presets as unknown[]).map(String)
    : [];
  return {
    supportsPanTilt: features.includes("pt") || features.includes("pan-tilt"),
    supportsZoom: features.includes("zoom"),
    presets,
  };
}

// --- Snapshots & Streams ---

export async function fetchSnapshot(
  cameraName: string,
  height = 480
): Promise<Response> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/latest.jpg?h=${height}`,
    { signal: timeout(SNAPSHOT_TIMEOUT) }
  );
  if (!resp.ok) throw new Error(`Frigate snapshot: ${resp.status}`);
  return resp;
}

/**
 * Open a long-lived MJPEG stream for `cameraName`. Frigate serves it at
 * `/api/{name}` with `Content-Type: multipart/x-mixed-replace;boundary=frame`,
 * which any modern browser will render natively in an `<img>`. We don't
 * apply the snapshot timeout here — the caller is expected to consume the
 * response as a stream and close it when the consumer disconnects, so a
 * 5 s budget would just kill the feed mid-frame.
 */
export async function openMjpegStream(
  cameraName: string,
  signal?: AbortSignal,
): Promise<Response> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}`,
    { signal },
  );
  if (!resp.ok) throw new Error(`Frigate MJPEG: ${resp.status}`);
  return resp;
}

/**
 * Frigate's auto-composited "birdseye" view — every active camera in
 * one MJPEG stream, with motion-active cameras brought to the front.
 * Same multipart MIME as a single-camera stream, so the browser plays
 * it as a live `<img>`.
 */
export async function openBirdseyeStream(
  signal?: AbortSignal,
): Promise<Response> {
  const resp = await fetch(`${FRIGATE_URL}/api/birdseye`, { signal });
  if (!resp.ok) throw new Error(`Birdseye MJPEG: ${resp.status}`);
  return resp;
}

export async function fetchEventThumbnail(eventId: string): Promise<Response> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/events/${encodeURIComponent(eventId)}/thumbnail.jpg`,
    { signal: timeout(SNAPSHOT_TIMEOUT) }
  );
  if (!resp.ok) throw new Error(`Frigate thumbnail: ${resp.status}`);
  return resp;
}

/**
 * Toggle the `retain_indefinitely` flag on a Frigate event. When set,
 * Frigate exempts the event's clip + snapshot from the normal
 * retention sweep — the operator's way of saying "save this, I want
 * to keep it." Frigate exposes POST /api/events/<id>/retain to set
 * and DELETE /api/events/<id>/retain to clear.
 *
 * Idempotent at the wire level: setting an already-retained event is
 * a no-op, clearing an already-clear event is a no-op.
 */
export async function setEventRetain(
  eventId: string,
  retain: boolean,
): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/events/${encodeURIComponent(eventId)}/retain`,
    { method: retain ? "POST" : "DELETE", signal: timeout() },
  );
  if (!resp.ok) throw new Error(`Frigate retain: ${resp.status}`);
}

/**
 * WARP-1440 — permanently delete a single Frigate event (the event row
 * plus its saved clip + snapshot on disk). Frigate 0.17 exposes
 * DELETE /api/events/<id> for exactly this.
 *
 * This is the ONLY event-delete route Frigate 0.17 offers besides
 * `DELETE /api/events/` (bulk, by a body of ids). There is no
 * delete-by-window form: `DELETE /api/events?before=` returns 405, as
 * does `DELETE /api/recordings?before=`. WARP-1849 removed the purge
 * cron that assumed otherwise — age-based expiry is Frigate's own job,
 * driven by the retention keys in its config.
 *
 * NOT idempotent: a second delete of the same id is a Frigate 404,
 * surfaced as the `event_not_found` sentinel (same sentinel-message
 * style as regenerateEventDescription's "genai_disabled") so the route
 * layer can answer a clean 404 instead of a generic upstream error.
 */
export async function deleteEvent(eventId: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE", signal: timeout() },
  );
  if (!resp.ok) {
    if (resp.status === 404) throw new Error("event_not_found");
    throw new Error(`Frigate event delete: ${resp.status}`);
  }
}

// --- Reviews (Frigate 0.13+) ---
//
// "Review items" are Frigate's higher-level abstraction over events:
// each review groups sequential events on the same camera into a
// single timeline entry with a severity (alert | detection |
// significant_motion). The dashboard's Events page surfaces these as
// the default view in the "Alerts" tab — operators usually want to
// triage clusters, not individual frames.

export interface FrigateReviewFilter {
  cameras?: string[];
  /** Severities to include — "alert" | "detection" | "significant_motion". */
  severity?: string[];
  before?: number;
  after?: number;
  /** Frigate also accepts `reviewed` (0/1) to filter by viewed state. */
  reviewed?: boolean;
  limit?: number;
}

export async function fetchReviews(
  filter: FrigateReviewFilter,
): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (filter.cameras?.length) params.set("cameras", filter.cameras.join(","));
  if (filter.severity?.length) params.set("severity", filter.severity.join(","));
  if (filter.before !== undefined) params.set("before", String(filter.before));
  if (filter.after !== undefined) params.set("after", String(filter.after));
  if (filter.reviewed !== undefined)
    params.set("reviewed", filter.reviewed ? "1" : "0");
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));

  const resp = await fetch(`${FRIGATE_URL}/api/review?${params}`, {
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`Frigate review: ${resp.status}`);
  return resp.json();
}

/**
 * Mark a review item as viewed (Frigate's "I've looked at this"
 * state). Frigate uses `POST /api/review/<id>/viewed` for this.
 * Idempotent.
 */
export async function markReviewViewed(reviewId: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/review/${encodeURIComponent(reviewId)}/viewed`,
    { method: "POST", signal: timeout() },
  );
  if (!resp.ok) throw new Error(`Frigate review viewed: ${resp.status}`);
}

// --- Recordings + timeline (Phase 3) ---
//
// Frigate keeps per-camera recordings as 10s mp4 segments on disk. The
// dashboard's Recordings page wants three things:
//   1. A daily/hourly summary so the timeline scrubber can paint
//      activity bands without fetching every segment.
//   2. The actual segment list for the chosen range so we can build a
//      contiguous playback URL.
//   3. The timeline activity stream — Frigate's per-event "started in
//      zone X / lost in zone Y" trail — so the scrubber can dot the
//      bar where things happened.

/**
 * Daily + hourly recording summary for one camera. Frigate returns
 * objects keyed by `day` (YYYY-MM-DD) with an `hours` map of bucket
 * summaries (motion %, event count). Useful to colour the timeline
 * scrubber without paying for the full segment list.
 */
export async function fetchRecordingsSummary(
  cameraName: string,
): Promise<unknown[]> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/recordings/summary`,
    { signal: timeout() },
  );
  if (!resp.ok) throw new Error(`Frigate recordings summary: ${resp.status}`);
  const data = await resp.json();
  // Frigate sometimes returns {summary: [...]}, sometimes a bare array
  // depending on version. Normalise.
  return Array.isArray(data) ? data : Array.isArray(data?.summary) ? data.summary : [];
}

/**
 * Recording segments for a camera in a time range. Each entry is a
 * 10-second mp4 segment with start/end Unix timestamps. The dashboard
 * uses these to know what's playable and to compute gaps.
 */
export async function fetchRecordings(
  cameraName: string,
  after: number,
  before: number,
): Promise<unknown[]> {
  const params = new URLSearchParams({
    after: String(after),
    before: String(before),
  });
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/recordings?${params}`,
    { signal: timeout() },
  );
  if (!resp.ok) throw new Error(`Frigate recordings: ${resp.status}`);
  return resp.json();
}

/**
 * Timeline activity stream for a camera in a time range. Frigate
 * returns one entry per object/zone transition with a `class_type`
 * ("visible", "entered_zone", "attribute", "gone"…) plus a `data`
 * blob containing label + score + region. The dashboard pins these
 * as dots on the scrubber.
 */
export async function fetchTimeline(
  cameraName: string,
  after: number,
  before: number,
): Promise<unknown[]> {
  const params = new URLSearchParams({
    cameras: cameraName,
    after: String(after),
    before: String(before),
    limit: "1000",
  });
  const resp = await fetch(`${FRIGATE_URL}/api/timeline?${params}`, {
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`Frigate timeline: ${resp.status}`);
  return resp.json();
}

/**
 * Construct the proxied URL for a recording-range mp4. Frigate
 * synthesises this on demand for ranges up to ~10 minutes; longer
 * windows need HLS (deferred to Phase 3.2).
 *
 * Returns just the URL — the route handler streams the upstream
 * response so we never buffer the full mp4.
 */
export function buildRecordingClipUrl(
  cameraName: string,
  start: number,
  end: number,
): string {
  return `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/start/${start}/end/${end}/clip.mp4`;
}

// --- Face recognition + LPR (Phase 7.5/7.6) ---
//
// Frigate 0.14+ ships a face_recognition feature that stores training
// images per person and an LPR feature that catalogs detected plates.
// Both expose REST endpoints we proxy so the dashboard can manage the
// known-set without giving the browser direct Frigate access.

export interface FaceImage {
  name: string;
  /** Authenticated proxy URL pointing at our orchestrator. */
  imageUrl: string;
}

export interface KnownFace {
  name: string;
  images: FaceImage[];
}

/** Lists every known face Frigate has training images for. Returns
 *  empty array (not error) when the feature isn't enabled. */
export async function fetchKnownFaces(): Promise<KnownFace[]> {
  const resp = await fetch(`${FRIGATE_URL}/api/faces`, { signal: timeout() });
  if (!resp.ok) {
    if (resp.status === 404 || resp.status === 501) return [];
    throw new Error(`Frigate faces: ${resp.status}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
  // Frigate returns either {name: [imageNames]} or {name: [{name: ...}]}
  // depending on version. Normalise to the structured shape; we don't
  // bake in the proxy URL here — the route layer does that since it
  // owns the URL space.
  const out: KnownFace[] = [];
  for (const [personName, raw] of Object.entries(data)) {
    if (!Array.isArray(raw)) continue;
    const images: FaceImage[] = (raw as unknown[]).map((img) => {
      if (typeof img === "string") {
        return { name: img, imageUrl: "" };
      }
      const o = img as Record<string, unknown>;
      const name = String(o.name ?? o.image_name ?? "");
      return { name, imageUrl: "" };
    }).filter((img) => img.name.length > 0);
    out.push({ name: personName, images });
  }
  return out;
}

/** Proxy a single face training image. Frigate hosts at
 *  /clips/faces/<name>/<image>; we go through our auth gate. */
export async function fetchFaceImage(
  personName: string,
  imageName: string,
): Promise<Response> {
  const resp = await fetch(
    `${FRIGATE_URL}/clips/faces/${encodeURIComponent(personName)}/${encodeURIComponent(imageName)}`,
    { signal: timeout(SNAPSHOT_TIMEOUT) },
  );
  if (!resp.ok) throw new Error(`Frigate face image: ${resp.status}`);
  return resp;
}

/** Delete an entire known person. Cascades all training images. */
export async function deleteKnownFace(personName: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/faces/${encodeURIComponent(personName)}`,
    { method: "DELETE", signal: timeout() },
  );
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Frigate face delete: ${resp.status}`);
  }
}

/** Delete a single training image but keep the person. */
export async function deleteFaceImage(
  personName: string,
  imageName: string,
): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/faces/${encodeURIComponent(personName)}/${encodeURIComponent(imageName)}`,
    { method: "DELETE", signal: timeout() },
  );
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Frigate face image delete: ${resp.status}`);
  }
}

/** Ask Frigate to (re)generate a natural-language description for an
 *  event using its configured GenAI provider. Returns when Frigate has
 *  enqueued the work; the description appears on the event payload
 *  shortly after. Frigate uses POST /api/events/<id>/regenerate_description
 *  to do this. */
export async function regenerateEventDescription(
  eventId: string,
): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/events/${encodeURIComponent(eventId)}/regenerate_description`,
    { method: "POST", signal: timeout(30_000) },
  );
  if (!resp.ok) {
    if (resp.status === 404 || resp.status === 501) {
      throw new Error("genai_disabled");
    }
    throw new Error(`Frigate regenerate description: ${resp.status}`);
  }
}

/** Tag an event's snapshot as a training image for `personName`. The
 *  operator's "this person is Alice" flow in the event modal calls
 *  this to feed the recogniser. */
export async function tagEventAsFace(
  eventId: string,
  personName: string,
): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/events/${encodeURIComponent(eventId)}/sub_label`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subLabel: personName, subLabelScore: 1.0 }),
      signal: timeout(),
    },
  );
  if (!resp.ok) throw new Error(`Frigate tag face: ${resp.status}`);
}

// --- License plate recognition ---

export interface KnownPlate {
  /** The plate text Frigate read off images (e.g. "ABC-1234"). */
  plate: string;
  /** Operator-assigned name ("Alice's Civic"). May be null when the
   *  plate is detected but unmapped. */
  name: string | null;
  /** Number of events this plate has appeared in (lifetime). */
  eventCount: number;
}

export async function fetchKnownPlates(): Promise<KnownPlate[]> {
  const resp = await fetch(`${FRIGATE_URL}/api/license_plates`, { signal: timeout() });
  if (!resp.ok) {
    if (resp.status === 404 || resp.status === 501) return [];
    throw new Error(`Frigate plates: ${resp.status}`);
  }
  const data = await resp.json();
  // Frigate returns either an array of {plate, name, count} objects
  // or {plate: {name, count}} keyed map depending on version.
  const out: KnownPlate[] = [];
  if (Array.isArray(data)) {
    for (const p of data as Array<Record<string, unknown>>) {
      out.push({
        plate: String(p.plate ?? p.value ?? ""),
        name: p.name ? String(p.name) : null,
        eventCount: Number(p.count ?? p.event_count ?? 0),
      });
    }
  } else if (data && typeof data === "object") {
    for (const [plate, raw] of Object.entries(data as Record<string, unknown>)) {
      const r = raw as Record<string, unknown>;
      out.push({
        plate,
        name: r.name ? String(r.name) : null,
        eventCount: Number(r.count ?? r.event_count ?? 0),
      });
    }
  }
  return out.filter((p) => p.plate.length > 0);
}

export async function nameKnownPlate(
  plate: string,
  name: string,
): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/license_plates/${encodeURIComponent(plate)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: timeout(),
    },
  );
  if (!resp.ok) throw new Error(`Frigate plate rename: ${resp.status}`);
}

export async function deleteKnownPlate(plate: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/license_plates/${encodeURIComponent(plate)}`,
    { method: "DELETE", signal: timeout() },
  );
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Frigate plate delete: ${resp.status}`);
  }
}

// --- HLS VOD playback (Phase 3.2) ---
//
// Frigate exposes a VOD endpoint at `/vod/<camera>/start/<s>/end/<e>/`
// that serves an HLS master playlist + media playlist + .ts segments.
// HLS lifts the 30-minute cap that the synthesised clip.mp4 endpoint
// imposes — the browser fetches segments lazily as the operator
// scrubs, so an hour or more of video plays without a server-side
// stitching round-trip.
//
// We expose three routes from cameras.ts that proxy this surface so
// the camera URL stays LAN-side:
//   1. /playback.m3u8 → fetch Frigate's master, follow to the media
//      playlist, rewrite .ts segment refs to point at the segment
//      proxy below.
//   2. /playback.segment?seg=N.ts&after=…&before=… → proxy a single
//      .ts file from Frigate.

/** Build the upstream Frigate URL for the master playlist of a VOD range. */
export function buildVodMasterUrl(
  cameraName: string,
  start: number,
  end: number,
): string {
  return `${FRIGATE_URL}/vod/${encodeURIComponent(cameraName)}/start/${start}/end/${end}/master.m3u8`;
}

/** Build the upstream Frigate URL for a specific segment of a VOD range. */
export function buildVodSegmentUrl(
  cameraName: string,
  start: number,
  end: number,
  segmentName: string,
): string {
  return `${FRIGATE_URL}/vod/${encodeURIComponent(cameraName)}/start/${start}/end/${end}/${encodeURIComponent(segmentName)}`;
}

/** Fetch and return the body of an HLS playlist (master or media). */
export async function fetchHlsPlaylist(url: string): Promise<string> {
  const resp = await fetch(url, { signal: timeout(15_000) });
  if (!resp.ok) throw new Error(`HLS playlist: ${resp.status}`);
  return resp.text();
}

// --- Camera control ---

export async function enableDetection(cameraName: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/detect/enable`,
    { method: "POST", signal: timeout() }
  );
  if (!resp.ok) throw new Error(`Enable detection: ${resp.status}`);
}

export async function disableDetection(cameraName: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/detect/disable`,
    { method: "POST", signal: timeout() }
  );
  if (!resp.ok) throw new Error(`Disable detection: ${resp.status}`);
}

export async function enableRecording(cameraName: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/recordings/enable`,
    { method: "POST", signal: timeout() }
  );
  if (!resp.ok) throw new Error(`Enable recording: ${resp.status}`);
}

export async function disableRecording(cameraName: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/recordings/disable`,
    { method: "POST", signal: timeout() }
  );
  if (!resp.ok) throw new Error(`Disable recording: ${resp.status}`);
}

// --- Config management ---

/**
 * Frigate's AUTHORED config (config.yml text), not the resolved runtime tree.
 * Frigate 0.17 serves it JSON-string-encoded on /api/config/raw. The resolved
 * /api/config carries computed-only fields (auth.roles reserved names,
 * model.colormap, …) that /api/config/save rejects with a 400, so anything
 * that saves a whole config must start from the authored YAML, which
 * round-trips cleanly.
 */
export async function fetchRawConfigYaml(): Promise<string> {
  const resp = await fetch(`${FRIGATE_URL}/api/config/raw`, { signal: timeout() });
  if (!resp.ok) throw new Error(`Fetch raw config: ${resp.status}`);
  const text = await resp.text();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
  } catch {
    /* already plain YAML */
  }
  return text;
}

/** Persist authored YAML and reload Frigate. text/plain so safe_load parses it. */
export async function saveRawConfig(yamlText: string): Promise<Response> {
  return fetch(`${FRIGATE_URL}/api/config/save?save_option=restart`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: yamlText,
    signal: timeout(30_000),
  });
}

export async function deleteCamera(cameraName: string): Promise<void> {
  // DELETE /api/config/cameras/<name> is gone on Frigate 0.17 (404), and
  // config/set only MERGES (it can't remove a key). Drop the camera from the
  // authored YAML and save the whole thing back.
  const doc = parseDocument(await fetchRawConfigYaml());
  doc.deleteIn(["cameras", cameraName]);
  const resp = await saveRawConfig(String(doc));
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    logger.warn(
      { status: resp.status, camera: cameraName, body: errBody.slice(0, 200) },
      "Frigate config/save rejected while deleting camera",
    );
    throw new Error(`Delete camera: ${resp.status}`);
  }
}

export async function addCamera(
  name: string,
  rtspUrl: string,
  detect = true
): Promise<boolean> {
  const safeName = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");

  // Frigate 0.17 replaced POST /api/config/set (405) with a PUT that takes a
  // {config_data, requires_restart} envelope and deep-MERGES config_data into
  // the running config — so we send only the new camera block and existing
  // cameras are preserved. This is the same call the camera-discovery service
  // uses to auto-adopt. requires_restart=1 persists to disk and reloads so the
  // camera actually starts capturing.
  //
  // 🔴 `record` MUST carry the retention windows explicitly. This block used
  // to be `{ enabled: true }`, which inherits `continuous: 0` / `motion: 0`
  // from Frigate's own schema — the camera then keeps ONLY segments that
  // overlap an alert or detection, while every surface reports "Recording"
  // (WARP-1957). See camera-retention-defaults.ts for why the fix is here
  // and not in docker/frigate/config.yml.
  const resp = await fetch(`${FRIGATE_URL}/api/config/set`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config_data: {
        cameras: {
          [safeName]: {
            ffmpeg: { inputs: [{ path: rtspUrl, roles: ["detect", "record"] }] },
            detect: { enabled: detect, width: 1280, height: 720, fps: 5 },
            record: buildRecordBlock(),
            snapshots: buildSnapshotsBlock(),
          },
        },
      },
      requires_restart: 1,
    }),
    signal: timeout(30_000),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    logger.warn(
      { status: resp.status, camera: safeName, body: errBody.slice(0, 200) },
      "Frigate config/set rejected while adding camera",
    );
    return false;
  }
  // Frigate 0.17 always sets `success`; treat its absence as a response-shape
  // change, not a silent success.
  const body = (await resp.json().catch(() => ({}))) as { success?: boolean };
  return body.success === true;
}

/**
 * Reconcile Frigate's `config.cameras` against the orchestrator DB (#11).
 * Frigate persists camera blocks in its own /config volume, which outlives a
 * Postgres wipe (factory-reset, version migration). The result is orphaned
 * camera entries — e.g. `camera_192_168_20_176` — that the dashboard never
 * lists (the DB doesn't know them) and no DELETE can reach.
 *
 * Every Frigate camera whose name is NOT in `dbCameraNames` is dropped;
 * survivors keep their FULL existing block (ffmpeg inputs, detect, zones,
 * masks, per-camera settings) untouched. We do NOT rebuild survivors from the
 * DB — the Camera row doesn't persist the RTSP URL, so regenerating would
 * destroy working stream config.
 *
 * Works off the AUTHORED YAML (fetchRawConfigYaml), the same round-trip
 * deleteCamera uses: the resolved /api/config isn't save-round-trippable on
 * Frigate 0.17, and DELETE /api/config/cameras/<name> is a 404. No-op fast
 * path when there are no orphans (skips the camera-dropping restart). Returns
 * the names removed.
 */
export async function syncCamerasFromDb(
  dbCameraNames: string[],
): Promise<string[]> {
  const wanted = new Set(dbCameraNames);
  const doc = parseDocument(await fetchRawConfigYaml());

  const camerasNode = doc.getIn(["cameras"]);
  const current: string[] = [];
  if (isMap(camerasNode)) {
    for (const item of camerasNode.items) {
      const key = item.key;
      current.push(isScalar(key) ? String(key.value) : String(key));
    }
  }

  const removed = current.filter((name) => !wanted.has(name));
  if (removed.length === 0) {
    return [];
  }
  for (const name of removed) doc.deleteIn(["cameras", name]);

  const resp = await saveRawConfig(String(doc));
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    logger.warn(
      { status: resp.status, removed, body: errBody.slice(0, 200) },
      "Frigate config/save rejected during camera sync",
    );
    throw new Error(`Frigate rejected the config: ${resp.status}`);
  }

  logger.info({ removed }, "Pruned orphaned cameras from Frigate config");
  return removed;
}
