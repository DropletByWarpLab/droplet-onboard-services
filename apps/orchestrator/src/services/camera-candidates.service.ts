/**
 * Camera candidates — the "what's actually on my network" list (WARP-1847).
 *
 * The camera-discovery service is the authority on cameras it has FOUND but
 * not yet committed to Frigate: they live in its in-memory `pending_cameras`
 * map, exposed at `GET /cameras/discovered` (services/camera-discovery/main.py).
 * A candidate stays there and is re-probed every 30 s until a real RTSP stream
 * verifies — see the no-stagnant-guess rule in that service (PR #605): an
 * unverified port-open guess must NEVER be promoted, so "found but not usable
 * yet" is the normal steady state for most cameras, not an edge case.
 *
 * Before this module the dashboard could not see any of that. The orchestrator
 * answered `GET /api/cameras/discovered` purely from Postgres with
 * `where: { enabled: false, autoDiscovered: true }`, while the only writer of
 * those rows (`upsertCameraRecord`, MQTT `droplet/cameras/discovered`) left
 * `enabled` at its schema default of `true` — so the read filter could never
 * match a freshly discovered camera and the discovery banner was structurally
 * dead. The live pending list, which is the interesting one, was never read at
 * all.
 *
 * This service reads the live list first and falls back to the DB rows when
 * camera-discovery is unreachable (it's profile-gated — `full` / `single-box`),
 * so the surface degrades to its old behaviour instead of 5xx-ing.
 *
 * ── Credential handling (NET-05) ──────────────────────────────────────────
 * camera-discovery gates `/cameras/discovered` behind DEVICE_SECRET precisely
 * because a pending record's `rtsp_url` can embed `user:pass@` (the prober's
 * default-credential ladder writes the working credentials into the URL). That
 * must not reach a browser client, so every candidate's URL is stripped of its
 * userinfo here and the fact that credentials exist is reported as a boolean.
 */

import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("camera-candidates");

/** How far along a found device is toward being a usable camera. */
export type CameraCandidateStatus =
  /** A stream we have verified (or hold working credentials for) — Add should succeed. */
  | "ready"
  /** We found a camera but the stream needs credentials or a corrected path. */
  | "needs_credentials"
  /** Something answered on a camera port but nothing has confirmed it's a camera. */
  | "unverified";

export interface CameraCandidate {
  /** Stable handle for accept/reject. `mac:<MAC>` for live records, the DB row uuid otherwise. */
  id: string;
  /** Normalised (upper-case) MAC when known. Synthetic for leaseless finds. */
  mac: string | null;
  ip: string;
  /** Frigate-safe key the camera would be added under. */
  name: string;
  /** Human label for the list row. */
  displayName: string;
  manufacturer: string | null;
  model: string | null;
  status: CameraCandidateStatus;
  /** How the sweep found it: "onvif", "rtsp_default_credentials", "rtsp_port_open", … */
  detectionMethod: string | null;
  /** RTSP URL with any embedded credentials removed. Null when we have no URL at all. */
  rtspUrl: string | null;
  /** True when discovery holds credentials for this stream (never the credentials themselves). */
  hasCredentials: boolean;
  discoveredAt: string | null;
  /** Where this row came from — "live" is accept-able by MAC, "database" by id. */
  source: "live" | "database";
}

export interface CameraCandidateList {
  candidates: CameraCandidate[];
  /**
   * False when camera-discovery could not be reached, so `candidates` is the
   * DB-only fallback. The dashboard uses this to say "discovery isn't running"
   * instead of the much more misleading "no cameras found".
   */
  discoveryOnline: boolean;
}

/** Shape of one record in camera-discovery's `pending_cameras` / `known_cameras`. */
interface DiscoveryRecord {
  ip?: string;
  mac?: string;
  name?: string;
  hostname?: string;
  manufacturer?: string | null;
  model?: string | null;
  rtsp_url?: string | null;
  status?: string;
  detection_method?: string | null;
  discovered_at?: string;
}

/**
 * Strip `user:pass@` from an RTSP URL.
 *
 * Deliberately a regex on the authority segment rather than `new URL()`:
 * discovery emits percent-encoded credentials (`admin:Droplet123%21@…`) and we
 * must not risk a parser normalising or re-encoding the rest of the URL — the
 * value is shown to an operator, and the path is vendor-specific and literal
 * (`/profile2/media.smp`). The userinfo class excludes `/` so a path segment
 * containing `@` can never be mistaken for credentials.
 */
