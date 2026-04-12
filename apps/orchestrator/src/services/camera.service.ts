/**
 * Camera service — business logic over Frigate client + camera discovery.
 *
 * Aggregates Frigate camera status with database metadata, caches results,
 * and subscribes to MQTT for real-time detection events and camera discovery.
 * Provides SSE event subscription for the dashboard.
 */

import pino from "pino";
import mqtt from "mqtt";
import { PrismaClient } from "@prisma/client";
import {
  healthCheck,
  fetchCameras,
  fetchConfig,
  fetchEvents,
  fetchStats,
} from "./frigate.client.js";
import { cacheGet, cacheSet, cacheDel } from "./cache.service.js";
import { config } from "../config.js";
import type {
  CameraInfo,
  DetectionEvent,
  DiscoveredCamera,
  CameraSSEEvent,
} from "../types/camera.js";

const logger = pino({ name: "camera-service" });

const CACHE_KEY_CAMERAS = "cameras:list";
const CACHE_KEY_EVENTS = "cameras:events:recent";
const CACHE_TTL = 5; // seconds

let _mqttClient: mqtt.MqttClient | null = null;
let _initialized = false;

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
    _mqttClient = mqtt.connect(config.MQTT_BROKER, {
      clientId: "orchestrator-cameras",
      clean: true,
    });

    _mqttClient.on("connect", () => {
      logger.info("Camera service connected to MQTT");
      _mqttClient!.subscribe("frigate/events", { qos: 1 });
      _mqttClient!.subscribe("droplet/cameras/discovered", { qos: 1 });
      _mqttClient!.subscribe("frigate/+/status", { qos: 0 });
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
  _initialized = false;
}

// --- MQTT message handling ---

function handleMqttMessage(
  topic: string,
  payload: Buffer,
  prisma: PrismaClient
): void {
  const raw = payload.toString();

  // Frigate status topics send raw "ON"/"OFF" strings (not JSON)
  const statusMatch = topic.match(/^frigate\/([^/]+)\/status$/);
  if (statusMatch) {
    const cameraName = statusMatch[1];
    const isOnline = raw.trim().toUpperCase() === "ON";
    broadcastSSE({
      type: isOnline ? "camera_online" : "camera_offline",
      camera: cameraName,
      timestamp: Date.now(),
    });
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
    const eventId = String(after?.id || "");
    const thumbnailUrl = /^[a-zA-Z0-9._-]+$/.test(eventId)
      ? `/api/cameras/events/${eventId}/thumbnail`
      : undefined;

    const event: CameraSSEEvent = {
      type: "detection",
      camera: String(after?.camera || before?.camera || ""),
      label: String(after?.label || before?.label || ""),
      score: Number(after?.top_score || before?.top_score || 0),
      thumbnail: thumbnailUrl,
      timestamp: Date.now(),
    };
    broadcastSSE(event);
    cacheDel(CACHE_KEY_EVENTS);
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
  const name = String(camera.name || "");
  if (!name) return;

  await prisma.camera.upsert({
    where: { name },
    create: {
      name,
      displayName: name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      manufacturer: (camera.manufacturer as string) || null,
      model: (camera.model as string) || null,
      ipAddress: String(camera.ip || ""),
      macAddress: (camera.mac as string) || null,
      autoDiscovered: true,
      lastSeen: new Date(),
    },
    update: {
      ipAddress: String(camera.ip || ""),
      manufacturer: (camera.manufacturer as string) || undefined,
      model: (camera.model as string) || undefined,
      lastSeen: new Date(),
    },
  });

  cacheDel(CACHE_KEY_CAMERAS);
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

export function subscribeCameraEvents(callback: SSECallback): () => void {
  _sseSubscribers.add(callback);
  return () => {
    _sseSubscribers.delete(callback);
  };
}

// --- Camera listing ---

export async function getCameras(
  prisma: PrismaClient
): Promise<CameraInfo[]> {
  const cached = await cacheGet<CameraInfo[]>(CACHE_KEY_CAMERAS);
  if (cached) return cached;

  // Fetch from Frigate + DB in parallel
  const [frigateCameras, frigateConfig, dbCameras] = await Promise.all([
    fetchCameras().catch(() => ({} as Record<string, unknown>)),
    fetchConfig().catch(() => ({} as Record<string, unknown>)),
    prisma.camera.findMany({ orderBy: { createdAt: "desc" } }),
  ]);

  const configCameras = (frigateConfig as any)?.cameras || {};
  const cameras: CameraInfo[] = [];

  // Merge Frigate status with DB records
  for (const dbCam of dbCameras) {
    const frigateStatus = (frigateCameras as any)?.[dbCam.name];
    const configEntry = configCameras[dbCam.name];

    let status: CameraInfo["status"] = "offline";
    if (frigateStatus) {
      if (frigateStatus.detection_fps > 0) status = "detecting";
      else if (frigateStatus.camera_fps > 0) status = "recording";
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
        status: (stats as any)?.camera_fps > 0 ? "recording" : "idle",
        lastSeen: new Date().toISOString(),
        lastDetection: null,
      });
    }
  }

  await cacheSet(CACHE_KEY_CAMERAS, cameras, CACHE_TTL);
  return cameras;
}

// --- Events ---

export async function getRecentEvents(
  limit = 20,
  camera?: string
): Promise<DetectionEvent[]> {
  const cacheKey = camera
    ? `cameras:events:${camera}`
    : CACHE_KEY_EVENTS;
  const cached = await cacheGet<DetectionEvent[]>(cacheKey);
  if (cached) return cached;

  const rawEvents = await fetchEvents(limit, camera);
  const events: DetectionEvent[] = (rawEvents as any[]).map((e) => ({
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

// --- Stats ---

export async function getStats(): Promise<Record<string, unknown>> {
  return fetchStats();
}

// --- Health ---

export async function isFrigateHealthy(): Promise<boolean> {
  return healthCheck();
}
