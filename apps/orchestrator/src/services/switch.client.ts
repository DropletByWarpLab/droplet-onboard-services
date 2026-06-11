/**
 * Managed switch HTTP client — wraps the switch service REST API.
 *
 * Follows the same pattern as openwrt.client.ts: thin fetch wrappers
 * with timeouts. All calls go to the switch service (default :8081),
 * which in turn talks to the hardware via the active driver.
 */

import { config } from "../config.js";
import type { SwitchProvisionConfig, SwitchRawPortStatus } from "../types/switch.js";

const SWITCH_URL = config.SWITCH_SERVICE_URL;
const DEFAULT_TIMEOUT = 10_000;

function timeout(ms = DEFAULT_TIMEOUT): AbortSignal {
  return AbortSignal.timeout(ms);
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
  return headers;
}

// --- Health ---

export async function healthCheck(): Promise<boolean> {
  try {
    const resp = await fetch(`${SWITCH_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.connected === true;
  } catch {
    return false;
  }
}

// --- Ports ---

export async function fetchPorts(): Promise<unknown[]> {
  const resp = await fetch(`${SWITCH_URL}/ports`, { headers: authHeaders(), signal: timeout() });
  if (!resp.ok) throw new Error(`Switch ports: ${resp.status}`);
  const data = await resp.json();
  return data.ports ?? [];
}

export async function fetchPort(port: number): Promise<unknown> {
  const resp = await fetch(`${SWITCH_URL}/ports/${port}`, { headers: authHeaders(), signal: timeout() });
  if (!resp.ok) throw new Error(`Switch port ${port}: ${resp.status}`);
  return resp.json();
}

/** Live link/speed per port (the §7 aggregation's real link source). */
export async function fetchPortStatus(): Promise<SwitchRawPortStatus[]> {
  const resp = await fetch(`${SWITCH_URL}/ports/status`, { headers: authHeaders(), signal: timeout() });
  if (!resp.ok) throw new Error(`Switch port status: ${resp.status}`);
  const data = (await resp.json()) as { ports?: SwitchRawPortStatus[] };
  return data.ports ?? [];
}

export async function enablePort(port: number): Promise<void> {
  const resp = await fetch(`${SWITCH_URL}/ports/${port}/enable`, {
    method: "POST",
    headers: authHeaders(),
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`Enable port: ${resp.status}`);
}

export async function disablePort(port: number): Promise<void> {
  const resp = await fetch(`${SWITCH_URL}/ports/${port}/disable`, {
    method: "POST",
    headers: authHeaders(),
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`Disable port: ${resp.status}`);
}

// --- VLANs ---

export async function fetchVlans(): Promise<unknown[]> {
  const resp = await fetch(`${SWITCH_URL}/vlans`, { headers: authHeaders(), signal: timeout() });
  if (!resp.ok) throw new Error(`Switch VLANs: ${resp.status}`);
  const data = await resp.json();
  return data.vlans ?? [];
}

export async function createVlan(
  vlanId: number,
  name: string
): Promise<void> {
  const resp = await fetch(`${SWITCH_URL}/vlans`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ vlan_id: vlanId, name }),
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`Create VLAN: ${resp.status}`);
}

export async function deleteVlan(vlanId: number): Promise<void> {
  const resp = await fetch(`${SWITCH_URL}/vlans/${vlanId}`, {
    method: "DELETE",
    headers: authHeaders(),
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`Delete VLAN: ${resp.status}`);
}

export async function fetchVlanMembership(vlanId: number): Promise<unknown> {
  const resp = await fetch(`${SWITCH_URL}/vlans/${vlanId}/membership`, {
    headers: authHeaders(),
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`VLAN membership: ${resp.status}`);
  return resp.json();
}

export async function setVlanMembership(
  vlanId: number,
  ports: { port: number; tagged: boolean; member: boolean }[]
): Promise<void> {
  const resp = await fetch(`${SWITCH_URL}/vlans/${vlanId}/membership`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ ports }),
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`Set VLAN membership: ${resp.status}`);
}

// --- PoE ---

export async function fetchPoeStatus(): Promise<unknown[]> {
  const resp = await fetch(`${SWITCH_URL}/poe`, { headers: authHeaders(), signal: timeout() });
  if (!resp.ok) throw new Error(`Switch PoE: ${resp.status}`);
  const data = await resp.json();
  return data.ports ?? [];
}

export async function fetchPortPoe(port: number): Promise<unknown> {
  const resp = await fetch(`${SWITCH_URL}/poe/${port}`, { headers: authHeaders(), signal: timeout() });
  if (!resp.ok) throw new Error(`Port PoE: ${resp.status}`);
  return resp.json();
}

export async function enablePortPoe(port: number): Promise<void> {
  const resp = await fetch(`${SWITCH_URL}/poe/${port}/enable`, {
    method: "POST",
    headers: authHeaders(),
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`Enable PoE: ${resp.status}`);
}

export async function disablePortPoe(port: number): Promise<void> {
  const resp = await fetch(`${SWITCH_URL}/poe/${port}/disable`, {
    method: "POST",
    headers: authHeaders(),
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`Disable PoE: ${resp.status}`);
}

// --- System ---

export async function fetchSystemInfo(): Promise<unknown> {
  const resp = await fetch(`${SWITCH_URL}/system/info`, { headers: authHeaders(), signal: timeout() });
  if (!resp.ok) throw new Error(`Switch system info: ${resp.status}`);
  return resp.json();
}

// --- Provisioning ---

/** Read-only echo of the bring-up provisioning config + persisted state. */
export async function fetchProvisionConfig(): Promise<SwitchProvisionConfig> {
  const resp = await fetch(`${SWITCH_URL}/provision/config`, {
    headers: authHeaders(),
    signal: timeout(),
  });
  if (!resp.ok) throw new Error(`Switch provision config: ${resp.status}`);
  return (await resp.json()) as SwitchProvisionConfig;
}

/** Re-run the bring-up provisioner (re-apply the managed layout). */
export async function provisionSwitch(): Promise<unknown> {
  const resp = await fetch(`${SWITCH_URL}/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    signal: timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Switch provision: ${resp.status}`);
  return resp.json();
}

// --- WAN Detection ---

export async function detectWanPort(): Promise<unknown> {
  const resp = await fetch(`${SWITCH_URL}/wan/detect`, {
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
): Promise<unknown> {
  const resp = await fetch(`${SWITCH_URL}/setup/cameras`, {
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
