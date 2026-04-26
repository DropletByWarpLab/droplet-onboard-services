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
