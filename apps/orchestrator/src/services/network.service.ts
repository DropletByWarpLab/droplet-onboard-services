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
  RadioDetail,
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

// Full interface enumeration (read-only). Kept OUT of the overview hot path —
// the overview is a short-TTL cached read that feeds the simple view, and a
// per-section ubus fan-out there would slow every Network page load. The table
// uses this dedicated, separately-cached read instead.
export async function getAllInterfaces(): Promise<openwrt.NetworkInterfaceRow[]> {
  const cached = await cacheGet<openwrt.NetworkInterfaceRow[]>(CACHE_KEYS.interfaces);
  if (cached) return cached;

  const rows = await openwrt.fetchAllInterfaces();
  await cacheSet(CACHE_KEYS.interfaces, rows, CACHE_TTL_SHORT);
  return rows;
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

// Read-only host-radio detail (iwinfo). On the single-box hostapd shape there is
// ONE combined host radio that can't be turned off independently (and the live
// UCI/wireless source is empty), so we return supported:false/hostRadio:true as
// the honesty envelope — the UI shows a read-only card with the single-radio
// note and NO enable/disable toggle. We fill ONLY the iwinfo fields actually
// reported (null otherwise → "not reported"), never the design's fabricated
// literals. `broadcasting` is derived from the real iwinfo mode (Master/AP), not
// hardcoded. Same supported-flag pattern as getGuestWifi.
export async function getRadioDetail(): Promise<RadioDetail> {
  const info = await openwrt.fetchRadioInfo();
  const gated = config.DROPLET_AP_MODE === "hostapd";
  const mode = typeof info.mode === "string" ? info.mode : null;
  const broadcasting = mode != null && /master|ap/i.test(mode);
  return {
    supported: !gated,
    hostRadio: gated,
    broadcasting,
    channel: typeof info.channel === "number" ? info.channel : null,
    htmode: typeof info.htmode === "string" ? info.htmode : null,
    txpower: typeof info.txpower === "number" ? info.txpower : null,
    country: typeof info.country === "string" ? info.country : null,
    mode,
  };
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
  // Single-box hostapd shape: the guest network is a SECOND hostapd BSS the
  // in-container OpenWrt has no radio for, so a UCI wifi-iface add is inert.
  // Provision it through the device-bridge (which shells the host script that
  // stands up the BSS + guest subnet + isolated firewall zone) instead. The
  // radio/network args are UCI concepts and do not apply here. Every other shape
  // keeps the UCI path verbatim.
  if (config.DROPLET_AP_MODE === "hostapd") {
    const result = await hostapdBridge.applyGuestWifi(ssid, password);
    await invalidateNetworkCache();
    return result;
  }
  const result = await openwrt.createGuestNetwork(radio, ssid, password, network);
  await invalidateNetworkCache();
  return result;
}

export async function getGuestWifi(): Promise<
  openwrt.GuestWifiStatus & { supported: boolean }
> {
  // Single-box hostapd shape: read live state from the device-bridge, including
  // the radio-derived `supported` flag — guest Wi-Fi is a SECOND BSS, which a
  // single-AP card (iwlwifi/AX210) cannot broadcast, so support is per-box, not
  // a blanket true. A transient bridge read failure degrades to "not available"
  // (supported:false) rather than offering a feature we can't confirm the
  // hardware delivers; the WRITE path surfaces real failures with actionable
  // copy. Every other shape reads the real UCI guest network.
  if (config.DROPLET_AP_MODE === "hostapd") {
    try {
      return await hostapdBridge.guestStatusFromBridge();
    } catch (err) {
      logger.warn(
        { err: (err as Error)?.message },
        "guest Wi-Fi status read via device-bridge failed; reporting unavailable"
      );
      return {
        configured: false,
        enabled: false,
        ssid: null,
        password: null,
        supported: false,
      };
    }
  }
  const status = await openwrt.fetchGuestWifi();
  return { ...status, supported: true };
}

export async function removeGuestWifi(): Promise<openwrt.WriteResult> {
  // Single-box hostapd shape: tear the guest BSS down via the device-bridge.
  if (config.DROPLET_AP_MODE === "hostapd") {
    const result = await hostapdBridge.removeGuestWifi();
    await invalidateNetworkCache();
    return result;
  }
  const result = await openwrt.removeGuestNetwork();
  await invalidateNetworkCache();
  return result;
}

// UPnP / NAT-PMP. Read reflects the box's real state (available=false when
// miniupnpd isn't installed). The write is Tier 2 — exposing automatic port
// opening is a firewall-class change.
export async function getUpnp(): Promise<openwrt.UpnpStatus> {
  return openwrt.fetchUpnp();
}

export async function setUpnp(enabled: boolean): Promise<openwrt.WriteResult> {
  const result = await openwrt.setUpnp(enabled);
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

// LAN DHCP pool range + lease time. The read is unguarded; the write is Tier 2
// (gated by the network-safety evaluator at the route) — reshaping the live
// pool can strand connected clients.
export async function getDhcpPool(): Promise<openwrt.DhcpPool> {
  return openwrt.fetchDhcpPool();
}

export async function setDhcpPool(
  start: number,
  limit: number,
  leasetime: string,
): Promise<openwrt.WriteResult> {
  const result = await openwrt.setDhcpPool(start, limit, leasetime);
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

// --- System controls (hostname / NTP / status-LED / country) ---
//
// hostname (Tier 2) + NTP (Tier 1) are real, editable controls on the
// in-container OpenWrt. Status-LED + country are HONEST-GATED on the single-box
// hostapd shape: the front-panel LEDs are physical on the host SBC (no
// system.led ubus surface in the container) and the AP country is pinned in the
// host hostapd config (the in-container wireless has no live radio). Force their
// supported/editable flags false here so the UI shows an honest "not available"
// state instead of a control that 500s or writes inert UCI — same posture as
// getGuestWifi/getUpnp. The flags are authoritative from DROPLET_AP_MODE here,
// not from the box read.
export async function getSystemControls(): Promise<openwrt.SystemControls> {
  const controls = await openwrt.fetchSystemControls();
  if (config.DROPLET_AP_MODE === "hostapd") {
    return {
      ...controls,
      statusLed: { supported: false, enabled: false },
      country: { value: controls.country.value, editable: false },
    };
  }
  return controls;
}

export async function setHostname(hostname: string): Promise<openwrt.WriteResult> {
  const result = await openwrt.setHostname(hostname);
  await invalidateNetworkCache();
  return result;
}

export async function setNtpEnabled(enabled: boolean): Promise<openwrt.WriteResult> {
  const result = await openwrt.setNtpEnabled(enabled);
  await invalidateNetworkCache();
  return result;
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
