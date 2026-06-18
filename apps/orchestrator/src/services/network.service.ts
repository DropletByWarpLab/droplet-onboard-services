/**
 * Network service — business logic over the OpenWrt client.
 *
 * Fetches router state, caches in Redis, and provides a clean API
 * for the routes layer. Follows the same pattern as matter.service.ts.
 */

import pino from "pino";
import * as openwrt from "./openwrt.client.js";
import * as hostapdBridge from "./hostapd-bridge.service.js";
import { cacheGet, cacheSet, cacheDel } from "./cache.service.js";
import { config } from "../config.js";
import { RouterError } from "../types/router-error.js";
import type {
  NetworkSummary,
  NetworkInterfaces,
  NetworkOverview,
  WirelessStatus,
  WirelessScanResult,
  WirelessClient,
  DhcpLease,
  ConnectedDevice,
  FirewallConfig,
  RouterSystemInfo,
  InterfaceStatus,
  RouterBoardInfo,
  RouterResources,
} from "../types/network.js";

/**
 * Result envelope (WARP-39). Avoids exceptions crossing the service boundary
 * so callers are forced to handle both arms.
 */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

function toRouterError(thrown: unknown, label: string): RouterError {
  if (thrown instanceof RouterError) return thrown;
  return RouterError.unknown(
    thrown instanceof Error ? thrown.message : String(thrown),
    { label, cause: thrown },
  );
}

const logger = pino({ name: "network-service" });

const CACHE_KEYS = {
  overview: "network:overview",
  interfaces: "network:interfaces",
  wireless: "network:wireless",
  leases: "network:leases",
  firewall: "network:firewall",
  system: "network:system",
} as const;

const CACHE_TTL_SHORT = 10; // seconds — status data
const CACHE_TTL_LONG = 30; // seconds — leases, firewall

let _initialized = false;

// --- Initialization ---

export async function initNetworkService(): Promise<void> {
  const ok = await openwrt.healthCheck();
  if (!ok) {
    throw new Error("OpenWrt router unreachable");
  }
  _initialized = true;
  logger.info("OpenWrt router is reachable");
}

export function isNetworkInitialized(): boolean {
  return _initialized;
}

export async function shutdownNetworkService(): Promise<void> {
  _initialized = false;
}

export async function isRouterHealthy(): Promise<boolean> {
  return openwrt.healthCheck();
}

// --- Network overview ---

/**
 * WARP-39: returns a typed Result. Callers MUST handle both arms — no more
 * silent empty defaults masking real failures.
 */
export async function getNetworkOverview(): Promise<Result<NetworkOverview, RouterError>> {
  const cached = await cacheGet<NetworkOverview>(CACHE_KEYS.overview);
  if (cached) return ok(cached);

  try {
    // WARP-826: `routerConnected` is DERIVED from a live reachability probe, not
    // hardcoded `true`. `healthCheck()` mirrors the routing service's `/health`
    // `connected` flag — a real ubus `board_info()` probe — so the flag is honest:
    //   * a reachable LAN-only single-box (WAN handled by the host → the SDK
    //     returns a `present:false` wan stub, NOT an error) reports connected:true
    //     and is ONLINE — WAN-absence must never read as offline; and
    //   * an unreachable router reports connected:false and is OFFLINE, which the
    //     constant `true` could never represent.
    // Run it alongside the status fetches so there's no extra round-trip latency.
    // healthCheck() swallows its own errors and returns false, but `.catch` guards
    // the derivation regardless: a probe hiccup degrades to "not connected", it
    // never throws the whole overview into the 503 arm (a genuine *fetch* failure
    // still does, below — reachability derivation must not mask real summary faults).
    const [interfaces, wireless, systemInfo, leases, routerConnected] =
      await Promise.all([
        openwrt.fetchInterfaces(),
        openwrt.fetchWirelessStatus(),
        openwrt.fetchSystemInfo(),
        openwrt.fetchDhcpLeases(),
        openwrt.healthCheck().catch(() => false),
      ]);

    const overview: NetworkOverview = {
      interfaces,
      wireless,
      system: systemInfo,
      connectedDeviceCount: leases.length,
      routerConnected,
    };

    await cacheSet(CACHE_KEYS.overview, overview, CACHE_TTL_SHORT);
    return ok(overview);
  } catch (thrown) {
    const error = toRouterError(thrown, "Network overview");
    logger.warn(
      { code: error.code, message: error.message },
      "Failed to fetch network overview",
    );
    return err(error);
  }
}

