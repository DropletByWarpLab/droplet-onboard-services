/**
 * Home Assistant client — HTTP + WebSocket wrapper.
 *
 * REST API for fetching state and sending commands.
 * WebSocket API for real-time state change subscriptions.
 */

import { EventEmitter } from "node:events";
import pino from "pino";
import WebSocket from "ws";
import { config } from "../config.js";

const logger = pino({ name: "ha-client" });

const BASE_URL = config.HOMEASSISTANT_URL;
const TOKEN = config.HOMEASSISTANT_TOKEN;

const headers = (): Record<string, string> => ({
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
});

// --- REST API ---

export async function fetchAllStates(): Promise<HaEntityState[]> {
  const res = await fetch(`${BASE_URL}/api/states`, { headers: headers() });
  if (!res.ok) throw new Error(`HA states: ${res.status} ${res.statusText}`);
  return res.json() as Promise<HaEntityState[]>;
}

export async function fetchEntityState(entityId: string): Promise<HaEntityState> {
  const res = await fetch(`${BASE_URL}/api/states/${entityId}`, { headers: headers() });
  if (!res.ok) throw new Error(`HA state ${entityId}: ${res.status}`);
  return res.json() as Promise<HaEntityState>;
}

export async function callService(
  domain: string,
  service: string,
  entityId: string,
  data?: Record<string, unknown>
): Promise<void> {
  const body = { entity_id: entityId, ...data };
  const res = await fetch(`${BASE_URL}/api/services/${domain}/${service}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HA service ${domain}.${service}: ${res.status}`);
}

export async function fetchDiscoveryFlows(): Promise<HaConfigFlow[]> {
  const res = await fetch(`${BASE_URL}/api/config/config_entries/flow`, {
    headers: headers(),
  });
  if (!res.ok) {
    // This endpoint may not exist on all HA versions
    logger.debug("Discovery flows fetch failed: %d", res.status);
    return [];
  }
  return res.json() as Promise<HaConfigFlow[]>;
}

export async function acceptDiscoveryFlow(flowId: string): Promise<void> {
  const res = await fetch(
    `${BASE_URL}/api/config/config_entries/flow/${flowId}`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    }
  );
  if (!res.ok) {
    logger.warn("Failed to accept discovery flow %s: %d", flowId, res.status);
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${BASE_URL}/api/`, {
      headers: headers(),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

// --- WebSocket API ---

const stateEvents = new EventEmitter();
let ws: WebSocket | null = null;
let wsMessageId = 1;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function onStateChanged(
  callback: (event: HaStateChangedEvent) => void
): () => void {
  stateEvents.on("state_changed", callback);
  return () => stateEvents.off("state_changed", callback);
}

export function connectWebSocket(): void {
  if (!TOKEN) {
    logger.debug("No HA token configured, skipping WebSocket");
    return;
  }

  const wsUrl = BASE_URL.replace(/^http/, "ws") + "/api/websocket";
  logger.info("Connecting to HA WebSocket: %s", wsUrl);

  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    logger.info("HA WebSocket connected");
    reconnectDelay = 1000;
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      _handleMessage(msg);
    } catch (err) {
      logger.debug("Failed to parse HA WS message: %s", err);
    }
  });

  ws.on("close", () => {
    logger.warn("HA WebSocket closed, reconnecting in %dms", reconnectDelay);
    _scheduleReconnect();
  });

  ws.on("error", (err) => {
    logger.error("HA WebSocket error: %s", err.message);
    ws?.close();
  });
}

function _handleMessage(msg: Record<string, unknown>): void {
  const type = msg.type as string;

  if (type === "auth_required") {
    ws?.send(JSON.stringify({ type: "auth", access_token: TOKEN }));
    return;
  }

  if (type === "auth_ok") {
    logger.info("HA WebSocket authenticated");
    // Subscribe to state changes
    ws?.send(
      JSON.stringify({
        id: wsMessageId++,
        type: "subscribe_events",
        event_type: "state_changed",
      })
    );
    // Start heartbeat
    _startHeartbeat();
    return;
  }

  if (type === "auth_invalid") {
    logger.error("HA WebSocket auth failed — check HOMEASSISTANT_TOKEN");
    ws?.close();
    return;
  }

  if (type === "event") {
    const event = msg.event as Record<string, unknown> | undefined;
    if (event?.event_type === "state_changed") {
      stateEvents.emit("state_changed", event.data);
    }
    return;
  }
}

function _startHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id: wsMessageId++, type: "ping" }));
    }
  }, 30_000);
}

function _scheduleReconnect(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    connectWebSocket();
  }, reconnectDelay);
}

export function disconnectWebSocket(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws?.close();
  ws = null;
}

// --- HA types (internal) ---

export interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HaConfigFlow {
  flow_id: string;
  handler: string;
  context: Record<string, unknown>;
  step_id?: string;
}

export interface HaStateChangedEvent {
  entity_id: string;
  old_state: HaEntityState | null;
  new_state: HaEntityState | null;
}
