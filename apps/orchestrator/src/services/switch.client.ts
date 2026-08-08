/**
 * Managed switch HTTP client — wraps the switch service REST API.
 *
 * Follows the same pattern as openwrt.client.ts: thin fetch wrappers
 * with timeouts. All calls go to the switch service (default :8081),
 * which in turn talks to the hardware via the active driver.
 */

import { config } from "../config.js";
import { getRequestId } from "../lib/request-context.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";
import type { SwitchProvisionConfig, SwitchRawPortStatus } from "../types/switch.js";
import { SwitchAuthError } from "../types/switch-error.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("switch-client");

// WARP-236: https:// + client cert when internal mTLS is on (identity when off).
const SWITCH_URL = internalBaseUrl(config.SWITCH_SERVICE_URL);
const DEFAULT_TIMEOUT = 10_000;

function timeout(ms = DEFAULT_TIMEOUT): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * Throw on a non-ok switch response, classifying a 403 as the distinct
 * SwitchAuthError (PR #709 DECISION 1/3). The switch service fails CLOSED with
 * 403 when SERVICE_SECRET is unset, or when the orchestrator's bearer is
 * missing/wrong — both mean the orchestrator↔switch auth seam is broken, which
 * must surface distinctly rather than be swallowed by the §7 aggregation's
 * safe() wrapper as "no switch present" (the 503 a genuinely-absent switch
 * raises stays a generic Error so safe() can degrade it to the empty state).
 */
function throwIfNotOk(resp: Response, label: string): void {
  if (resp.ok) return;
  if (resp.status === 403) {
    throw new SwitchAuthError(`${label}: 403 (switch auth not configured)`, {
      status: 403,
      label,
    });
  }
  throw new Error(`${label}: ${resp.status}`);
}

/**
 * A switch write's response. `dry_run:true` (with `status:"planned"`) means the
 * service STAGED the change but did NOT apply it — SWITCH_LIVE_WRITES=0. Carrying
 * it up to the route is what stops the dashboard reporting a success that never
 * happened (audit 2026-08-06).
 */
export interface SwitchWriteResult {
  status?: string;
  dry_run?: boolean;
  plan?: unknown;
  [k: string]: unknown;
}

/**
 * POST/DELETE a switch write and return its parsed body. On a non-ok response,
 * throw an Error carrying the switch service's OWN message — the PoE guard's 409
 * names the device that would go dark, and a bare "Disable PoE: 409" throws that
 * away. A 403 stays the distinct SwitchAuthError, as throwIfNotOk classifies it.
 */
async function switchWrite(
  path: string,
  label: string,
  init: RequestInit = {},
): Promise<SwitchWriteResult> {
  const resp = await internalFetch(`${SWITCH_URL}${path}`, {
    method: "POST",
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
    signal: init.signal ?? timeout(),
  });
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    if (resp.status === 403) {
      throw new SwitchAuthError(`${label}: 403 (switch auth not configured)`, {
        status: 403,
        label,
      });
    }
    const detail = body?.detail ?? body?.error;
    const message =
      typeof detail === "string" && detail ? detail : `${label}: ${resp.status}`;
    const err = new Error(message) as Error & { status?: number };
    err.status = resp.status;
    throw err;
  }
  return body as SwitchWriteResult;
}

/**
 * Service-to-service auth headers. SERVICE_TOKEN_SWITCH is the dedicated
 * bearer (compose wires the switch container's SERVICE_SECRET to the same
 * value); SERVICE_SECRET is the legacy shared-secret fallback for installs
 * whose .env predates the dedicated token.
 */
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = config.SERVICE_TOKEN_SWITCH || config.SERVICE_SECRET;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const rid = getRequestId();
  if (rid) headers["x-request-id"] = rid;
  return headers;
}

// --- Health ---

export async function healthCheck(): Promise<boolean> {
  return (await switchHealthDetail()).connected;
}

