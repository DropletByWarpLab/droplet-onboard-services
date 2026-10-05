/**
 * Camera service — business logic over Frigate client + camera discovery.
 *
 * Aggregates Frigate camera status with database metadata, caches results,
 * and subscribes to MQTT for real-time detection events and camera discovery.
 * Provides SSE event subscription for the dashboard.
 */

import mqtt from "mqtt";
import { PrismaClient } from "@prisma/client";
import {
  healthCheck,
  fetchCameras,
  fetchConfig,
  fetchEvents,
  fetchEventsFiltered,
  fetchLastRecordingEnd,
  fetchRecordings,
  fetchRecordingsStorage,
  fetchRecordingsSummary,
  fetchReviews,
  fetchStats,
  fetchTimeline,
  markReviewViewed,
  searchEventsSemantic,
  setEventRetain,
  syncCamerasFromDb,
  type FrigateEventFilter,
  type FrigateReviewFilter,
  type FrigateSearchFilter,
} from "./frigate.client.js";
import { cacheGet, cacheSet, cacheDel } from "./cache.service.js";
import {
  isPlaceholderName,
  rankForSurvival,
  readCameraKeySnapshot,
  realMac,
  sameDeviceRows,
} from "./camera-adoption.service.js";
import { toDisplayName, toFrigateKey } from "./camera-key.js";
import { dispatchDetectionEvent } from "./push-dispatch.service.js";
import { processCameraEvent } from "./camera-event-gate.js";
import {
  inCameraScope,
  narrowCameraFilter,
  type CameraScope,
} from "./camera-access.service.js";
import { config } from "../config.js";
import { mqttConnectOptions } from "../lib/internal-tls.js";
import type {
  CameraInfo,
  CameraRecordingState,
  DetectionEvent,
  DiscoveredCamera,
  CameraSSEEvent,
  EventDetail,
  RecordingDay,
  RecordingHour,
  RecordingSegment,
  ReviewItem,
  TimelineEntry,
} from "../types/camera.js";
import { createLogger } from "../lib/logger.js";
import { retainsFootage } from "./camera-retention-defaults.js";
import {
  buildRecordingState,
  degradedRecordingState,
  indexStorageByCamera,
  type StorageBytes,
} from "./camera-recording-state.js";

const logger = createLogger("camera-service");

const CACHE_KEY_CAMERAS = "cameras:list";
const CACHE_KEY_EVENTS = "cameras:events:recent";
const CACHE_TTL = 5; // seconds

let _mqttClient: mqtt.MqttClient | null = null;
let _initialized = false;
/** Pairs of ADOPTED rows already reported as sharing one device (see upsertCameraRecord). */
const _warnedSharedDevices = new Set<string>();

/**
 * The Frigate 0.17 topics this service reads. Frigate's per-camera health
 * topic is `frigate/<camera>/status/<role>`; MQTT's `+` matches exactly one
 * level, so a one-level `frigate/+/status` never delivers it. Only the
 * `detect` role is read: a camera whose detect stream is down is blind.
 * One list, shared with the SUBACK check, so a topic can never be subscribed
 * without being verified (or verified without being asked for).
 */
const FRIGATE_TOPICS = ["frigate/events", "frigate/+/status/detect"] as const;

/** What a camera's detect stream reports on `frigate/<camera>/status/detect`. */
type CameraHealth = "online" | "offline" | "disabled";

/** Frigate's own naming rule for a camera segment of a topic. */
const FRIGATE_CAMERA_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** The last health heard per camera, so only a TRANSITION is broadcast. In memory; a restart forgets it. */
const _cameraHealth = new Map<string, CameraHealth>();

// SSE subscribers
type SSECallback = (event: CameraSSEEvent) => void;
const _sseSubscribers = new Set<SSECallback>();

// --- Initialization ---

export async function initCameraService(prisma: PrismaClient): Promise<void> {
  const ok = await healthCheck();
  if (!ok) {
    logger.warn("Frigate not reachable — camera service running in degraded mode");
  } else {
    logger.info("Frigate NVR is reachable");
  }

  _initialized = true;

  // Connect to MQTT for Frigate events and camera discovery
  try {
    // WARP-235: mqtts:// brokers require this service's client cert
    // (identity = CN "orchestrator"); dev mqtt:// URLs add no TLS options.
    _mqttClient = mqtt.connect(config.MQTT_BROKER, {
      clientId: "orchestrator-cameras",
      clean: true,
      ...mqttConnectOptions(config.MQTT_BROKER),
    });

    _mqttClient.on("connect", () => {
      logger.info("Camera service connected to MQTT");
      _mqttClient!.subscribe("droplet/cameras/discovered", { qos: 1 });
      // The SUBACK is checked: a topic the broker refused (QoS 128, e.g. an
      // ACL that no longer allows `frigate/#`) is detections and camera health
      // that never arrive, and that must not be silent.
      _mqttClient!.subscribe(
        Object.fromEntries(FRIGATE_TOPICS.map((t) => [t, { qos: 1 as const }])),
        (err, granted) => {
          if (err) {
            logger.error({ err }, "Camera service could not subscribe to the Frigate topics");
            return;
          }
          const refused = FRIGATE_TOPICS.filter(
            (t) => !(granted ?? []).some((g) => g.topic === t && g.qos >= 0 && g.qos <= 2),
          );
          if (refused.length > 0) {
            logger.error({ refused }, "broker refused Frigate topics — camera events and status will not arrive");
          }
        },
      );
    });

    _mqttClient.on("message", (topic, payload) => {
      handleMqttMessage(topic, payload, prisma);
    });

    _mqttClient.on("error", (err) => {
      logger.error({ err }, "Camera MQTT error");
    });
  } catch (err) {
    logger.warn("Camera MQTT connection failed: %s", err);
  }
}

export function isInitialized(): boolean {
  return _initialized;
}

