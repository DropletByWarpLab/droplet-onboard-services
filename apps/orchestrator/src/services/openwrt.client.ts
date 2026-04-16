/**
 * OpenWrt routing service client — HTTP wrapper.
 *
 * Talks to the routing microservice (FastAPI) which proxies
 * requests to the OpenWrt ubus JSON-RPC API.
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
const TOKEN = config.ROUTING_SERVICE_TOKEN;

if (!TOKEN && process.env.NODE_ENV === "production") {
  logger.warn(
    "ROUTING_SERVICE_TOKEN is empty in production — routing service may reject requests",
  );
}

type RoutingFetchInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
  label?: string;
};

async function routingFetch(path: string, init: RoutingFetchInit = {}): Promise<Response> {
  const { headers = {}, label, ...rest } = init;
  const merged: Record<string, string> = { ...headers };
  if (TOKEN) {
    merged["Authorization"] = `Bearer ${TOKEN}`;
  }
  const res = await fetch(`${BASE_URL}${path}`, { ...rest, headers: merged });
  if (!res.ok) {
    throw new Error(`${label ?? path}: ${res.status} ${res.statusText}`);
  }
  return res;
}

async function routingFetchJson<T>(path: string, init?: RoutingFetchInit): Promise<T> {
  const res = await routingFetch(path, init);
  return res.json() as Promise<T>;
}

function postJson(path: string, body: unknown, label?: string): Promise<Response> {
  return routingFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    label,
  });
}

// --- Network ---

export async function fetchNetworkSummary(): Promise<NetworkSummary> {
  return routingFetchJson<NetworkSummary>("/network/summary", { label: "Router summary" });
}

export async function fetchInterfaces(): Promise<NetworkInterfaces> {
  return routingFetchJson<NetworkInterfaces>("/network/interfaces", { label: "Router interfaces" });
}

export async function fetchInterfaceStatus(name: string): Promise<InterfaceStatus> {
  return routingFetchJson<InterfaceStatus>(
    `/network/interfaces/${encodeURIComponent(name)}`,
    { label: `Router interface ${name}` },
  );
}

export async function setInterfaceUp(name: string): Promise<void> {
  await routingFetch(`/network/interfaces/${encodeURIComponent(name)}/up`, {
    method: "POST",
    label: `Interface up ${name}`,
  });
}

export async function setInterfaceDown(name: string): Promise<void> {
  await routingFetch(`/network/interfaces/${encodeURIComponent(name)}/down`, {
    method: "POST",
    label: `Interface down ${name}`,
  });
}

// --- Wireless ---

export async function fetchWirelessStatus(): Promise<WirelessStatus> {
  return routingFetchJson<WirelessStatus>("/wireless/status", { label: "Wireless status" });
}

export async function scanWireless(device: string = "wlan0"): Promise<WirelessScanResult[]> {
  const data = await routingFetchJson<{ results: WirelessScanResult[] }>(
    `/wireless/scan?device=${encodeURIComponent(device)}`,
    { label: "Wireless scan" },
  );
  return data.results;
}

export async function fetchWirelessClients(device: string = "wlan0"): Promise<WirelessClient[]> {
  const data = await routingFetchJson<{ clients: WirelessClient[] }>(
    `/wireless/clients?device=${encodeURIComponent(device)}`,
    { label: "Wireless clients" },
  );
  return data.clients;
}

export async function setWirelessSsid(
  radio: string,
  ifaceSection: string,
  ssid: string
): Promise<void> {
  await postJson(
    "/wireless/ssid",
    { radio, iface_section: ifaceSection, ssid },
    "Set SSID",
  );
}

export async function setWirelessPassword(
  ifaceSection: string,
  password: string,
  encryption: string = "sae-mixed"
): Promise<void> {
  await postJson(
    "/wireless/password",
    { iface_section: ifaceSection, password, encryption },
    "Set password",
  );
}

export async function setWirelessChannel(
  radioSection: string,
  channel: string
): Promise<void> {
  await postJson(
    "/wireless/channel",
    { radio_section: radioSection, channel },
    "Set channel",
  );
}

// --- DHCP ---

export async function fetchDhcpLeases(): Promise<DhcpLease[]> {
  const data = await routingFetchJson<{ leases: DhcpLease[] }>("/dhcp/leases", {
    label: "DHCP leases",
  });
  return data.leases;
}

export async function addStaticLease(
  name: string,
  mac: string,
  ip: string,
  leasetime: string = "infinite"
): Promise<void> {
  await postJson(
    "/dhcp/static-lease",
    { name, mac, ip, leasetime },
    "Add static lease",
  );
}

export async function setDnsServers(servers: string[]): Promise<void> {
  await postJson("/dhcp/dns", { servers }, "Set DNS");
}

// --- Firewall ---

export async function fetchFirewallZones(): Promise<Record<string, unknown>> {
  return routingFetchJson<Record<string, unknown>>("/firewall/zones", {
    label: "Firewall zones",
  });
}

export async function fetchFirewallRules(): Promise<Record<string, unknown>> {
  return routingFetchJson<Record<string, unknown>>("/firewall/rules", {
    label: "Firewall rules",
  });
}

export async function fetchFirewallRedirects(): Promise<Record<string, unknown>> {
  return routingFetchJson<Record<string, unknown>>("/firewall/redirects", {
    label: "Firewall redirects",
  });
}

export async function blockDevice(mac: string, name?: string): Promise<void> {
  await postJson("/firewall/block-device", { mac, name }, "Block device");
}

export async function unblockDevice(mac: string): Promise<void> {
  await postJson("/firewall/unblock-device", { mac }, "Unblock device");
}

export async function addPortForward(
  name: string,
  srcPort: string,
  destIp: string,
  destPort: string,
  proto: string = "tcp"
): Promise<void> {
  await postJson(
    "/firewall/port-forward",
    { name, src_port: srcPort, dest_ip: destIp, dest_port: destPort, proto },
    "Add port forward",
  );
}

// --- System ---

export async function fetchSystemInfo(): Promise<RouterSystemInfo> {
  return routingFetchJson<RouterSystemInfo>("/system/info", { label: "System info" });
}

export async function rebootRouter(): Promise<void> {
  await routingFetch("/system/reboot", { method: "POST", label: "Reboot" });
}

// --- Health ---

export async function healthCheck(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    // /health is exempt from auth on the routing side (Docker healthcheck); send the
    // token anyway to keep the code path uniform.
    const res = await routingFetch("/health", { signal: controller.signal, label: "Health" });
    clearTimeout(timeout);
    const data = await res.json();
    return data.connected === true;
  } catch {
    return false;
  }
}
