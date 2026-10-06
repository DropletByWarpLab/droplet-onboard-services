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
 * ── What is NOT a candidate (WARP-3508) ───────────────────────────────────
 * A camera the operator already has. camera-discovery can only exclude what IT
 * committed (`/cameras/known`); a camera added by hand never passes through it,
 * so its pending record — and the "Needs sign-in" card built from it — lingered
 * forever. The orchestrator is the one place that sees all three signals, so
 * the exclusion lives here: a Camera row that is live/adopted
 * (`isManagedCameraRow`), and any host a Frigate camera input already pulls from.
 *
 * The MAC is lower-cased on the way back to camera-discovery. It keys its
 * pending map by lower-case MAC and looks it up exactly; the candidate ids built
 * here carry the upper-case form for display, and forwarding that verbatim made
 * every ✕ and Add answer 404.
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
import { fetchConfig } from "./frigate.client.js";

const logger = createLogger("camera-candidates");

/**
 * Longest the candidate list waits on Frigate. The list is polled by the
 * dashboard, and a Frigate that is restarting (every adoption restarts it) can
 * hold the connection open — that must cost the exclusion, never the list.
 */
const FRIGATE_CONFIG_TIMEOUT_MS = 3_000;

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
  /** WARP-3597: camera-discovery strips `user:pass@` from `rtsp_url` and says so here. */
  has_credentials?: boolean;
  status?: string;
  detection_method?: string | null;
  discovered_at?: string;
}

/**
 * Strip `user:pass@` from an RTSP URL.
 *
 * Deliberately a regex on the authority segment rather than `new URL()`:
 * discovery emits percent-encoded credentials (`admin:T3stCamPw%21@…`) and we
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

/**
 * The key camera-discovery files a camera under: the MAC, lower-case.
 *
 * `normaliseMac` (upper-case) is how this service compares and displays MACs;
 * this is how it TALKS to camera-discovery. They are deliberately a pair — the
 * synthetic keys discovery mints for a camera with no DHCP lease (`ip:<addr>`,
 * `onvif_<addr>`) go through both, so `IP:192.168.9.77` must become
 * `ip:192.168.9.77` again on the wire.
 */
function discoveryKey(mac: string): string {
  return mac.trim().toLowerCase();
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
    hasCredentials: record.has_credentials ?? redacted.hasCredentials,
    discoveredAt: record.discovered_at ?? null,
    source: "live",
  };
}

/**
 * Bearer for camera-discovery's DEVICE_SECRET-gated routes (`/scan`,
 * `/cameras/discovered`, `/cameras/known`, `/drivers*`).
 *
 * DEVICE_SECRET is the ONLY accepted value — `services/camera-discovery/main.py`
 * compares against `os.getenv("DEVICE_SECRET")` and nothing else. This used to
 * prefer DEVICE_SECRET_KEY, which is a *different* random value on every
 * provisioned box (scripts/lib/secrets.sh generates `device_secret` and
 * `device_secret_key` independently), so the preferred branch always won and
 * always sent a secret camera-discovery would never accept: 403 on every
 * privileged call. Do not re-add a DEVICE_SECRET_KEY fallback — it is not a
 * weaker-but-valid credential here, it is the wrong one.
 */
