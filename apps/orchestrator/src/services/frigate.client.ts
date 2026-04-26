/**
 * Frigate NVR HTTP client — wraps the Frigate REST API.
 *
 * All camera stream/snapshot access goes through this client so that
 * camera IPs and RTSP URLs are never exposed to external clients.
 */

import pino from "pino";
import { config } from "../config.js";

const logger = pino({ name: "frigate-client" });

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

export async function deleteCamera(cameraName: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/config/cameras/${encodeURIComponent(cameraName)}`,
    { method: "DELETE", signal: timeout() }
  );
  if (!resp.ok) throw new Error(`Delete camera: ${resp.status}`);
}

export async function addCamera(
  name: string,
  rtspUrl: string,
  detect = true
): Promise<boolean> {
  const safeName = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  const cameraConfig = {
    cameras: {
      [safeName]: {
        ffmpeg: {
          inputs: [{ path: rtspUrl, roles: ["detect", "record"] }],
        },
        detect: { enabled: detect, width: 1280, height: 720, fps: 5 },
        record: { enabled: true },
        snapshots: { enabled: true },
      },
    },
  };

  const resp = await fetch(`${FRIGATE_URL}/api/config/set`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cameraConfig),
    signal: timeout(15_000),
  });

  return resp.ok;
}