export function redactRtspCredentials(url: string): {
  rtspUrl: string;
  hasCredentials: boolean;
} {
  const match = /^(rtsps?:\/\/)([^/@]*@)/i.exec(url);
  if (!match) return { rtspUrl: url, hasCredentials: false };
  return {
    rtspUrl: match[1] + url.slice(match[0].length),
    hasCredentials: true,
  };
}

/**
 * Map a discovery record onto an explicit candidate status.
 *
 * Driven by the two fields the service actually sets — never inferred from a
 * missing column (CLAUDE.md "no guessing from absence"):
 *   - no `rtsp_url` at all           → nothing has confirmed a stream: unverified
 *   - `status: "active"`             → already committed to Frigate: ready
 *   - `onvif` / default-credentials  → the stream answered for the prober: ready
 *   - anything else with a URL       → a guess that still needs credentials or
 *     a vendor-specific path (`rtsp_port_open` is explicitly a placeholder)
 */
export function deriveCandidateStatus(record: DiscoveryRecord): CameraCandidateStatus {
  if (!record.rtsp_url) return "unverified";
  if (record.status === "active") return "ready";
  if (
    record.detection_method === "onvif" ||
    record.detection_method === "rtsp_default_credentials"
  ) {
    return "ready";
  }
  return "needs_credentials";
}

function toDisplayName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Frigate-safe key from a hostname/IP, mirroring the service's `_sanitize_camera_name`. */
function safeName(record: DiscoveryRecord): string {
  const raw = record.name || record.hostname || "";
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  if (cleaned) return cleaned.slice(0, 64);
  return `camera_${(record.ip ?? "").replace(/\./g, "_")}`;
}