export function discoveryAuthHeaders(): Record<string, string> {
  const secret = process.env.DEVICE_SECRET || "";
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
 * Is this Camera row a camera the operator already HAS — live in the grid or
 * adopted — as opposed to a discovery-only row the fallback list may still offer?
 *
 * Adoption is explicit (WARP-3506/3510). An operator-disabled ADOPTED camera
 * remains managed; neither its enabled toggle nor discovery origin changes
 * whether it is owned by the operator.
 */
export function isManagedCameraRow(row: {
  adoption: "CANDIDATE" | "ADOPTED";
}): boolean {
  return row.adoption === "ADOPTED";
}

/** Host of a stream URL, or null when it has none (a device path, `ffmpeg:` source…). */
function hostOfStreamUrl(url: string): string | null {
  try {
    // rtsp: is not a WHATWG "special" scheme, so its host stays opaque; parse it
    // as http(s) to get a real hostname, the way POST /cameras does.
    const host = new URL(
      url.replace(/^rtsp:\/\//i, "http://").replace(/^rtsps:\/\//i, "https://"),
    ).hostname;
    return host || null;
  } catch {
    return null;
  }
}

/**
 * Every host a Frigate camera input pulls from — `cameras.<name>.ffmpeg.inputs[].path`
 * in Frigate's config. A camera Frigate already records from is a camera,
 * whichever service added it and whatever the Camera table says.
 *
 * Reads defensively: this is Frigate's config, not ours, and it is parsed on a
 * list endpoint that must never throw over a shape it did not expect.
 */
export function frigateInputHosts(frigateConfig: unknown): Set<string> {
  const hosts = new Set<string>();
  const cameras = (frigateConfig as { cameras?: unknown } | null)?.cameras;
  if (!cameras || typeof cameras !== "object") return hosts;
  for (const camera of Object.values(cameras as Record<string, unknown>)) {
    const inputs = (camera as { ffmpeg?: { inputs?: unknown } } | null)?.ffmpeg?.inputs;
    if (!Array.isArray(inputs)) continue;
    for (const input of inputs) {
      const path = (input as { path?: unknown } | null)?.path;
      if (typeof path !== "string") continue;
      const host = hostOfStreamUrl(path);
      if (host) hosts.add(host);
    }
  }
  return hosts;
}

/** `frigateInputHosts` of the live Frigate config. Rejects when Frigate cannot answer in time. */
async function fetchFrigateInputHosts(): Promise<Set<string>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Frigate config not read within ${FRIGATE_CONFIG_TIMEOUT_MS} ms`)),
      FRIGATE_CONFIG_TIMEOUT_MS,
    );
  });
  try {
    return frigateInputHosts(await Promise.race([fetchConfig(), stalled]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The candidate list the dashboard renders.
 *
 * Live pending records first; DB rows are appended only when they don't
 * duplicate a live record (matched on MAC, then IP) so an operator never sees
 * the same physical camera twice.
 *
 * A camera the operator already has is excluded outright — it is a real camera
 * in the grid, not something left to add. "Already has" is any of:
 *   - camera-discovery committed it to Frigate (its `known_cameras`),
 *   - a managed Camera row carries its MAC or IP (`isManagedCameraRow` — covers a
 *     camera added by hand, which discovery never sees),
 *   - a Frigate camera input pulls from its IP.
 */
export async function getCameraCandidates(
  prisma: PrismaClient,
): Promise<CameraCandidateList> {
  const [[pendingResult, knownResult, frigateResult], rows] = await Promise.all([
    Promise.allSettled([
      fetchDiscoveryList("/cameras/discovered"),
      fetchDiscoveryList("/cameras/known"),
      fetchFrigateInputHosts(),
    ]),
    prisma.camera.findMany({ orderBy: { createdAt: "desc" } }),
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

  // Cameras the operator already has must not appear as things to add. Neither
  // the /cameras/known read nor the Frigate read is allowed to be fatal: worst
  // case an existing camera lingers in the list for one poll, which is far
  // better than hiding the whole list.
  const adoptedMacs = new Set<string>();
  const adoptedIps = new Set<string>();
  const markAdopted = (mac: string | null | undefined, ip: string | null | undefined) => {
    const normalisedMac = normaliseMac(mac);
    if (normalisedMac) adoptedMacs.add(normalisedMac);
    const trimmedIp = ip?.trim();
    if (trimmedIp) adoptedIps.add(trimmedIp);
  };
  if (knownResult.status === "fulfilled") {
    for (const record of knownResult.value) markAdopted(record.mac, record.ip);
  }
  for (const row of rows) {
    if (isManagedCameraRow(row)) markAdopted(row.macAddress, row.ipAddress);
  }
  if (frigateResult.status === "fulfilled") {
    for (const host of frigateResult.value) adoptedIps.add(host);
  } else {
    logger.debug({ err: frigateResult.reason }, "Frigate config unreadable — not excluding by stream host");
  }

  const candidates = live.filter(
    (c) => !(c.mac && adoptedMacs.has(c.mac)) && !adoptedIps.has(c.ip),
  );

  const seenMacs = new Set(candidates.map((c) => c.mac).filter(Boolean) as string[]);
  const seenIps = new Set(candidates.map((c) => c.ip));

  // DB fallback / supplement. These rows carry no stream URL or detection
  // method, so they can only ever be reported as unverified — the live record
  // is the one that knows whether a stream answered.
  //
  // A candidate is a row whose `adoption` says so (WARP-3510). It used to be
  // guessed from `enabled: false, autoDiscovered: true`, which also matched an
  // operator-DISABLED live camera and offered it back as something to add.
  const dbRows = await prisma.camera.findMany({
    where: { adoption: "CANDIDATE" },
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

/**
 * The camera an accept put into Frigate — what the caller needs to file the DB
 * row under the key camera-discovery used. Deliberately NOT the stream URL:
 * that can embed credentials (see NET-05 above) and the row never stores it.
 */
export interface AcceptedCamera {
  /** The Frigate key camera-discovery added the camera under. */
  name: string;
  ip: string;
  mac: string | null;
  manufacturer: string | null;
  model: string | null;
}

export interface DiscoveryMutationResult {
  ok: boolean;
  /** Upstream HTTP status, so the route can mirror a 404/409/422 faithfully. */
  status: number;
  /** Upstream `detail` text when it failed — operator-facing, already prose. */
  message?: string;
  /** Machine-readable credentials refusal, never a credential value. */
  code?: string;
  /** On a successful accept: the camera now in Frigate, when the service says which. */
  camera?: AcceptedCamera;
}

function acceptedCameraFrom(body: unknown): AcceptedCamera | undefined {
  const cam = (body as { camera?: Record<string, unknown> } | null)?.camera;
  if (!cam || typeof cam.name !== "string" || typeof cam.ip !== "string") return undefined;
  const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    name: cam.name,
    ip: cam.ip,
    mac: text(cam.mac),
    manufacturer: text(cam.manufacturer),
    model: text(cam.model),
  };
}

/**
 * POST accept/reject for a live candidate to camera-discovery, keyed by MAC.
 *
 * `mac` is whatever case the candidate id carried; camera-discovery's lookup is
 * exact and lower-case, so it is lower-cased here at the boundary (WARP-3508).
 */
export async function mutateLiveCandidate(
  mac: string,
  action: "accept" | "reject",
): Promise<DiscoveryMutationResult> {
  const resp = await internalFetch(
    `${internalBaseUrl(config.CAMERA_DISCOVERY_URL)}/cameras/discovered/${encodeURIComponent(discoveryKey(mac))}/${action}`,
    {
      method: "POST",
      headers: discoveryAuthHeaders(),
      // Accept verifies the stream upstream (a real RTSP DESCRIBE) before it
      // commits the camera to Frigate, so allow more than the read timeout.
      signal: AbortSignal.timeout(45_000),
    },
  );
  if (resp.ok) {
    const camera = acceptedCameraFrom(await resp.json().catch(() => null));
    return { ok: true, status: resp.status, ...(camera ? { camera } : {}) };
  }
  const body = (await resp.json().catch(() => ({}))) as { detail?: unknown };
  const detail = typeof body.detail === "string" ? body.detail : undefined;
  return { ok: false, status: resp.status, message: detail };
}

/**
 * Add a live candidate using credentials the operator typed (WARP-3505).
 *
 * camera-discovery re-runs ONVIF GetStreamUri + the RTSP path probe with these
 * credentials and, on success, commits the camera to Frigate itself — it is the
 * only place that knows the probed path and holds the pending record.
 *
 * NET-05: the password travels only in the POST body to the internal service.
 * It is never logged here, never put in the URL, and the returned result
 * carries only camera-discovery's operator prose + a code, so a caller can't
 * accidentally echo it.
 */
export interface CredentialMutationResult extends Omit<DiscoveryMutationResult, "camera"> {
  /** Identifying fields only; older discovery services may omit them. */
  camera?: { name?: string; ip?: string; mac?: string };
}

export async function submitLiveCandidateCredentials(
  mac: string,
  username: string,
  password: string,
): Promise<CredentialMutationResult> {
  let resp: Response;
  try {
    resp = await internalFetch(
      `${internalBaseUrl(config.CAMERA_DISCOVERY_URL)}/cameras/discovered/${encodeURIComponent(discoveryKey(mac))}/credentials`,
      {
        method: "POST",
        headers: { ...discoveryAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        // camera-discovery bounds its own work: the probing phase (RTSP walk
        // <= 25 s, then ONVIF <= 8 s and one named path <= 10 s, only when RTSP
        // found no path) has a HARD 45 s deadline, answered as a 504 `timeout`;
        // the Frigate commit that follows is sub-second. 60 s outlasts that, and
        // every proxy hop in front of the browser outlasts this
        // (apps/web-dashboard/next.config.js, docker/nginx/nginx.conf).
        signal: AbortSignal.timeout(60_000),
      },
    );
  } catch (err) {
    // Deliberately drop the error object: undici errors can carry request
    // context, and the body of this request is the password. Only its NAME is
    // read, to tell "took too long" (the camera may well have been added) from
    // "camera-discovery is not running".
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return {
        ok: false,
        status: 504,
        code: "timeout",
        message: "The camera took too long to answer. If it was added, it will appear in your cameras shortly.",
      };
    }
    return {
      ok: false,
      status: 502,
      code: "discovery_unavailable",
      message: "Camera discovery isn't running, so the camera couldn't be checked.",
    };
  }
  const body = (await resp.json().catch(() => ({}))) as {
    detail?: unknown;
    code?: unknown;
    camera?: Record<string, unknown> | null;
  };
  if (resp.ok) {
    const added = body.camera;
    const pick = (key: string) => (typeof added?.[key] === "string" ? (added[key] as string) : undefined);
    // Only the three identifying fields are carried, whatever else the reply holds.
    const camera = added ? { name: pick("name"), ip: pick("ip"), mac: pick("mac") } : undefined;
    return { ok: true, status: resp.status, ...(camera ? { camera } : {}) };
  }
  return {
    ok: false,
    status: resp.status,
    code: typeof body.code === "string" ? body.code : undefined,
    message: typeof body.detail === "string" ? body.detail : undefined,
  };
}