/**
 * Richer /health read: the switch's connectivity AND whether its SERVICE_SECRET
 * is configured (presence only — the service never returns the value). The
 * switch's /health is auth-exempt, so it can read "ok" while every privileged
 * route fails closed (403) on a missing secret. `authConfigured:false` is a
 * WARNING surfaced here so a fail-closed deploy doesn't look healthy-but-empty;
 * it deliberately does NOT flip `connected` (DECISION 2: warn, don't fail).
 *
 * `authConfigured` defaults to true when /health doesn't report the field (older
 * service builds) or is unreachable — we only warn on an explicit false.
 */
export async function switchHealthDetail(): Promise<{
  connected: boolean;
  authConfigured: boolean;
}> {
  try {
    const resp = await internalFetch(`${SWITCH_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { connected: false, authConfigured: true };
    const data = (await resp.json()) as {
      connected?: boolean;
      auth_configured?: boolean;
    };
    const authConfigured = data.auth_configured !== false;
    if (!authConfigured) {
      logger.warn(
        "switch service reports auth_configured=false — SERVICE_SECRET is not " +
          "set on the switch service. Privileged switch routes are failing " +
          "closed (403); the dashboard switch panel will show no data. Set " +
          "SERVICE_SECRET (or SWITCH_ALLOW_NO_AUTH=1 for local dev).",
      );
    }
    return { connected: data.connected === true, authConfigured };
  } catch {
    return { connected: false, authConfigured: true };
  }
}

// --- Ports ---

export async function fetchPorts(): Promise<unknown[]> {
  const resp = await internalFetch(`${SWITCH_URL}/ports`, { headers: authHeaders(), signal: timeout() });
  throwIfNotOk(resp, "Switch ports");
  const data = await resp.json();
  return data.ports ?? [];
}

export async function fetchPort(port: number): Promise<unknown> {
  const resp = await internalFetch(`${SWITCH_URL}/ports/${port}`, { headers: authHeaders(), signal: timeout() });
  if (!resp.ok) throw new Error(`Switch port ${port}: ${resp.status}`);
  return resp.json();
}

/** Live link/speed per port (the §7 aggregation's real link source). */
export async function fetchPortStatus(): Promise<SwitchRawPortStatus[]> {
  const resp = await internalFetch(`${SWITCH_URL}/ports/status`, { headers: authHeaders(), signal: timeout() });
  throwIfNotOk(resp, "Switch port status");
  const data = (await resp.json()) as { ports?: SwitchRawPortStatus[] };
  return data.ports ?? [];
}

export async function enablePort(port: number): Promise<SwitchWriteResult> {
  return switchWrite(`/ports/${port}/enable`, "Enable port");
}

export async function disablePort(port: number): Promise<SwitchWriteResult> {
  return switchWrite(`/ports/${port}/disable`, "Disable port");
}

// --- VLANs ---

export async function fetchVlans(): Promise<unknown[]> {
  const resp = await internalFetch(`${SWITCH_URL}/vlans`, { headers: authHeaders(), signal: timeout() });
  throwIfNotOk(resp, "Switch VLANs");
  const data = await resp.json();
  return data.vlans ?? [];
}

export async function createVlan(
  vlanId: number,
  name: string
): Promise<SwitchWriteResult> {
  return switchWrite(`/vlans`, "Create VLAN", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vlan_id: vlanId, name }),
  });
}

export async function deleteVlan(vlanId: number): Promise<SwitchWriteResult> {
  return switchWrite(`/vlans/${vlanId}`, "Delete VLAN", { method: "DELETE" });
}

export async function fetchVlanMembership(vlanId: number): Promise<unknown> {
  const resp = await internalFetch(`${SWITCH_URL}/vlans/${vlanId}/membership`, {
    headers: authHeaders(),
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`VLAN membership: ${resp.status}`);
  return resp.json();
}

/**
 * How a membership write treats the VLAN's EXISTING members.
 *
 * - `merge`   — each entry is an access move: the port becomes the VLAN's
 *               untagged member and every other member is preserved. This is
 *               what "move port 4 to the camera VLAN" means, and the switch
 *               service refuses entries it can't express that way (tagged /
 *               removals) rather than guessing.
 * - `replace` — write the VLAN's whole member list; anything absent is
 *               DROPPED. Only for callers that genuinely computed the full
 *               list.
 *
 * Required, not defaulted: a single-port `replace` on VLAN 1 drops the uplink,
 * the AP and the appliance, so the compiler makes every call site say which it
 * means (audit 2026-08-06).
 */
export type VlanMembershipMode = "merge" | "replace";

export async function setVlanMembership(
  vlanId: number,
  ports: { port: number; tagged: boolean; member: boolean }[],
  mode: VlanMembershipMode
): Promise<SwitchWriteResult> {
  return switchWrite(`/vlans/${vlanId}/membership`, "Set VLAN membership", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ports, mode }),
  });
}

// --- PoE ---

export async function fetchPoeStatus(): Promise<unknown[]> {
  const resp = await internalFetch(`${SWITCH_URL}/poe`, { headers: authHeaders(), signal: timeout() });
  throwIfNotOk(resp, "Switch PoE");
  const data = await resp.json();
  return data.ports ?? [];
}

export async function fetchPortPoe(port: number): Promise<unknown> {
  const resp = await internalFetch(`${SWITCH_URL}/poe/${port}`, { headers: authHeaders(), signal: timeout() });
  if (!resp.ok) throw new Error(`Port PoE: ${resp.status}`);
  return resp.json();
}

export async function enablePortPoe(port: number): Promise<SwitchWriteResult> {
  return switchWrite(`/poe/${port}/enable`, "Enable PoE");
}

export async function disablePortPoe(port: number): Promise<SwitchWriteResult> {
  // No `force` — the switch service's guard (409 PORT_POWERS_MEMBER) must stay
  // active for a dashboard/agent-initiated cut. switchWrite surfaces that 409's
  // message verbatim instead of a bare status code.
  return switchWrite(`/poe/${port}/disable`, "Disable PoE");
}

// --- System ---

export async function fetchSystemInfo(): Promise<unknown> {
  const resp = await internalFetch(`${SWITCH_URL}/system/info`, { headers: authHeaders(), signal: timeout() });
  throwIfNotOk(resp, "Switch system info");
  return resp.json();
}

// --- Provisioning ---

/** Read-only echo of the bring-up provisioning config + persisted state. */
export async function fetchProvisionConfig(): Promise<SwitchProvisionConfig> {
  const resp = await internalFetch(`${SWITCH_URL}/provision/config`, {
    headers: authHeaders(),
    signal: timeout(),
  });
  throwIfNotOk(resp, "Switch provision config");
  return (await resp.json()) as SwitchProvisionConfig;
}

/** Re-run the bring-up provisioner (re-apply the managed layout). */
export async function provisionSwitch(): Promise<SwitchWriteResult> {
  const resp = await internalFetch(`${SWITCH_URL}/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    signal: timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Switch provision: ${resp.status}`);
  return resp.json();
}

// --- WAN Detection ---

export async function detectWanPort(): Promise<unknown> {
  const resp = await internalFetch(`${SWITCH_URL}/wan/detect`, {
    method: "POST",
    headers: authHeaders(),
    signal: timeout(15_000),
  });
  if (!resp.ok) throw new Error(`WAN detection: ${resp.status}`);
  return resp.json();
}

// --- Camera Setup ---

export async function setupCameraPorts(
  vlanId = 100,
  cameraPorts = [1, 2, 3, 4, 5, 6, 7, 8],
  uplinkPorts = [9, 10]
): Promise<SwitchWriteResult> {
  const resp = await internalFetch(`${SWITCH_URL}/setup/cameras`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      vlan_id: vlanId,
      camera_ports: cameraPorts,
      uplink_ports: uplinkPorts,
    }),
    signal: timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Camera setup: ${resp.status}`);
  return resp.json();
}