// --- Connected devices ---

export async function getConnectedDevices(): Promise<ConnectedDevice[]> {
  const [leases, wirelessClients] = await Promise.all([
    openwrt.fetchDhcpLeases(),
    openwrt.fetchWirelessClients().catch(() => [] as WirelessClient[]),
  ]);

  // Build a MAC -> wireless client lookup
  const wirelessByMac = new Map<string, WirelessClient>();
  for (const client of wirelessClients) {
    wirelessByMac.set(client.mac.toUpperCase(), client);
  }

  return leases.map((lease) => {
    const wClient = wirelessByMac.get(lease.macaddr.toUpperCase());
    return {
      hostname: lease.hostname || "Unknown",
      ipaddr: lease.ipaddr,
      macaddr: lease.macaddr,
      expire: lease.expire,
      isWireless: !!wClient,
      signal: wClient?.signal,
      rxRate: wClient?.rx_rate,
      txRate: wClient?.tx_rate,
    };
  });
}

// --- Wireless ---

export async function getWifiSettings(): Promise<WirelessStatus> {
  const cached = await cacheGet<WirelessStatus>(CACHE_KEYS.wireless);
  if (cached) return cached;

  const status = await openwrt.fetchWirelessStatus();
  await cacheSet(CACHE_KEYS.wireless, status, CACHE_TTL_SHORT);
  return status;
}

export async function scanWifiNetworks(): Promise<WirelessScanResult[]> {
  return openwrt.scanWireless();
}

// --- DHCP ---

export async function getDhcpLeases(): Promise<DhcpLease[]> {
  const cached = await cacheGet<DhcpLease[]>(CACHE_KEYS.leases);
  if (cached) return cached;

  const leases = await openwrt.fetchDhcpLeases();
  await cacheSet(CACHE_KEYS.leases, leases, CACHE_TTL_LONG);
  return leases;
}

// --- Firewall ---

export async function getFirewallConfig(): Promise<FirewallConfig> {
  const cached = await cacheGet<FirewallConfig>(CACHE_KEYS.firewall);
  if (cached) return cached;

  const [zones, rules, redirects] = await Promise.all([
    openwrt.fetchFirewallZones(),
    openwrt.fetchFirewallRules(),
    openwrt.fetchFirewallRedirects(),
  ]);

  const config: FirewallConfig = { zones, rules, redirects };
  await cacheSet(CACHE_KEYS.firewall, config, CACHE_TTL_LONG);
  return config;
}

// --- System ---

export async function getSystemInfo(): Promise<RouterSystemInfo> {
  const cached = await cacheGet<RouterSystemInfo>(CACHE_KEYS.system);
  if (cached) return cached;

  const info = await openwrt.fetchSystemInfo();
  await cacheSet(CACHE_KEYS.system, info, CACHE_TTL_SHORT);
  return info;
}

// --- Write operations (invalidate cache) ---
//
// WARP-40: every write returns `WriteResult = { operationId: string | null }`.
// Routes surface this to the dashboard so it can poll /operations/:id for the
// apply-vs-rollback outcome.

export async function setWifiSsid(
  radio: string,
  ifaceSection: string,
  ssid: string,
  // WARP-808 review #2: the per-user key for the staged SSID. The SSID write and
  // the password/confirm write are separate HTTP requests, so the staged value
  // is keyed by the authenticated user (isolating concurrent wizard sessions)
  // rather than held in one shared global.
  userId?: string | null
): Promise<openwrt.WriteResult> {
  // WARP-808: on the single-box (hostapd) shape the AP is a raw host hostapd,
  // not a UCI router — a UCI write 500s. STAGE the SSID instead; the password
  // write (which hostapd needs alongside the SSID) does the single AP reload.
  // Every other shape keeps the UCI path verbatim (AC2 regression guard).
  if (config.DROPLET_AP_MODE === "hostapd") {
    hostapdBridge.stageSsid(ssid, userId);
    // A stage isn't an operation record (no safe-apply/rollback for hostapd).
    return { operationId: null };
  }
  const result = await openwrt.setWirelessSsid(radio, ifaceSection, ssid);
  await invalidateNetworkCache();
  return result;
}