export async function shutdownCameraService(): Promise<void> {
  if (_mqttClient) {
    _mqttClient.end();
    _mqttClient = null;
  }
  _sseSubscribers.clear();
  _cameraHealth.clear();
  _warnedSharedDevices.clear();
  _initialized = false;
}

// --- MQTT message handling ---

/** `frigate/<camera>/status/detect` and its bare-string payload → the camera and its health, or null for anything else. */
function parseCameraStatus(topic: string, payload: string): { camera: string; health: CameraHealth } | null {
  const m = /^frigate\/([^/]+)\/status\/detect$/.exec(topic);
  if (!m || !FRIGATE_CAMERA_NAME.test(m[1])) return null;
  const value = payload.trim().toLowerCase();
  if (value === "online" || value === "offline" || value === "disabled") return { camera: m[1], health: value };
  return null;
}

/**
 * The SSE event a health reading is news for, or null. Every reading moves
 * the remembered health forward; only a change is news:
 *
 *   · a repeat of what was last heard (or a retained replay on reconnect) is
 *     not;
 *   · first sight of a healthy camera is not — nothing changed — but first
 *     sight of an offline one is;
 *   · `disabled` is the owner turning a camera off. It is remembered but never
 *     broadcast, so the next `online` after it is not reported as a recovery.
 */
function cameraStatusChange(camera: string, health: CameraHealth): "camera_online" | "camera_offline" | null {
  const previous = _cameraHealth.get(camera);
  _cameraHealth.set(camera, health);
  if (health === previous) return null;
  if (health === "disabled") return null;
  if (health === "online" && (previous === undefined || previous === "disabled")) return null;
  return health === "offline" ? "camera_offline" : "camera_online";
}

function handleMqttMessage(
  topic: string,
  payload: Buffer,
  prisma: PrismaClient
): void {
  const raw = payload.toString();

  // Frigate health: `frigate/<camera>/status/detect` carries a bare string
  // (online | offline | disabled), not JSON. Only a TRANSITION is broadcast —
  // the topic is retained, so every reconnect replays the current state.
  if (/^frigate\/[^/]+\/status\/detect$/.test(topic)) {
    const reading = parseCameraStatus(topic, raw);
    const change = reading ? cameraStatusChange(reading.camera, reading.health) : null;
    if (reading && change) {
      broadcastSSE({ type: change, camera: reading.camera, timestamp: Date.now() });
    }
    return;
  }

  // All other topics use JSON payloads
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    return; // Non-JSON messages are ignored
  }

  if (topic === "frigate/events") {
    const after = data.after as Record<string, unknown> | undefined;
    const before = data.before as Record<string, unknown> | undefined;

    // Validate thumbnail ID is safe before constructing URL
    const eventId = String(after?.id || before?.id || "");
    if (!/^[a-zA-Z0-9._-]+$/.test(eventId)) {
      return;
    }
    const thumbnailUrl = `/api/cameras/events/${eventId}/thumbnail`;
    const cameraName = String(after?.camera || before?.camera || "");
    const label = String(after?.label || before?.label || "");
    const score = Number(after?.top_score || before?.top_score || 0);

    // Frigate publishes "new" | "update" | "end". Unknown types are
    // ignored by the gate (drop_stale) — no broadcast, no push.
    const rawType = String(data.type ?? "new");
    const frigateType: "new" | "update" | "end" =
      rawType === "new" || rawType === "update" || rawType === "end"
        ? rawType
        : "new";

    const decision = processCameraEvent({
      cameraName,
      eventId,
      frigateType,
      now: Date.now(),
    });

    switch (decision.kind) {
      case "accept_new": {
        // Notify on detection: SSE toast + push fan-out.
        broadcastSSE({
          type: "detection",
          camera: cameraName,
          label,
          score,
          thumbnail: thumbnailUrl,
          eventId,
          timestamp: Date.now(),
        });
        cacheDel(CACHE_KEY_EVENTS);

        if (label) {
          void dispatchDetectionEvent(prisma, {
            eventId,
            cameraName,
            label,
            score,
            thumbnailUrl,
          }).catch((err) =>
            logger.warn({ err, eventId }, "push dispatch failed"),
          );
        }
        break;
      }
      case "accept_update": {
        // Live confidence updates flow through SSE as a distinct type
        // so the cameras page can render them. Toast / notification
        // center filter on `type === "detection"` and naturally ignore
        // these. No push, no cache bust.
        broadcastSSE({
          type: "detection_update",
          camera: cameraName,
          label,
          score,
          thumbnail: thumbnailUrl,
          eventId,
          timestamp: Date.now(),
        });
        break;
      }
      case "accept_end": {
        // Recording window closed for the active event — let the UI
        // flip to "clip available" and bust the recent-events cache
        // so the new clip shows up. Toast / notification center
        // ignores this type.
        broadcastSSE({
          type: "detection_end",
          camera: cameraName,
          label,
          score,
          thumbnail: thumbnailUrl,
          eventId,
          timestamp: Date.now(),
        });
        cacheDel(CACHE_KEY_EVENTS);
        break;
      }
      case "drop_active":
      case "drop_cooldown":
        // Saturation guard: silently suppress. Log at debug so the
        // suppression is observable but doesn't spam production logs.
        logger.debug(
          { camera: cameraName, eventId, reason: decision.kind },
          "camera event suppressed by gate",
        );
        break;
      case "drop_stale":
        // Tracker noise (update/end without a matching active event).
        // Not an error — just out of scope for the real-time surface.
        break;
    }
  } else if (topic === "droplet/cameras/discovered") {
    const camData = data.camera as Record<string, unknown> | undefined;
    const event: CameraSSEEvent = {
      type: "camera_discovered",
      camera: String(camData?.name || ""),
      data: camData,
      timestamp: Date.now(),
    };
    broadcastSSE(event);

    if (camData?.ip) {
      upsertCameraRecord(prisma, camData).catch((err) =>
        logger.error({ err }, "Failed to upsert camera record")
      );
    }
  }
}

