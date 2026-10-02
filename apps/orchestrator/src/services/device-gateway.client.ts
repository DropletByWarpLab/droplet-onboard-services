/**
 * Device gateway HTTP client — services/device-gateway (BACnet/IP, Modbus TCP,
 * SNMP, KNX/IP) on the host network, :8084 by default.
 *
 * Same shape as switch.client.ts: thin fetch wrappers with timeouts, the
 * dedicated bearer, internal mTLS when DROPLET_INTERNAL_TLS=1. Errors carry the
 * gateway's own message and status so routes can pass 404/422 through and
 * report 502 (device unreachable) distinctly from 503 (gateway down or its auth
 * not configured).
 */

import { config } from "../config.js";
import { getRequestId } from "../lib/request-context.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";

const GATEWAY_URL = internalBaseUrl(config.DEVICE_GATEWAY_URL);
const DEFAULT_TIMEOUT = 10_000;
/** Discovery waits `timeout` seconds on the wire, plus headroom. */
const DISCOVER_TIMEOUT = 20_000;

export type DeviceProtocol = "bacnet" | "modbus" | "snmp" | "knx";
export type PointValue = boolean | number | string;

export interface GatewayPoint {
  id: string;
  name: string;
  kind: "number" | "boolean" | "text";
  unit?: string | null;
  writable: boolean;
  min?: number | null;
  max?: number | null;
  [k: string]: unknown;
}

export interface GatewayDevice {
  id: string;
  name: string;
  protocol: DeviceProtocol;
  address: string;
  room?: string | null;
  template?: string | null;
  points: GatewayPoint[];
  [k: string]: unknown;
}

export interface PointReading {
  value: PointValue | null;
  error: string | null;
}

export interface DeviceValues {
  device_id: string;
  read_at: string;
  values: Record<string, PointReading>;
}

export interface WriteResult {
  applied: boolean;
  live_writes: boolean;
  plan: { device_id: string; point_id: string; protocol: DeviceProtocol; value: PointValue };
  readback?: PointReading | null;
  written_at?: string;
}

/** A gateway failure with the HTTP status the route should answer with. */
export class DeviceGatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "DeviceGatewayError";
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = config.SERVICE_TOKEN_DEVICE_GATEWAY;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const rid = getRequestId();
  if (rid) headers["x-request-id"] = rid;
  return headers;
}

/** FastAPI puts errors under `detail`, either a string or `{error, detail}`. */
function messageOf(body: unknown, fallback: string): { message: string; code: string } {
  const detail = (body as { detail?: unknown; error?: unknown } | null)?.detail ??
    (body as { error?: unknown } | null)?.error;
  if (typeof detail === "string" && detail) return { message: detail, code: "gateway_error" };
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const d = detail as { error?: unknown; detail?: unknown };
    return {
      message: typeof d.detail === "string" ? d.detail : fallback,
      code: typeof d.error === "string" ? d.error : "gateway_error",
    };
  }
  if (Array.isArray(detail)) {
    // Pydantic validation errors: "loc: msg" per entry.
    const parts = detail.map((e) => {
      const loc = Array.isArray(e?.loc) ? e.loc.join(".") : "";
      return loc ? `${loc}: ${e?.msg}` : String(e?.msg ?? e);
    });
    return { message: parts.join("; "), code: "invalid_device" };
  }
  return { message: fallback, code: "gateway_error" };
}

async function call<T>(
  method: string,
  path: string,
  label: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<T> {
  let resp: Response;
  try {
    resp = await internalFetch(`${GATEWAY_URL}${path}`, {
      method,
      headers: authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new DeviceGatewayError(
      `${label}: device gateway not reachable (${(err as Error).message})`,
      503,
      "gateway_unreachable",
    );
  }
  if (resp.status === 204) return undefined as T;
  const parsed: unknown = await resp.json().catch(() => ({}));
  if (resp.ok) return parsed as T;
  if (resp.status === 403) {
    throw new DeviceGatewayError(
      `${label}: device gateway auth not configured`,
      503,
      "gateway_auth",
    );
  }
  const { message, code } = messageOf(parsed, `${label}: ${resp.status}`);
  // 4xx are the caller's to fix and pass through; a 5xx other than the
  // gateway's own 502 (device unreachable / protocol error) is the gateway failing.
  const status = resp.status < 500 || resp.status === 502 ? resp.status : 503;
  throw new DeviceGatewayError(message, status, code);
}

const enc = encodeURIComponent;

export async function health(): Promise<{ status: string; live_writes: boolean; devices: number }> {
  return call("GET", "/health", "Device gateway health", undefined, 5_000);
}

export async function listDevices(): Promise<GatewayDevice[]> {
  return (await call<{ devices: GatewayDevice[] }>("GET", "/devices", "List devices")).devices;
}

export async function getDevice(id: string): Promise<GatewayDevice> {
  return call("GET", `/devices/${enc(id)}`, "Get device");
}

export async function putDevice(id: string, device: Record<string, unknown>): Promise<GatewayDevice> {
  return call("PUT", `/devices/${enc(id)}`, "Save device", device);
}

export async function deleteDevice(id: string): Promise<void> {
  await call("DELETE", `/devices/${enc(id)}`, "Delete device");
}

export async function readValues(id: string): Promise<DeviceValues> {
  return call("GET", `/devices/${enc(id)}/values`, "Read device");
}

export async function writePoint(id: string, pointId: string, value: PointValue): Promise<WriteResult> {
  return call("POST", `/devices/${enc(id)}/points/${enc(pointId)}/write`, "Write point", { value });
}

export async function discover(protocol: DeviceProtocol, timeout = 3): Promise<{ found: Record<string, unknown>[] }> {
  return call("POST", "/discover", "Discover devices", { protocol, timeout }, DISCOVER_TIMEOUT);
}

export async function templates(): Promise<{ templates: Record<string, unknown>[] }> {
  return call("GET", "/templates", "List templates");
}
