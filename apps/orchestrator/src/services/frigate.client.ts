/**
 * Frigate NVR HTTP client — wraps the Frigate REST API.
 *
 * All camera stream/snapshot access goes through this client so that
 * camera IPs and RTSP URLs are never exposed to external clients.
 */

import pino from "pino";
import { config } from "../config.js";

const logger = pino({ name: "frigate-client" });

const FRIGATE_URL = process.env.FRIGATE_URL || "http://localhost:5000";

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
  const resp = await fetch(`${FRIGATE_URL}/api/stats`);
  if (!resp.ok) throw new Error(`Frigate stats: ${resp.status}`);
  const data = await resp.json();
  return data.cameras ?? {};
}

export async function fetchConfig(): Promise<Record<string, unknown>> {
  const resp = await fetch(`${FRIGATE_URL}/api/config`);
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
  const resp = await fetch(`${FRIGATE_URL}/api/events?${params}`);
  if (!resp.ok) throw new Error(`Frigate events: ${resp.status}`);
  return resp.json();
}

// --- Stats ---

export async function fetchStats(): Promise<Record<string, unknown>> {
  const resp = await fetch(`${FRIGATE_URL}/api/stats`);
  if (!resp.ok) throw new Error(`Frigate stats: ${resp.status}`);
  return resp.json();
}

// --- Snapshots & Streams ---

export async function fetchSnapshot(
  cameraName: string,
  height = 480
): Promise<Response> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/latest.jpg?h=${height}`
  );
  if (!resp.ok) throw new Error(`Frigate snapshot: ${resp.status}`);
  return resp;
}

export async function fetchEventThumbnail(eventId: string): Promise<Response> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/events/${encodeURIComponent(eventId)}/thumbnail.jpg`
  );
  if (!resp.ok) throw new Error(`Frigate thumbnail: ${resp.status}`);
  return resp;
}

// --- Camera control ---

export async function enableDetection(cameraName: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/detect/enable`,
    { method: "POST" }
  );
  if (!resp.ok) throw new Error(`Enable detection: ${resp.status}`);
}

export async function disableDetection(cameraName: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/detect/disable`,
    { method: "POST" }
  );
  if (!resp.ok) throw new Error(`Disable detection: ${resp.status}`);
}

export async function enableRecording(cameraName: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/recordings/enable`,
    { method: "POST" }
  );
  if (!resp.ok) throw new Error(`Enable recording: ${resp.status}`);
}

export async function disableRecording(cameraName: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/${encodeURIComponent(cameraName)}/recordings/disable`,
    { method: "POST" }
  );
  if (!resp.ok) throw new Error(`Disable recording: ${resp.status}`);
}

// --- Config management ---

export async function deleteCamera(cameraName: string): Promise<void> {
  const resp = await fetch(
    `${FRIGATE_URL}/api/config/cameras/${encodeURIComponent(cameraName)}`,
    { method: "DELETE" }
  );
  if (!resp.ok) throw new Error(`Delete camera: ${resp.status}`);
}