export async function setWifiPassword(
  ifaceSection: string,
  password: string,
  // WARP-808 review #2: same per-user key used to stage the SSID; applyWifi
  // consumes that user's staged value (or falls back to the live AP SSID).
  userId?: string | null
): Promise<openwrt.WriteResult> {
  // WARP-808: single-box hostapd shape — APPLY the staged SSID + this PSK via
  // the device-bridge in one call (one AP reload per submit). Other shapes keep
  // the UCI path verbatim.
  if (config.DROPLET_AP_MODE === "hostapd") {
    const result = await hostapdBridge.applyWifi(password, userId);
    await invalidateNetworkCache();
    return result;
  }
  const result = await openwrt.setWirelessPassword(ifaceSection, password);
  await invalidateNetworkCache();
  return result;
}

export async function setWifiChannel(
  radioSection: string,
  channel: string
): Promise<openwrt.WriteResult> {
  const result = await openwrt.setWirelessChannel(radioSection, channel);
  await invalidateNetworkCache();
  return result;
}

// Create the isolated guest Wi-Fi network (own SSID + firewall zone, internet
// only). Tier 2 — gated by the network-safety evaluator at the route boundary.
export async function setGuestWifi(
  radio: string,
  ssid: string,
  password: string,
  network: string = "guest"
): Promise<openwrt.WriteResult> {
  const result = await openwrt.createGuestNetwork(radio, ssid, password, network);
  await invalidateNetworkCache();
  return result;
}

export async function addStaticDhcpLease(
  name: string,
  mac: string,
  ip: string
): Promise<openwrt.WriteResult> {
  const result = await openwrt.addStaticLease(name, mac, ip);
  await invalidateNetworkCache();
  return result;
}

export async function blockDevice(mac: string, name?: string): Promise<openwrt.WriteResult> {
  const result = await openwrt.blockDevice(mac, name);
  await invalidateNetworkCache();
  return result;
}

export async function unblockDevice(mac: string): Promise<openwrt.WriteResult> {
  const result = await openwrt.unblockDevice(mac);
  await invalidateNetworkCache();
  return result;
}

// WARP-613: phone-home egress control. Dispatched by the egress reconciler
// (devices) and the phone-home routes (cameras). See ADR-012.
export async function blockPhoneHome(mac: string): Promise<openwrt.WriteResult> {
  const result = await openwrt.blockPhoneHome(mac);
  await invalidateNetworkCache();
  return result;
}

export async function unblockPhoneHome(mac: string): Promise<openwrt.WriteResult> {
  const result = await openwrt.unblockPhoneHome(mac);
  await invalidateNetworkCache();
  return result;
}

export async function setCameraPhoneHome(blocked: boolean): Promise<openwrt.WriteResult> {
  const result = await openwrt.setCameraPhoneHome(blocked);
  await invalidateNetworkCache();
  return result;
}

export async function addPortForward(
  name: string,
  srcPort: string,
  destIp: string,
  destPort: string,
  proto: string = "tcp"
): Promise<openwrt.WriteResult> {
  const result = await openwrt.addPortForward(name, srcPort, destIp, destPort, proto);
  await invalidateNetworkCache();
  return result;
}

export async function rebootRouter(): Promise<openwrt.WriteResult> {
  return openwrt.rebootRouter();
}

export async function getRouterOperation(opId: string) {
  return openwrt.fetchOperation(opId);
}

// --- Cache helpers ---

async function invalidateNetworkCache(): Promise<void> {
  await Promise.all(
    Object.values(CACHE_KEYS).map((key) => cacheDel(key))
  );
}