function normaliseMac(mac: string | undefined | null): string | null {
  if (!mac) return null;
  const trimmed = mac.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function toCandidate(record: DiscoveryRecord): CameraCandidate | null {
  const ip = record.ip?.trim();
  if (!ip) return null; // nothing actionable without an address
  const mac = normaliseMac(record.mac);
  const name = safeName(record);
  const redacted = record.rtsp_url
    ? redactRtspCredentials(record.rtsp_url)
    : { rtspUrl: null, hasCredentials: false };
  return {
    id: mac ? `mac:${mac}` : `ip:${ip}`,
    mac,
    ip,
    name,
    displayName: toDisplayName(name),
    manufacturer: record.manufacturer ?? null,
    model: record.model ?? null,
    status: deriveCandidateStatus(record),
    detectionMethod: record.detection_method ?? null,
    rtspUrl: redacted.rtspUrl,
    hasCredentials: redacted.hasCredentials,
    discoveredAt: record.discovered_at ?? null,
    source: "live",
  };
}

function discoveryAuthHeaders(): Record<string, string> {
  const secret = process.env.DEVICE_SECRET_KEY || process.env.DEVICE_SECRET || "";
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

/** GET a JSON array from camera-discovery. Throws on any non-2xx or transport error. */
async function fetchDiscoveryList(path: string): Promise<DiscoveryRecord[]> {
  const resp = await internalFetch(
    `${internalBaseUrl(config.CAMERA_DISCOVERY_URL)}${path}`,
    { headers: discoveryAuthHeaders(), signal: AbortSignal.timeout(10_000) },
  );
  if (!resp.ok) {
    throw new Error(`camera-discovery ${path}: ${resp.status}`);
  }
  const body: unknown = await resp.json();
  return Array.isArray(body) ? (body as DiscoveryRecord[]) : [];
}

/**
 * The candidate list the dashboard renders.
 *
 * Live pending records first; DB rows are appended only when they don't
 * duplicate a live record (matched on MAC, then IP) so an operator never sees
 * the same physical camera twice. Cameras camera-discovery has already
 * committed to Frigate — its `known_cameras` — are excluded outright: they are
 * real cameras in the grid, not things left to add.
 */
export async function getCameraCandidates(
  prisma: PrismaClient,
): Promise<CameraCandidateList> {
  const [pendingResult, knownResult] = await Promise.allSettled([
    fetchDiscoveryList("/cameras/discovered"),
    fetchDiscoveryList("/cameras/known"),
  ]);

  const discoveryOnline = pendingResult.status === "fulfilled";
  if (!discoveryOnline) {
    logger.debug(
      { err: pendingResult.reason },
      "camera-discovery unreachable — serving DB-only candidates",
    );
  }

  const live: CameraCandidate[] =
    pendingResult.status === "fulfilled"
      ? pendingResult.value
          .map(toCandidate)
          .filter((c): c is CameraCandidate => c !== null)
      : [];

  // Already-adopted cameras must not appear as things to add. A failed
  // /cameras/known read is not fatal: worst case an adopted camera lingers in
  // the list for one poll, which is far better than hiding the whole list.
  const adoptedMacs = new Set<string>();
  const adoptedIps = new Set<string>();
  if (knownResult.status === "fulfilled") {
    for (const record of knownResult.value) {
      const mac = normaliseMac(record.mac);
      if (mac) adoptedMacs.add(mac);
      if (record.ip) adoptedIps.add(record.ip);
    }
  }

  const candidates = live.filter(
    (c) => !(c.mac && adoptedMacs.has(c.mac)) && !adoptedIps.has(c.ip),
  );

  const seenMacs = new Set(candidates.map((c) => c.mac).filter(Boolean) as string[]);
  const seenIps = new Set(candidates.map((c) => c.ip));

  // DB fallback / supplement. These rows carry no stream URL or detection
  // method, so they can only ever be reported as unverified — the live record
  // is the one that knows whether a stream answered.
  const dbRows = await prisma.camera.findMany({
    where: { enabled: false, autoDiscovered: true },
    orderBy: { createdAt: "desc" },
  });
  for (const row of dbRows) {
    const mac = normaliseMac(row.macAddress);
    if (mac && seenMacs.has(mac)) continue;
    if (row.ipAddress && seenIps.has(row.ipAddress)) continue;
    if (mac && adoptedMacs.has(mac)) continue;
    if (row.ipAddress && adoptedIps.has(row.ipAddress)) continue;
    candidates.push({
      id: row.id,
      mac,
      ip: row.ipAddress,
      name: row.name,
      displayName: row.displayName,
      manufacturer: row.manufacturer,
      model: row.model,
      status: "unverified",
      detectionMethod: null,
      rtspUrl: null,
      hasCredentials: false,
      discoveredAt: row.createdAt.toISOString(),
      source: "database",
    });
    if (mac) seenMacs.add(mac);
    if (row.ipAddress) seenIps.add(row.ipAddress);
  }

  return { candidates, discoveryOnline };
}

/** True when `id` addresses a live camera-discovery record rather than a DB row. */
export function isLiveCandidateId(id: string): boolean {
  return id.startsWith("mac:");
}

/** The MAC inside a live candidate id, or null when `id` isn't one. */
export function macFromCandidateId(id: string): string | null {
  return isLiveCandidateId(id) ? id.slice("mac:".length) : null;
}

export interface DiscoveryMutationResult {
  ok: boolean;
  /** Upstream HTTP status, so the route can mirror a 404/409/422 faithfully. */
  status: number;
  /** Upstream `detail` text when it failed — operator-facing, already prose. */
  message?: string;
}

/** POST accept/reject for a live candidate to camera-discovery, keyed by MAC. */
export async function mutateLiveCandidate(
  mac: string,
  action: "accept" | "reject",
): Promise<DiscoveryMutationResult> {
  const resp = await internalFetch(
    `${internalBaseUrl(config.CAMERA_DISCOVERY_URL)}/cameras/discovered/${encodeURIComponent(mac)}/${action}`,
    {
      method: "POST",
      headers: discoveryAuthHeaders(),
      // Accept verifies the stream upstream (a real RTSP DESCRIBE) before it
      // commits the camera to Frigate, so allow more than the read timeout.
      signal: AbortSignal.timeout(45_000),
    },
  );
  if (resp.ok) return { ok: true, status: resp.status };
  const body = (await resp.json().catch(() => ({}))) as { detail?: unknown };
  const detail = typeof body.detail === "string" ? body.detail : undefined;
  return { ok: false, status: resp.status, message: detail };
}
