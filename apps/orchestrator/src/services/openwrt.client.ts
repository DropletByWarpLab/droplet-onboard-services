/**
 * OpenWrt routing service client — HTTP wrapper.
 *
 * Talks to the routing microservice (FastAPI) which proxies
 * requests to the OpenWrt ubus JSON-RPC API.
 *
 * Follows the same pattern as home-assistant.client.ts.
 */

import pino from "pino";
import { config } from "../config.js";
import type {
  NetworkSummary,
  NetworkInterfaces,
  InterfaceStatus,
  WirelessStatus,
  WirelessScanResult,
  WirelessClient,
  DhcpLease,
  RouterSystemInfo,
} from "../types/network.js";

const logger = pino({ name: "openwrt-client" });

const BASE_URL = config.ROUTING_SERVICE_URL;

// --- Network ---

export async function fetchNetworkSummary(): Promise<NetworkSummary> {
  const res = await fetch(`${BASE_URL}/network/summary`);
  if (!res.ok) throw new Error(`Router summary: ${res.status} ${res.statusText}`);
  return res.json() as Promise<NetworkSummary>;
}

export async function fetchInterfaces(): Promise<NetworkInterfaces> {
  const res = await fetch(`${BASE_URL}/network/interfaces`);
  if (!res.ok) throw new Error(`Router interfaces: ${res.status}`);
  return res.json() as Promise<NetworkInterfaces>;
}

export async function fetchInterfaceStatus(name: string): Promise<InterfaceStatus> {
  const res = await fetch(`${BASE_URL}/network/interfaces/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Router interface ${name}: ${res.status}`);
  return res.json() as Promise<InterfaceStatus>;
}

export async function setInterfaceUp(name: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/network/interfaces/${encodeURIComponent(name)}/up`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Interface up ${name}: ${res.status}`);
}

export async function setInterfaceDown(name: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/network/interfaces/${encodeURIComponent(name)}/down`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Interface down ${name}: ${res.status}`);
}

// --- Wireless ---

export async function fetchWirelessStatus(): Promise<WirelessStatus> {
  const res = await fetch(`${BASE_URL}/wireless/status`);
  if (!res.ok) throw new Error(`Wireless status: ${res.status}`);
  return res.json() as Promise<WirelessStatus>;
}

export async function scanWireless(device: string = "wlan0"): Promise<WirelessScanResult[]> {
  const res = await fetch(`${BASE_URL}/wireless/scan?device=${encodeURIComponent(device)}`);
  if (!res.ok) throw new Error(`Wireless scan: ${res.status}`);
  const data = await res.json();
  return data.results as WirelessScanResult[];
}

export async function fetchWirelessClients(device: string = "wlan0"): Promise<WirelessClient[]> {
  const res = await fetch(`${BASE_URL}/wireless/clients?device=${encodeURIComponent(device)}`);
  if (!res.ok) throw new Error(`Wireless clients: ${res.status}`);
  const data = await res.json();
  return data.clients as WirelessClient[];
}

export async function setWirelessSsid(
  radio: string,
  ifaceSection: string,
  ssid: string
): Promise<void> {
  const res = await fetch(`${BASE_URL}/wireless/ssid`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ radio, iface_section: ifaceSection, ssid }),
  });
  if (!res.ok) throw new Error(`Set SSID: ${res.status}`);
}

export async function setWirelessPassword(
  ifaceSection: string,
  password: string,
  encryption: string = "sae-mixed"
): Promise<void> {
  const res = await fetch(`${BASE_URL}/wireless/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ iface_section: ifaceSection, password, encryption }),
  });
  if (!res.ok) throw new Error(`Set password: ${res.status}`);
}

export async function setWirelessChannel(
  radioSection: string,
  channel: string
): Promise<void> {
  const res = await fetch(`${BASE_URL}/wireless/channel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ radio_section: radioSection, channel }),
  });
  if (!res.ok) throw new Error(`Set channel: ${res.status}`);
}

// --- DHCP ---

export async function fetchDhcpLeases(): Promise<DhcpLease[]> {
  const res = await fetch(`${BASE_URL}/dhcp/leases`);
  if (!res.ok) throw new Error(`DHCP leases: ${res.status}`);
  const data = await res.json();
  return data.leases as DhcpLease[];
}

export async function addStaticLease(
  name: string,
  mac: string,
  ip: string,
  leasetime: string = "infinite"
): Promise<void> {
  const res = await fetch(`${BASE_URL}/dhcp/static-lease`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mac, ip, leasetime }),
  });
  if (!res.ok) throw new Error(`Add static lease: ${res.status}`);
}

export async function setDnsServers(servers: string[]): Promise<void> {
  const res = await fetch(`${BASE_URL}/dhcp/dns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ servers }),
  });
  if (!res.ok) throw new Error(`Set DNS: ${res.status}`);
}

// --- Firewall ---

export async function fetchFirewallZones(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/firewall/zones`);
  if (!res.ok) throw new Error(`Firewall zones: ${res.status}`);
  return res.json();
}

export async function fetchFirewallRules(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/firewall/rules`);
  if (!res.ok) throw new Error(`Firewall rules: ${res.status}`);
  return res.json();
}

export async function fetchFirewallRedirects(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/firewall/redirects`);
  if (!res.ok) throw new Error(`Firewall redirects: ${res.status}`);
  return res.json();
}

export async function blockDevice(mac: string, name?: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/firewall/block-device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac, name }),
  });
  if (!res.ok) throw new Error(`Block device: ${res.status}`);
}

export async function unblockDevice(mac: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/firewall/unblock-device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac }),
  });
  if (!res.ok) throw new Error(`Unblock device: ${res.status}`);
}

export async function addPortForward(
  name: string,
  srcPort: string,
  destIp: string,
  destPort: string,
  proto: string = "tcp"
): Promise<void> {
  const res = await fetch(`${BASE_URL}/firewall/port-forward`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      src_port: srcPort,
      dest_ip: destIp,
      dest_port: destPort,
      proto,
    }),
  });
  if (!res.ok) throw new Error(`Add port forward: ${res.status}`);
}

// --- System ---

export async function fetchSystemInfo(): Promise<RouterSystemInfo> {
  const res = await fetch(`${BASE_URL}/system/info`);
  if (!res.ok) throw new Error(`System info: ${res.status}`);
  return res.json() as Promise<RouterSystemInfo>;
}

export async function rebootRouter(): Promise<void> {
  const res = await fetch(`${BASE_URL}/system/reboot`, { method: "POST" });
  if (!res.ok) throw new Error(`Reboot: ${res.status}`);
}

// --- Health ---

export async function healthCheck(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${BASE_URL}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const data = await res.json();
    return data.connected === true;
  } catch {
    return false;
  }
}
