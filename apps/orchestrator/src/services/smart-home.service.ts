/**
 * Smart Home service — business logic over the Home Assistant client.
 *
 * Fetches HA entities, groups them by type, caches in Redis, and provides
 * a clean API for the routes layer. Also auto-accepts discovered devices
 * every 30 seconds for zero-friction onboarding.
 */

import pino from "pino";
import {
  fetchAllStates,
  fetchEntityState,
  callService,
  fetchDiscoveryFlows,
  acceptDiscoveryFlow,
  healthCheck,
  connectWebSocket,
  disconnectWebSocket,
  onStateChanged,
  type HaEntityState,
  type HaStateChangedEvent,
} from "./home-assistant.client.js";
import { cacheGet, cacheSet, cacheDel } from "./cache.service.js";
import type {
  SmartHomeDevice,
  SmartHomeGrouped,
  SmartHomeCategory,
  DiscoveredDevice,
} from "../types/smart-home.js";

const logger = pino({ name: "smart-home" });

const CACHE_KEY = "smart-home:grouped";
const CACHE_TTL = 5; // seconds

let autoAcceptTimer: ReturnType<typeof setInterval> | null = null;
let _initialized = false;

// --- Initialization ---

export async function initSmartHomeService(): Promise<void> {
  const ok = await healthCheck();
  if (!ok) {
    throw new Error("Home Assistant unreachable");
  }

  _initialized = true;
  logger.info("Home Assistant is reachable");

  // Connect WebSocket for real-time state updates
  connectWebSocket();

  // Start auto-accepting discovered devices every 30s
  autoAcceptTimer = setInterval(autoAcceptDiscovered, 30_000);
  // Run once immediately
  autoAcceptDiscovered().catch(() => {});
}

export function isInitialized(): boolean {
  return _initialized;
}

export async function shutdownSmartHomeService(): Promise<void> {
  if (autoAcceptTimer) clearInterval(autoAcceptTimer);
  disconnectWebSocket();
  _initialized = false;
}

// --- Device listing ---

const SUPPORTED_DOMAINS = new Set([
  "light",
  "switch",
  "sensor",
  "binary_sensor",
  "climate",
  "media_player",
  "cover",
  "fan",
  "lock",
  "camera",
  "vacuum",
]);

function categorize(entityId: string): SmartHomeCategory | null {
  const domain = entityId.split(".")[0];
  if (SUPPORTED_DOMAINS.has(domain)) return domain as SmartHomeCategory;
  return null;
}

function toSmartHomeDevice(entity: HaEntityState): SmartHomeDevice | null {
  const category = categorize(entity.entity_id);
  if (!category) return null;
  return {
    entityId: entity.entity_id,
    category,
    name:
      (entity.attributes.friendly_name as string) ||
      entity.entity_id.split(".")[1].replace(/_/g, " "),
    state: entity.state,
    attributes: entity.attributes,
    lastChanged: entity.last_changed,
    lastUpdated: entity.last_updated,
  };
}

function groupDevices(devices: SmartHomeDevice[]): SmartHomeGrouped {
  const grouped: SmartHomeGrouped = {
    lights: [],
    switches: [],
    sensors: [],
    climate: [],
    media: [],
    covers: [],
    other: [],
  };

  for (const d of devices) {
    switch (d.category) {
      case "light":
        grouped.lights.push(d);
        break;
      case "switch":
        grouped.switches.push(d);
        break;
      case "sensor":
      case "binary_sensor":
        grouped.sensors.push(d);
        break;
      case "climate":
        grouped.climate.push(d);
        break;
      case "media_player":
        grouped.media.push(d);
        break;
      case "cover":
        grouped.covers.push(d);
        break;
      default:
        grouped.other.push(d);
        break;
    }
  }

  return grouped;
}

export async function getGroupedDevices(): Promise<SmartHomeGrouped> {
  // Check cache
  const cached = await cacheGet<SmartHomeGrouped>(CACHE_KEY);
  if (cached) return cached;

  const states = await fetchAllStates();
  const devices = states
    .map(toSmartHomeDevice)
    .filter((d): d is SmartHomeDevice => d !== null);
  const grouped = groupDevices(devices);

  await cacheSet(CACHE_KEY, grouped, CACHE_TTL);
  return grouped;
}

export async function getDevice(
  entityId: string
): Promise<SmartHomeDevice | null> {
  const state = await fetchEntityState(entityId);
  return toSmartHomeDevice(state);
}

// --- Commands ---

export async function sendCommand(
  entityId: string,
  service: string,
  data?: Record<string, unknown>
): Promise<void> {
  const domain = entityId.split(".")[0];
  await callService(domain, service, entityId, data);
  await cacheDel(CACHE_KEY);
}

// --- Discovery ---

export async function getDiscovered(): Promise<DiscoveredDevice[]> {
  const flows = await fetchDiscoveryFlows();
  return flows.map((f) => ({
    flowId: f.flow_id,
    handler: f.handler,
    name: f.handler,
    description: f.step_id || "Discovered",
  }));
}

export async function acceptDiscovered(flowId: string): Promise<void> {
  await acceptDiscoveryFlow(flowId);
  await cacheDel(CACHE_KEY);
}

export async function autoAcceptDiscovered(): Promise<void> {
  try {
    const flows = await fetchDiscoveryFlows();
    if (flows.length === 0) return;

    logger.info("Auto-accepting %d discovered device(s)", flows.length);
    for (const flow of flows) {
      try {
        await acceptDiscoveryFlow(flow.flow_id);
        logger.info("Auto-accepted: %s (%s)", flow.handler, flow.flow_id);
      } catch (err) {
        logger.debug("Failed to auto-accept %s: %s", flow.flow_id, err);
      }
    }
    await cacheDel(CACHE_KEY);
  } catch {
    // Non-fatal — discovery API may not be available
  }
}

// --- Real-time subscriptions ---

export function subscribeStateChanges(
  callback: (event: HaStateChangedEvent) => void
): () => void {
  return onStateChanged(callback);
}

// --- Health ---

export async function isHomeAssistantHealthy(): Promise<boolean> {
  return healthCheck();
}