async function upsertCameraRecord(
  prisma: PrismaClient,
  camera: Record<string, unknown>
): Promise<void> {
  // The camera's Frigate key. camera-discovery already derives lower-case
  // [a-z0-9_] names, so this is a no-op for it — but `Camera.name` IS the
  // Frigate key (WARP-3506), so it is enforced here rather than assumed.
  const name = toFrigateKey(String(camera.name || ""));
  if (!name) return;

  // WARP-1847: a discovery event covers two very different things, and the row
  // has to say which. `status: "active"` means camera-discovery verified the
  // stream and committed it to Frigate — a real camera. Anything else
  // (`needs_setup`, `pending`) is a candidate still being re-probed every 30 s,
  // and creating it as `enabled: true` (the schema default this code used to
  // inherit) both put an un-streamable camera in the operator's grid and made
  // the candidate list unmatchable.
  //
  // WARP-3510: that distinction is now an explicit column, `adoption`
  // (ADOPTED | CANDIDATE), no longer inferred from `enabled`. `enabled` is a
  // different thing — the operator's detection toggle — and is written on
  // CREATE only (plus a CANDIDATE's promotion below): POST /cameras/:name/disable
  // writes `enabled: false` for a working camera, and discovery re-publishes
  // that same camera as active, so echoing status into `enabled` would silently
  // undo the operator's disable.
  const isActive = camera.status === "active";
  const ip = String(camera.ip || "");
  const mac = realMac(camera.mac);

  // A camera's identity is its hardware, not the name discovery derived for it
  // this sweep. `_sanitize_camera_name(hostname, ip)` returns `camera_<ip>`
  // until DHCP knows the hostname and the hostname afterwards, so a single
  // camera legitimately arrives under two names over its life — and a
  // `where: { name }` upsert answered that by minting a second row. That is
  // the "one camera, two tiles, neither with a feed" the operator sees:
  // 192.168.9.219 as both `xnv_c8083r_e43022502afd` and `camera_192_168_9_219`.
  //
  // Match on MAC first, then on IP for the window where one side of the pair
  // is still a placeholder. `name` stays in the OR so a row this name already
  // owns is found even when its IP moved — without it the create below would
  // hit the unique constraint on `name`.
  //
  // Find and write are ONE transaction, and every status check that guards a
  // write is in that write's own WHERE (not only in the code that read the
  // row): a row the operator adopts while this merge is in flight must survive.
  const merged = await prisma.$transaction(async (tx) => {
    const matches = await tx.camera.findMany({
      where: {
        OR: [
          ...(mac ? [{ macAddress: { equals: mac, mode: "insensitive" as const } }] : []),
          ...(ip ? [{ ipAddress: ip }] : []),
          { name },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    const sameDevice = sameDeviceRows(matches, name, mac);

    if (sameDevice.length === 0) {
      await tx.camera.create({
        data: {
          name,
          displayName: toDisplayName(name),
          manufacturer: (camera.manufacturer as string) || null,
          model: (camera.model as string) || null,
          ipAddress: ip,
          macAddress: mac,
          enabled: isActive,
          autoDiscovered: true,
          adoption: isActive ? "ADOPTED" : "CANDIDATE",
          lastSeen: new Date(),
        },
      });
      return { deletedCandidates: 0, kept: name, removed: [] as string[] };
    }

    // ADOPTED outranks age. The oldest row used to win outright — and the
    // oldest is usually the discovery placeholder, so when the operator had
    // added the device by hand (a newer, ADOPTED row with no MAC to match on)
    // this merge deleted their live camera and pruned it from Frigate, taking
    // the credentials-bearing stream config with it: the Camera row stores no
    // RTSP URL. Only CANDIDATE rows are ever victims.
    const [survivor, ...others] = rankForSurvival(sameDevice);
    const victims = others.filter((r) => r.adoption === "CANDIDATE");
    const adoptedOthers = others.filter((r) => r.adoption === "ADOPTED");
    if (survivor.adoption === "ADOPTED" && adoptedOthers.length > 0) {
      // Two cameras the operator owns on one device — a second stream profile,
      // or a double add. Neither is ours to delete, and which one is "the"
      // camera is the operator's call: leave both, and say so — once per pair
      // per process, because discovery republishes the device every 30 s.
      const adopted = [survivor.name, ...adoptedOthers.map((r) => r.name)];
      const pair = [...adopted].sort().join("|");
      if (!_warnedSharedDevices.has(pair)) {
        _warnedSharedDevices.add(pair);
        logger.warn({ adopted, mac, ip }, "Two adopted camera rows share one device; leaving both");
      }
    }

    let deletedCandidates = 0;
    if (victims.length > 0) {
      const deleted = await tx.camera.deleteMany({
        where: { id: { in: victims.map((v) => v.id) }, adoption: "CANDIDATE" },
      });
      deletedCandidates = deleted.count;
    }

    await tx.camera.update({
      where: { id: survivor.id },
      data: {
        ipAddress: ip || survivor.ipAddress,
        // Only ever upgrade toward a real MAC — a sweep that lost the DHCP lease
        // must not wipe the hardware address we already learned.
        ...(mac ? { macAddress: mac } : {}),
        manufacturer: (camera.manufacturer as string) || undefined,
        model: (camera.model as string) || undefined,
        lastSeen: new Date(),
      },
    });

    // Rename and promotion are for a CANDIDATE survivor only — never an
    // ADOPTED one, whatever its `enabled` says: Frigate is keyed by the row's
    // exact name and a reconcile prunes any key no row owns, so renaming an
    // adopted row deletes the live camera out from under the operator.
    //
    // A CANDIDATE takes the discovered name when that is a real hostname — or
    // when the camera is ACTIVE, because then the name IS the Frigate key
    // discovery just added, and a row filed under any other name would be
    // pruned as an orphan. It is skipped if a victim could not be deleted
    // (it was adopted meanwhile and still holds the name).
    if (survivor.adoption === "CANDIDATE") {
      const rename =
        survivor.name !== name &&
        (isActive || !isPlaceholderName(name)) &&
        deletedCandidates === victims.length;
      if (rename || isActive) {
        await tx.camera.updateMany({
          where: { id: survivor.id, adoption: "CANDIDATE" },
          data: {
            ...(rename ? { name, displayName: toDisplayName(name) } : {}),
            // Discovery says it is verified and in Frigate: it is a camera now.
            ...(isActive ? { adoption: "ADOPTED", enabled: true } : {}),
          },
        });
      }
    }

    return { deletedCandidates, kept: survivor.name, removed: victims.map((v) => v.name) };
  });

  cacheDel(CACHE_KEY_CAMERAS);

  if (merged.deletedCandidates > 0) {
    logger.info(
      { kept: merged.kept, removed: merged.removed, mac, ip },
      "Merged duplicate camera rows for one physical camera"
    );
    // getCameras() re-adds any Frigate camera absent from the DB, so a merge
    // that only touched the DB would see the duplicate reappear as a phantom
    // tile on the next poll. Best-effort: a Frigate that is down just means
    // the next add/accept/reject/delete reconcile picks this up. The DB
    // snapshot is read inside Frigate's config lock, and the prune refuses to
    // remove any key an ADOPTED row owns (frigate.client.ts), so a merge can
    // never take a live camera out of Frigate.
    try {
      await syncCamerasFromDb(() => readCameraKeySnapshot(prisma));
    } catch (err) {
      logger.warn({ err }, "Frigate prune after duplicate merge failed (non-fatal)");
    }
  }
}

// --- SSE subscriptions ---

function broadcastSSE(event: CameraSSEEvent): void {
  for (const cb of _sseSubscribers) {
    try {
      cb(event);
    } catch {
      // Subscriber may have disconnected
    }
  }
}

/**
 * Subscribe to the live camera stream, filtered to what this subscriber may
 * see (WARP-2982). `scope` is read per event, so a subscriber can refresh
 * it (grant revoked, role changed) without reconnecting. Before this, every
 * broadcast reached every subscriber regardless of per-camera grants.
 */
export function subscribeCameraEvents(
  callback: SSECallback,
  scope: () => CameraScope,
): () => void {
  const scoped: SSECallback = (event) => {
    if (inCameraScope(scope(), event.camera ?? "")) callback(event);
  };
  _sseSubscribers.add(scoped);
  return () => {
    _sseSubscribers.delete(scoped);
  };
}

// --- Camera listing ---

/**
 * Map a camera's RESOLVED Frigate config into the shape `retainsFootage`
 * expects.
 *
 * Reads the resolved tree deliberately: it is what Frigate will actually
 * enforce, inherited defaults included. The authored config is the right
 * source for WRITES (it round-trips; the resolved tree does not), but the
 * wrong one for asking "what is this camera really doing right now".
 *
 * Note the asymmetry in Frigate 0.17's schema — `continuous` and `motion`
 * carry `days` directly, while `alerts` and `detections` nest theirs under
 * `retain`. Reading the wrong depth yields `undefined`, which coerces to
 * "nothing retained" and would put every healthy camera in the warning
 * state. Hence the explicit reads rather than a generic walk.
 */
export function retentionFromFrigateConfig(configEntry: unknown): {
  enabled?: boolean;
  continuousDays: number;
  motionDays: number;
  alertsRetainDays: number;
  detectionsRetainDays: number;
} {
  const record = ((configEntry as Record<string, unknown> | undefined)?.record ??
    {}) as Record<string, Record<string, Record<string, unknown>>>;
  const num = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    enabled: (record as unknown as { enabled?: boolean }).enabled,
    continuousDays: num(record.continuous?.days),
    motionDays: num(record.motion?.days),
    alertsRetainDays: num(record.alerts?.retain?.days),
    detectionsRetainDays: num(record.detections?.retain?.days),
  };
}

/**
 * Per-call budget for the Frigate reads that only ENRICH the camera list
 * (storage usage, the newest segment). A slow Frigate must not hold the whole
 * list — and every tile behind it — for the default ten seconds.
 */
const RECORDING_READ_TIMEOUT_MS = 2000;

/** What `/api/stats` reports per camera; only the two rates read here. */
type CameraStatsEntry = { camera_fps?: number; detection_fps?: number };

type Read<T> = { ok: true; value: T } | { ok: false; err: unknown };

/** Keep a read's failure instead of throwing it away. */
async function settle<T>(read: Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await read };
  } catch (err) {
    return { ok: false, err };
  }
}

export async function getCameras(
  prisma: PrismaClient
): Promise<CameraInfo[]> {
  const cached = await cacheGet<CameraInfo[]>(CACHE_KEY_CAMERAS);
  if (cached) return cached;

  // Fetch from Frigate + DB in parallel.
  //
  // WARP-3511: a failed Frigate read used to be swallowed into `{}`, which is
  // indistinguishable from "Frigate sees no cameras" — so an outage (or the
  // seconds Frigate takes to restart after a settings save) served, and
  // cached, a healthy-looking list with every camera Offline. The failure is
  // kept now and said on every camera's `recording.degraded`.
  const [statsRead, configRead, dbCameras, storageUsage] = await Promise.all([
    settle(fetchCameras()),
    settle(fetchConfig()),
    prisma.camera.findMany({ orderBy: { createdAt: "desc" } }),
    // Enrichment, not a basis for the status: if this fails the usage figures
    // are unknown, and the list is not degraded for it.
    fetchRecordingsStorage({ timeoutMs: RECORDING_READ_TIMEOUT_MS }).catch((err) => {
      logger.warn({ err }, "could not read Frigate storage usage; camera usage is unknown");
      return null;
    }),
  ]);

  // Status and the recording block both rest on stats AND config.
  const degraded = !statsRead.ok || !configRead.ok;
  if (degraded) {
    logger.warn(
      { statsFailed: !statsRead.ok, configFailed: !configRead.ok },
      "Frigate could not be read; serving a degraded camera list",
    );
  }

  const frigateCameras = (statsRead.ok ? statsRead.value : {}) as Record<string, CameraStatsEntry>;
  const configCameras =
    ((configRead.ok ? configRead.value : {}) as { cameras?: Record<string, unknown> }).cameras || {};
  const storageByCamera: Map<string, StorageBytes> = storageUsage
    ? indexStorageByCamera(storageUsage, configCameras)
    : new Map();

  // 🔴 Frame rate says the camera is ALIVE. It says nothing about whether
  // anything is being KEPT — and this used to report "recording" on the
  // strength of `camera_fps > 0` alone. A camera with every retention
  // window at zero decodes, detects, and stores nothing, while the badge
  // told the household their footage was safe (WARP-1974).
  //
  // The config entry is exactly what answers the question. When the config
  // could not be read, retention is UNKNOWN — not "keeps nothing", which
  // would put a false "not saving" warning on every healthy camera — so the
  // frame rate alone decides and `recording.degraded` carries the caveat.
  const retentionOf = (name: string) => retentionFromFrigateConfig(configCameras[name]);
  const retainingOf = (name: string) => (configRead.ok ? retainsFootage(retentionOf(name)) : true);

  // When did each camera last write? Only cameras Frigate can see and that
  // keep something can have — a bounded read each, in parallel, and a failed
  // one leaves that camera's time unknown rather than failing the list.
  const names = [
    ...dbCameras.map((c) => c.name),
    ...Object.keys(frigateCameras).filter((n) => !dbCameras.some((c) => c.name === n)),
  ];
  const lastSegmentEnd = new Map<string, number | null>();
  const lastSegmentReadFailed = new Set<string>();
  if (!degraded) {
    await Promise.all(
      names
        .filter((n) => frigateCameras[n] && retainingOf(n))
        .map(async (n) => {
          lastSegmentEnd.set(
            n,
            await fetchLastRecordingEnd(n, { timeoutMs: RECORDING_READ_TIMEOUT_MS }).catch((err) => {
              logger.debug({ err, camera: n }, "could not read when the camera last saved footage");
              lastSegmentReadFailed.add(n);
              return null;
            }),
          );
        }),
    );
  }

  const recordingOf = (name: string): CameraRecordingState =>
    degraded
      ? degradedRecordingState()
      : buildRecordingState({
          retention: retentionOf(name),
          storage: storageByCamera.get(name),
          lastSegmentEnd: lastSegmentEnd.get(name) ?? null,
          lastSegmentReadFailed: lastSegmentReadFailed.has(name),
        });

  const cameras: CameraInfo[] = [];

  // Merge Frigate status with DB records
  for (const dbCam of dbCameras) {
    const frigateStatus = frigateCameras[dbCam.name];
    const retaining = retainingOf(dbCam.name);

    let status: CameraInfo["status"] = "offline";
    if (frigateStatus) {
      if ((frigateStatus.camera_fps ?? 0) > 0 && !retaining) {
        // Healthy stream, nothing retained. Deliberately NOT "recording",
        // and deliberately not "idle" either — the camera is working; it
        // just has nowhere to put anything.
        status = "live";
      } else if ((frigateStatus.detection_fps ?? 0) > 0) status = "detecting";
      else if ((frigateStatus.camera_fps ?? 0) > 0) status = "recording";
      else status = "idle";
    }

    cameras.push({
      name: dbCam.name,
      displayName: dbCam.displayName,
      manufacturer: dbCam.manufacturer,
      model: dbCam.model,
      ipAddress: dbCam.ipAddress,
      macAddress: dbCam.macAddress,
      enabled: dbCam.enabled,
      autoDiscovered: dbCam.autoDiscovered,
      status,
      lastSeen: dbCam.lastSeen.toISOString(),
      lastDetection: null, // Populated lazily
      recording: recordingOf(dbCam.name),
    });
  }

  // Also include cameras in Frigate not yet in DB
  for (const [name, stats] of Object.entries(frigateCameras)) {
    if (!dbCameras.find((c) => c.name === name)) {
      cameras.push({
        name,
        displayName: name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        manufacturer: null,
        model: null,
        ipAddress: "",
        macAddress: null,
        enabled: true,
        autoDiscovered: false,
        // Same rule as above: a live stream with nothing retained is
        // "live", never "recording".
        status: !((stats?.camera_fps ?? 0) > 0)
          ? "idle"
          : retainingOf(name)
            ? "recording"
            : "live",
        lastSeen: new Date().toISOString(),
        lastDetection: null,
        recording: recordingOf(name),
      });
    }
  }

  // A degraded list is not cached: it heals on the next poll instead of
  // being served as fact for the TTL (same rule as the empty /system status).
  if (!degraded) await cacheSet(CACHE_KEY_CAMERAS, cameras, CACHE_TTL);
  return cameras;
}

/**
 * WARP-1286: drop the cached `cameras:list` so the next getCameras() rebuilds
 * from Frigate + DB instead of serving a stale snapshot for up to CACHE_TTL.
 * The discovery-upsert path invalidates inline; camera mutations that don't go
 * through it (notably DELETE /cameras/:name) must call this, or a removed
 * camera can resurrect on any refetch inside the TTL window.
 */
export async function invalidateCamerasCache(): Promise<void> {
  await cacheDel(CACHE_KEY_CAMERAS);
}

// --- Events ---

export async function getRecentEvents(
  scope: CameraScope,
  limit = 20,
  camera?: string
): Promise<DetectionEvent[]> {
  // WARP-2982: narrow to the caller's cameras BEFORE the limit, so a scoped
  // user gets their `limit` newest events, not a slice of everyone's.
  const cameras = narrowCameraFilter(scope, camera ? [camera] : undefined);
  if (cameras?.length === 0) return [];
  // Narrowed lists get their own namespace: under the bare
  // `cameras:events:<names>` form, a camera named `recent` shared
  // CACHE_KEY_EVENTS — the owner's all-camera list.
  const cacheKey = cameras
    ? `cameras:events:only:${[...cameras].sort().join(",")}`
    : CACHE_KEY_EVENTS;
  const cached = await cacheGet<DetectionEvent[]>(cacheKey);
  // The key names cameras, not a caller: whoever wrote the entry may have
  // had a wider scope than this reader. Re-apply the scope on a hit, the
  // same second check the fetch path below runs.
  if (cached) return cached.filter((e) => inCameraScope(scope, e.camera));

  const rawEvents = await fetchEvents(limit, cameras);
  const events: DetectionEvent[] = (rawEvents as any[])
    .filter((e) => inCameraScope(scope, String(e.camera ?? "")))
    .map((e) => ({
    id: e.id,
    camera: e.camera,
    label: e.label,
    score: e.top_score || e.score || 0,
    startTime: e.start_time,
    endTime: e.end_time || null,
    thumbnail: `/api/cameras/events/${e.id}/thumbnail`,
    hasClip: e.has_clip ?? false,
    hasSnapshot: e.has_snapshot ?? false,
  }));

  await cacheSet(cacheKey, events, CACHE_TTL);
  return events;
}

/**
 * Filtered event listing for the Events page. Cursor is the oldest
 * event's `start_time` from the previous page; the dashboard passes it
 * back as `before` to step into the next batch. Returns `nextCursor:
 * null` when fewer than `limit` rows came back (i.e. end of data with
 * the current filter).
 *
 * Not cached — filter cardinality is unbounded and Frigate's events
 * endpoint is fast (it's just a SQLite scan on its end). Adding a
 * cache here would also make the "newly recorded events appear" UX
 * laggy.
 */
export interface FilteredEventsResult {
  events: EventDetail[];
  nextCursor: number | null;
}

export async function getEventsFiltered(
  filter: FrigateEventFilter,
  scope: CameraScope,
): Promise<FilteredEventsResult> {
  const limit = filter.limit ?? 50;
  const cameras = narrowCameraFilter(scope, filter.cameras);
  const rawEvents = (await fetchEventsFiltered({ ...filter, cameras })) as Array<Record<string, unknown>>;

  const events: EventDetail[] = rawEvents
    .filter((e) => inCameraScope(scope, String(e.camera ?? "")))
    .map((e) => {
    const id = String(e.id);
    const camera = String(e.camera ?? "");
    const hasClip = Boolean(e.has_clip);
    const hasSnapshot = Boolean(e.has_snapshot);
    return {
      id,
      camera,
      label: String(e.label ?? ""),
      score: Number(e.top_score ?? e.score ?? 0),
      startTime: Number(e.start_time ?? 0),
      endTime: e.end_time !== null && e.end_time !== undefined ? Number(e.end_time) : null,
      thumbnail: `/api/cameras/events/${encodeURIComponent(id)}/thumbnail`,
      hasClip,
      hasSnapshot,
      subLabel: e.sub_label ? String(e.sub_label) : null,
      subLabelScore: e.sub_label_score !== null && e.sub_label_score !== undefined
        ? Number(e.sub_label_score)
        : null,
      zones: Array.isArray(e.zones) ? (e.zones as string[]).map(String) : [],
      // Frigate stores retention as `retain_indefinitely`. Default false.
      retainIndefinitely: Boolean(e.retain_indefinitely),
      clipUrl: hasClip
        ? `/api/cameras/clips/event/${encodeURIComponent(id)}`
        : null,
      snapshotUrl: hasSnapshot
        ? `/api/cameras/events/${encodeURIComponent(id)}/snapshot`
        : null,
      // GenAI description lives on Frigate's event payload directly.
      // Field has appeared as `description` (top-level) in newer
      // versions and `data.description` in older — read both.
      description:
        typeof e.description === "string" && e.description.length > 0
          ? e.description
          : (e.data &&
              typeof e.data === "object" &&
              "description" in e.data &&
              typeof (e.data as { description?: unknown }).description === "string")
            ? String((e.data as { description: string }).description)
            : null,
    };
  });

  // If Frigate returned a full page, the next call should fetch events
  // strictly older than the oldest one we just got. Subtract a tiny
  // epsilon (1ms in seconds) so we don't double-include the boundary
  // event — Frigate's `before` is exclusive but only on whole-second
  // precision, and start_times can collide.
  const nextCursor =
    events.length === limit && events.length > 0
      ? Math.min(...events.map((ev) => ev.startTime))
      : null;

  return { events, nextCursor };
}

/**
 * Toggle the retain-indefinitely flag on an event. Thin pass-through
 * to the Frigate client; we expose it as a service function so the
 * route layer doesn't import the client directly (consistent with
 * how the rest of the camera surface is structured).
 */
export async function setEventRetention(
  eventId: string,
  retain: boolean,
): Promise<void> {
  await setEventRetain(eventId, retain);
}

// --- Reviews ---

export interface FilteredReviewsResult {
  reviews: ReviewItem[];
  nextCursor: number | null;
}

export async function getReviewsFiltered(
  filter: FrigateReviewFilter,
  scope: CameraScope,
): Promise<FilteredReviewsResult> {
  const limit = filter.limit ?? 50;
  const cameras = narrowCameraFilter(scope, filter.cameras);
  const raw = (await fetchReviews({ ...filter, cameras })) as Array<Record<string, unknown>>;

  const reviews: ReviewItem[] = raw
    .filter((r) => inCameraScope(scope, String(r.camera ?? "")))
    .map((r) => {
    const id = String(r.id);
    // Frigate nests the cluster's detection list + zones + objects + audio
    // inside `data`. Older payloads leak some fields to the top level —
    // we read both spots so a future Frigate version doesn't break us.
    const data = (r.data as Record<string, unknown> | undefined) ?? {};
    const detectionIds = Array.isArray(data.detections)
      ? (data.detections as unknown[]).map(String)
      : [];
    const objects = Array.isArray(data.objects)
      ? (data.objects as unknown[]).map(String)
      : [];
    const audio = Array.isArray(data.audio)
      ? (data.audio as unknown[]).map(String)
      : [];
    const zones = Array.isArray(data.zones)
      ? (data.zones as unknown[]).map(String)
      : Array.isArray(r.zones)
        ? (r.zones as unknown[]).map(String)
        : [];
    const severity = String(r.severity ?? "detection");
    return {
      id,
      camera: String(r.camera ?? ""),
      startTime: Number(r.start_time ?? 0),
      endTime:
        r.end_time !== null && r.end_time !== undefined
          ? Number(r.end_time)
          : null,
      severity:
        severity === "alert" || severity === "detection" || severity === "significant_motion"
          ? severity
          : "detection",
      hasBeenReviewed: Boolean(r.has_been_reviewed),
      objects,
      audio,
      zones,
      detectionIds,
      // Frigate serves preview clips at /api/review/<id>/preview.{mp4,gif}.
      // We proxy through the orchestrator so camera/file URLs stay LAN-side.
      previewUrl: `/api/cameras/reviews/${encodeURIComponent(id)}/preview`,
      thumbnailUrl: `/api/cameras/reviews/${encodeURIComponent(id)}/thumbnail`,
    };
  });

  const nextCursor =
    reviews.length === limit && reviews.length > 0
      ? Math.min(...reviews.map((rv) => rv.startTime))
      : null;

  return { reviews, nextCursor };
}

export async function setReviewViewed(reviewId: string): Promise<void> {
  await markReviewViewed(reviewId);
}

/**
 * Semantic event search — same DTO shape as `getEventsFiltered` so
 * the dashboard can swap implementations without re-mapping rows.
 * Returns results in Frigate's similarity order; the `score` field
 * on each event reflects the embedding similarity, not the detection
 * confidence (Frigate puts both in the same wire field — we keep
 * its convention to avoid two parallel score fields the UI would
 * have to disambiguate).
 *
 * Frigate's 0.14+ `/api/events/search` requires the optional
 * embeddings stack to be installed; older builds return 404/501.
 * We surface that as a typed "semantic_search_disabled" error which
 * the route translates to 503 + a hint for the operator.
 */
export async function searchEventsSemanticTyped(
  filter: FrigateSearchFilter,
  scope: CameraScope,
): Promise<FilteredEventsResult> {
  const limit = filter.limit ?? 50;
  const cameras = narrowCameraFilter(scope, filter.cameras);
  const raw = (await searchEventsSemantic({ ...filter, cameras })) as Array<Record<string, unknown>>;
  const events: EventDetail[] = raw
    .filter((e) => inCameraScope(scope, String(e.camera ?? "")))
    .map((e) => {
    const id = String(e.id);
    const camera = String(e.camera ?? "");
    const hasClip = Boolean(e.has_clip);
    const hasSnapshot = Boolean(e.has_snapshot);
    return {
      id,
      camera,
      label: String(e.label ?? ""),
      score: Number(e.top_score ?? e.score ?? 0),
      startTime: Number(e.start_time ?? 0),
      endTime: e.end_time !== null && e.end_time !== undefined ? Number(e.end_time) : null,
      thumbnail: `/api/cameras/events/${encodeURIComponent(id)}/thumbnail`,
      hasClip,
      hasSnapshot,
      subLabel: e.sub_label ? String(e.sub_label) : null,
      subLabelScore:
        e.sub_label_score !== null && e.sub_label_score !== undefined
          ? Number(e.sub_label_score)
          : null,
      zones: Array.isArray(e.zones) ? (e.zones as string[]).map(String) : [],
      retainIndefinitely: Boolean(e.retain_indefinitely),
      clipUrl: hasClip
        ? `/api/cameras/clips/event/${encodeURIComponent(id)}`
        : null,
      snapshotUrl: hasSnapshot
        ? `/api/cameras/events/${encodeURIComponent(id)}/snapshot`
        : null,
      // GenAI description lives on Frigate's event payload directly.
      // Field has appeared as `description` (top-level) in newer
      // versions and `data.description` in older — read both.
      description:
        typeof e.description === "string" && e.description.length > 0
          ? e.description
          : (e.data &&
              typeof e.data === "object" &&
              "description" in e.data &&
              typeof (e.data as { description?: unknown }).description === "string")
            ? String((e.data as { description: string }).description)
            : null,
    };
  });
  // Search results aren't time-ordered (similarity rank), so the
  // start_time-based cursor we use for /events doesn't apply here.
  // We just return the page; if the operator wants more, they'll
  // narrow the query.
  const nextCursor =
    events.length === limit && events.length > 0
      ? Math.min(...events.map((ev) => ev.startTime))
      : null;
  return { events, nextCursor };
}

// --- Recordings + timeline ---

/**
 * Coerce Frigate's loose per-hour `motion` into a flat non-negative
 * number. Some versions emit a number, some `{ value, ... }`, some omit
 * it entirely.
 *
 * 🔴 This deliberately does NOT clamp to 0–100. Frigate 0.17's `motion`
 * is an unbounded activity count, not a percentage — one real day on the
 * box reported 11, 3, 954, 160, 0 and 774 across consecutive hours. The
 * previous 0–100 clamp collapsed 954, 774 and 160 to the same value, so
 * every busy hour rendered in the same heat-map tier and the graphic had
 * no dynamic range where it mattered most. Consumers scale against the
 * range they actually receive.
 */
function normaliseMotion(raw: unknown): number {
  let motion = 0;
  if (typeof raw === "number") motion = raw;
  else if (raw && typeof raw === "object" && "value" in raw) {
    const v = (raw as { value: unknown }).value;
    motion = typeof v === "number" ? v : 0;
  }
  if (!Number.isFinite(motion) || motion < 0) return 0;
  return motion;
}

/**
 * Pull the hour-of-day out of one summary entry.
 *
 * 🔴 Frigate 0.17 returns `hours` as an ARRAY, newest-first, each element
 * carrying its own `hour` field as a STRING ("15", "04"). The previous
 * implementation ran `Object.entries()` over it and used the resulting
 * key as the hour — i.e. the ARRAY INDEX. With <= 24 entries every index
 * passes a 0..23 range check, so nothing was dropped and nothing warned:
 * the whole timeline was silently reversed and mislabelled, and the
 * page then turned those bogus hours into playback ranges that Frigate
 * 404s. Measured on the box 2026-08-13 (WARP-1958).
 *
 * `fallbackKey` is the object-shaped path — older Frigate keyed `hours`
 * as a dict of hour -> stats, and that key IS the hour. It is only
 * consulted when the entry has no usable `hour` of its own.
 */
function parseSummaryHour(
  entry: Record<string, unknown>,
  fallbackKey: string | null,
): number | null {
  const own = entry.hour;
  const candidates: unknown[] = fallbackKey === null ? [own] : [own, fallbackKey];
  for (const c of candidates) {
    if (c === undefined || c === null || c === "") continue;
    const n = Number(c);
    if (Number.isInteger(n) && n >= 0 && n <= 23) return n;
  }
  return null;
}

/**
 * Per-day + per-hour recording summary. The dashboard's date picker
 * uses this to grey out days with no recordings, and the timeline
 * scrubber paints hour bands from the retained duration, with motion +
 * event counts layered on top.
 *
 * `timezone` is an IANA zone name (e.g. "America/Los_Angeles"). Frigate
 * buckets days and hours in UTC unless told otherwise, while the browser
 * builds playback ranges in its own local time — passing the caller's
 * zone through is what keeps those two on ONE clock. Omitting it is how
 * a PDT operator ended up requesting 22:00 UTC for 15:00 local.
 */
export async function getRecordingsSummary(
  cameraName: string,
  timezone?: string,
): Promise<RecordingDay[]> {
  const raw = (await fetchRecordingsSummary(cameraName, timezone)) as Array<
    Record<string, unknown>
  >;
  return raw.map((d) => {
    const day = String(d.day ?? "");
    const events = Number(d.events ?? 0);
    const duration = Number(d.duration ?? 0);

    // 0.17 ships an array; older builds shipped a dict keyed by hour.
    // Object.entries() handles both, but ONLY the dict's key is a real
    // hour — for an array it is the index, which is why the entry's own
    // `hour` field wins whenever it is present.
    const rawHours = d.hours;
    const entries: Array<[string | null, Record<string, unknown>]> = Array.isArray(rawHours)
      ? rawHours.map((h) => [null, (h ?? {}) as Record<string, unknown>])
      : Object.entries((rawHours as Record<string, Record<string, unknown>>) ?? {}).map(
          ([k, v]) => [k, (v ?? {}) as Record<string, unknown>],
        );

    const byHour = new Map<number, RecordingHour>();
    for (const [key, h] of entries) {
      const hour = parseSummaryHour(h, key);
      if (hour === null) continue;
      byHour.set(hour, {
        hour,
        events: Number(h.events ?? 0),
        duration: Number(h.duration ?? 0),
        motion: normaliseMotion(h.motion),
        objects: Number(h.objects ?? 0),
      });
    }

    const hours = [...byHour.values()].sort((a, b) => a.hour - b.hour);
    return { day, events, duration, hours };
  });
}

export async function getRecordings(
  cameraName: string,
  after: number,
  before: number,
): Promise<RecordingSegment[]> {
  const raw = (await fetchRecordings(cameraName, after, before)) as Array<Record<string, unknown>>;
  return raw.map((s) => {
    const start = Number(s.start_time ?? 0);
    const end = Number(s.end_time ?? 0);
    return {
      id: String(s.id ?? `${start}-${end}`),
      startTime: start,
      endTime: end,
      duration: Number(s.duration ?? Math.max(0, end - start)),
      motion: Math.max(0, Math.min(100, Number(s.motion ?? 0))),
      objects: Number(s.objects ?? 0),
    };
  });
}

export async function getTimelineEntries(
  cameraName: string,
  after: number,
  before: number,
): Promise<TimelineEntry[]> {
  const raw = (await fetchTimeline(cameraName, after, before)) as Array<Record<string, unknown>>;
  return raw.map((t) => {
    const data = (t.data as Record<string, unknown> | undefined) ?? {};
    const region = data.region as Record<string, unknown> | undefined;
    const _region = region; // reserved for a future "show region overlay" feature
    return {
      timestamp: Number(t.timestamp ?? 0),
      sourceId: String(t.source_id ?? ""),
      classType: String(t.class_type ?? "external"),
      label: String(data.label ?? data.sub_label ?? ""),
      zone: data.zones && Array.isArray(data.zones) && data.zones.length > 0
        ? String((data.zones as unknown[])[0])
        : null,
      score: Number(data.score ?? 0),
    };
  });
}

// --- Stats ---

export async function getStats(): Promise<Record<string, unknown>> {
  return fetchStats();
}

// --- Health ---

export async function isFrigateHealthy(): Promise<boolean> {
  return healthCheck();
}
