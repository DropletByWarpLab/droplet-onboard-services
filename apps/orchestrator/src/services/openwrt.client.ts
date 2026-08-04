/**
 * OpenWrt routing service client — HTTP wrapper.
 *
 * Talks to the routing microservice (FastAPI) which proxies
 * requests to the OpenWrt ubus JSON-RPC API.
 */

import pino from "pino";
import { config } from "../config.js";
import { getRequestId } from "../lib/request-context.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";
import {
  RouterError,
  routerErrorFromResponse,
  routerErrorFromThrown,
} from "../types/router-error.js";
import type {
  NetworkSummary,
  NetworkInterfaces,
  NetworkInterfaceRow,
  AiNetworkAccess,
  InterfaceStatus,
  WirelessStatus,
  WirelessScanResult,
  WirelessClient,
  DhcpLease,
  RouterSystemInfo,
  SystemControls,
  FirewallZones,
  FirewallRules,
  FirewallRedirects,
} from "../types/network.js";
import {
  FirewallZonesSchema,
  FirewallRulesSchema,
  FirewallRedirectsSchema,
} from "../types/firewall-schema.js";
import { createLogger } from "../lib/logger.js";

export { RouterError } from "../types/router-error.js";
export type { RouterErrorCode } from "../types/router-error.js";
export type { SystemControls, NetworkInterfaceRow, AiNetworkAccess } from "../types/network.js";

const logger = createLogger("openwrt-client");

// WARP-236: https:// + client cert when internal mTLS is on (identity when off).
const BASE_URL = internalBaseUrl(config.ROUTING_SERVICE_URL);
const TOKEN = config.ROUTING_SERVICE_TOKEN;

// ---------------------------------------------------------------------------
// Cold-start log hygiene
// ---------------------------------------------------------------------------
//
// On a fresh boot (factory-reset / reflash) the in-container OpenWrt is
// unreachable for ~1 min while it provisions. During that window the
// reconcile + AP-discovery pollers tick (~10s) and every call throws a
// RouterError(code=UNREACHABLE). Logging those at `warn` produces a
// stack-trace flood on EVERY boot for an entirely EXPECTED warmup state.
//
// We downgrade UNREACHABLE → `debug` only while BOTH hold:
//   1. we have never had a single successful contact with the router, AND
//   2. process uptime is still inside a bounded grace window.
//
// The flag is explicit (set true on the first `res.ok`); we never infer
// "reachable" from the absence of an error. Once the grace expires a
// genuinely-down router escalates back to `warn` so a real outage is never
// silently hidden. Every other code (AUTH/TIMEOUT/…) and any non-RouterError
// stays at `warn` — only the warmup case is quieted.

/**
 * Grace window (ms) after process start during which a never-yet-contacted
 * router's UNREACHABLE errors are logged at `debug` instead of `warn`. Plain
 * exported const (NOT an env var / config-schema key) so it stays a code-level
 * tuning knob, per the ticket constraints.
 */
export const ROUTER_COLDSTART_GRACE_MS = 120_000;

/**
 * Set true the first time OpenWrt is confirmed reachable this process lifetime.
 * For regular `routingFetch` calls (DHCP, wireless, etc.) this flips on the
 * first `res.ok`. For `/health`, which the routing service serves even while
 * OpenWrt is still provisioning, the flag flips only when `data.connected === true`.
 */
let routerContacted = false;

/** Process-start reference the grace window is measured against. */
let routerStartRef = Date.now();

/** Whether the router has ever answered successfully this process lifetime. */
export function hasReachedRouter(): boolean {
  return routerContacted;
}

/**
 * Test-only seam: reset the first-contact flag (and optionally pin the
 * start reference) so cold-start behavior can be exercised deterministically.
 * Not used by production code.
 */
export function _resetRouterContactForTests(opts?: { startRef?: number }): void {
  routerContacted = false;
  routerStartRef = opts?.startRef ?? Date.now();
}

/**
 * Decide the log level for a routing-layer error. UNREACHABLE during the
 * cold-start grace window (never-contacted + uptime < grace) is expected
 * warmup → `debug`; everything else → `warn`. `now` is injectable for tests.
 */
export function routerErrorLogLevel(
  err: unknown,
  now: () => number = Date.now,
): "warn" | "debug" {
  if (err instanceof RouterError && err.code === "UNREACHABLE") {
    const withinGrace = now() - routerStartRef < ROUTER_COLDSTART_GRACE_MS;
    if (!routerContacted && withinGrace) {
      return "debug";
    }
  }
  return "warn";
}

/**
 * Log a routing-layer error at the cold-start-aware level. Centralizes the
 * `logger.debug` vs `logger.warn` branch so every noisy site stays consistent.
 */
export function logRouterError(
  log: pino.Logger,
  err: unknown,
  msg: string,
  ctx: Record<string, unknown> = {},
): void {
  const bindings = { ...ctx, err };
  if (routerErrorLogLevel(err) === "debug") {
    log.debug(bindings, msg);
  } else {
    log.warn(bindings, msg);
  }
}

if (!TOKEN && process.env.NODE_ENV === "production") {
  logger.warn(
    "ROUTING_SERVICE_TOKEN is empty in production — routing service may reject requests",
  );
}

type RoutingFetchInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
  label?: string;
  /** Override retry policy for a single call (e.g. health check, idempotent probes). */
  retry?: Partial<RetryPolicy>;
  /**
   * When true, a `res.ok` response does NOT flip `routerContacted`. Use for
   * probes where HTTP 200 does not confirm OpenWrt itself is reachable — e.g.
   * `/health`, which the routing service returns even while OpenWrt is still
   * provisioning. The caller is responsible for setting `routerContacted` when
   * it has confirmed genuine OpenWrt connectivity.
   */
  skipContactMark?: boolean;
};

export type RetryPolicy = {
  /** Total attempts including the initial one. `1` disables retries. */
  attempts: number;
  /**
   * Delay in ms BEFORE each retry (length = attempts - 1). Clamped to 0. The
   * helper applies ±20% jitter per attempt to avoid thundering herd when many
   * calls fail simultaneously.
   */
  delaysMs: number[];
  /** Injectable for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to `Math.random`. */
  random?: () => number;
};

// WARP-38: 3 total attempts with 100ms then 250ms spacing gives ~350ms of
// resilience against routing-service restarts and brief LAN blips without
// meaningfully delaying 4xx failures (which short-circuit to the caller).
export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  delaysMs: [100, 250],
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function jittered(baseMs: number, random: () => number): number {
  // ±20% jitter; clamp at 0 so negative values don't turn into weird sleeps.
  const jitter = baseMs * 0.2 * (random() * 2 - 1);
  return Math.max(0, Math.round(baseMs + jitter));
}

type AttemptOutcome =
  | { kind: "success"; res: Response }
  | { kind: "abort"; err: RouterError }
  | { kind: "retry"; err: RouterError };

async function singleAttempt(
  url: string,
  init: RequestInit,
  label: string,
): Promise<AttemptOutcome> {
  try {
    const res = await internalFetch(url, init);
    if (res.ok) {
      return { kind: "success", res };
    }
    const err = routerErrorFromResponse(res, label);
    // WARP-39 classification:
    //  - AUTH (401/403) → abort; retrying won't change the token outcome
    //  - 4xx → abort; caller error
    //  - 5xx → retry; transient
    if (err.code === "AUTH" || (res.status >= 400 && res.status < 500)) {
      return { kind: "abort", err };
    }
    return { kind: "retry", err };
  } catch (thrown) {
    const err = routerErrorFromThrown(thrown, label);
    // TIMEOUT (AbortError) is deliberate — never retry.
    if (err.code === "TIMEOUT") {
      return { kind: "abort", err };
    }
    // Network errors (DNS, connection refused, reset) land here — retryable.
    return { kind: "retry", err };
  }
}

/**
 * HTTP helper for the routing service. Adds the shared bearer token (WARP-36),
 * retries transient failures (WARP-38), and converts 4xx into immediate throws.
 * Exported so tests and WARP-39 (typed RouterError) can compose on top.
 */
export async function routingFetch(path: string, init: RoutingFetchInit = {}): Promise<Response> {
  const { headers = {}, label, retry = {}, skipContactMark = false, ...rest } = init;
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...retry };
  const sleep = policy.sleep ?? defaultSleep;
  const random = policy.random ?? Math.random;

  // WARP-44: when ROUTING_MODE=disabled we never hit the network. Every call
  // short-circuits with a typed DISABLED error the dashboard renders as its
  // own banner — avoids spamming retries at a non-existent service.
  if (config.ROUTING_MODE === "disabled") {
    throw RouterError.disabled(label ?? path);
  }

  const merged: Record<string, string> = { ...headers };
  if (TOKEN) {
    merged["Authorization"] = `Bearer ${TOKEN}`;
  }
  const rid = getRequestId();
  if (rid) merged["x-request-id"] = rid;

  const url = `${BASE_URL}${path}`;
  const displayLabel = label ?? path;
  const fetchInit: RequestInit = { ...rest, headers: merged };

  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    const outcome = await singleAttempt(url, fetchInit, displayLabel);
    if (outcome.kind === "success") {
      // First confirmed contact this process lifetime — flips the cold-start
      // grace off so subsequent UNREACHABLE errors escalate to `warn`.
      // Skipped for callers that need to verify the payload before confirming
      // reachability (e.g. /health, which returns 200 while OpenWrt provisions).
      if (!skipContactMark) {
        routerContacted = true;
      }
      return outcome.res;
    }
    if (outcome.kind === "abort") {
      throw outcome.err;
    }
    // retry
    if (attempt >= policy.attempts) {
      throw outcome.err;
    }
    const baseDelay = policy.delaysMs[attempt - 1] ?? policy.delaysMs[policy.delaysMs.length - 1] ?? 0;
    const waitMs = jittered(baseDelay, random);
    // Cold-start hygiene: an UNREACHABLE retry during the boot grace window is
    // expected warmup noise → `debug`; real failures / post-grace stay `warn`.
    const retryBindings = {
      path,
      attempt,
      maxAttempts: policy.attempts,
      code: outcome.err.code,
      status: outcome.err.status,
      err: outcome.err.message,
      waitMs,
    };
    if (routerErrorLogLevel(outcome.err) === "debug") {
      logger.debug(retryBindings, "routing call failed, retrying");
    } else {
      logger.warn(retryBindings, "routing call failed, retrying");
    }
    await sleep(waitMs);
  }

  // Unreachable — the loop always exits via return or throw.
  throw RouterError.unknown(`${displayLabel}: retry loop exited without outcome`, {
    label: displayLabel,
  });
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

/**
 * WARP-40: result of a routing-service write. `operationId` is null when the
 * routing service didn't emit the header (old build, GET fallback, etc.); the
 * dashboard then falls back to polling the target resource directly.
 */
export type WriteResult = { operationId: string | null };

function opFrom(res: Response): WriteResult {
  return { operationId: res.headers.get("X-Operation-Id") };
}

// --- Network ---

export async function fetchNetworkSummary(): Promise<NetworkSummary> {
  return routingFetchJson<NetworkSummary>("/network/summary", { label: "Router summary" });
}

export async function fetchInterfaces(): Promise<NetworkInterfaces> {
  return routingFetchJson<NetworkInterfaces>("/network/interfaces", { label: "Router interfaces" });
}

/** Full interface enumeration (name/device/proto/address/zone/status) — reads
 *  every configured interface, not just lan/wan. Read-only. */
export async function fetchAllInterfaces(): Promise<NetworkInterfaceRow[]> {
  const data = await routingFetchJson<{ interfaces: NetworkInterfaceRow[] }>(
    "/network/interfaces/all",
    { label: "Interface enumeration" },
  );
  return data.interfaces;
}

export async function fetchInterfaceStatus(name: string): Promise<InterfaceStatus> {
  return routingFetchJson<InterfaceStatus>(
    `/network/interfaces/${encodeURIComponent(name)}`,
    { label: `Router interface ${name}` },
  );
}

export async function setInterfaceUp(name: string): Promise<WriteResult> {
  const res = await routingFetch(`/network/interfaces/${encodeURIComponent(name)}/up`, {
    method: "POST",
    label: `Interface up ${name}`,
  });
  return opFrom(res);
}

export async function setInterfaceDown(name: string): Promise<WriteResult> {
  const res = await routingFetch(`/network/interfaces/${encodeURIComponent(name)}/down`, {
    method: "POST",
    label: `Interface down ${name}`,
  });
  return opFrom(res);
}

/** KAN-10: editable fields for an interface create/edit. Only set fields are
 *  sent on the wire; the routing schema validates shape + protocol. */
export interface InterfaceWriteFields {
  proto?: string;
  device?: string;
  ipaddr?: string;
  netmask?: string;
  gateway?: string;
  /** Explicit extra-confirm to allow a management-interface write. */
  force?: boolean;
}

/** KAN-10: create (or overwrite) a `config interface` section. The routing
 *  service wraps the write in safe_apply (60s auto-rollback) and refuses a
 *  management-interface write unless `force` is set. */
export async function createInterface(
  name: string,
  fields: InterfaceWriteFields & { proto: string },
): Promise<WriteResult> {
  const res = await postJson(
    "/network/interfaces",
    { name, ...fields },
    `Create interface ${name}`,
  );
  return opFrom(res);
}

/** KAN-10: update only the supplied options on an existing interface. */
export async function editInterface(
  name: string,
  fields: InterfaceWriteFields,
): Promise<WriteResult> {
  const res = await routingFetch(`/network/interfaces/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
    label: `Edit interface ${name}`,
  });
  return opFrom(res);
}

/** KAN-10: restart the whole networking stack (Tier-3, owner-only). */
export async function restartNetwork(): Promise<WriteResult> {
  const res = await routingFetch("/network/restart", {
    method: "POST",
    label: "Network restart",
  });
  return opFrom(res);
}

// --- Wireless ---

export async function fetchWirelessStatus(): Promise<WirelessStatus> {
  return routingFetchJson<WirelessStatus>("/wireless/status", { label: "Wireless status" });
}

// WARP-815 (K4): `device` is OPTIONAL and has no default. When the caller
// omits it we send no `device` query param so the routing service resolves the
// radio from DROPLET_WIFI_SCAN_DEVICE (see services/routing/droplet_openwrt_sdk.py
// `_default_wifi_scan_device`). A hardcoded `wlan0` default here always overrode that
// env on the wire — and the single-box radio is `wlp14s0`, not `wlan0` — so the
// scan hit a radio the box doesn't have. Rule 12: no host-specific defaults.
// Explicit-device callers still get verbatim forwarding.
export async function scanWireless(
  device?: string,
  opts?: { retry?: RoutingFetchInit["retry"] },
): Promise<WirelessScanResult[]> {
  const query = device ? `?device=${encodeURIComponent(device)}` : "";
  // WARP-816: a scan on an AP/Master-mode radio (single-box) can't run — the
  // routing service returns 409 + `{ code: "SCAN_UNSUPPORTED", message }`.
  // `routingFetch` already throws on any 4xx, converting the response via
  // `routerErrorFromResponse` into a RouterError that PRESERVES the HTTP
  // `status` (a non-auth 4xx maps to code UNKNOWN with `status: res.status`).
  // So we detect the unsupported case by the STATUS CODE on the thrown error
  // (`err.status === 409`) in the catch below — the 409 body itself is never
  // read — and rethrow as the typed `SCAN_UNSUPPORTED` RouterError the
  // dashboard branches on, instead of the generic UNKNOWN that would leak
  // "Wireless scan: 409 Error" to the UI. (This relies on
  // `routerErrorFromResponse` keeping `status` on unknown 4xx — see
  // types/router-error.ts.) Every other status keeps its existing
  // classification (a real fault is never relabelled as unsupported).
  let res: Response;
  try {
    res = await routingFetch(`/wireless/scan${query}`, {
      label: "Wireless scan",
      retry: opts?.retry,
    });
  } catch (err) {
    // The routing service reserves 409 on /wireless/scan for the AP-mode
    // "can't scan here" signal. Rethrow as the typed RouterError carrying the
    // orchestrator's own user-facing copy (the factory default) so the
    // dashboard never sees the generic "Wireless scan: 409 Error" text.
    if (err instanceof RouterError && err.status === 409) {
      throw RouterError.scanUnsupported(undefined, { label: err.label, cause: err });
    }
    throw err;
  }
  const data = (await res.json()) as { results: WirelessScanResult[] };
  return data.results;
}

/** Raw iwinfo radio info (`GET /wireless/radio`). `{}` when the radio is absent
 *  on this box (single-box where the live UCI/wireless source is empty). */
export type RadioInfoWire = {
  channel?: number;
  htmode?: string;
  txpower?: number;
  country?: string;
  mode?: string;
  [key: string]: unknown;
};

export async function fetchRadioInfo(): Promise<RadioInfoWire> {
  return routingFetchJson<RadioInfoWire>("/wireless/radio", { label: "Radio info" });
}

export async function fetchWirelessClients(device?: string): Promise<WirelessClient[]> {
  const query = device ? `?device=${encodeURIComponent(device)}` : "";
  const data = await routingFetchJson<{ clients: WirelessClient[] }>(
    `/wireless/clients${query}`,
    { label: "Wireless clients" },
  );
  return data.clients;
}

export async function setWirelessSsid(
  radio: string,
  ifaceSection: string,
  ssid: string
): Promise<WriteResult> {
  const res = await postJson(
    "/wireless/ssid",
    { radio, iface_section: ifaceSection, ssid },
    "Set SSID",
  );
  return opFrom(res);
}

export async function setWirelessPassword(
  ifaceSection: string,
  password: string,
  encryption: string = "sae-mixed"
): Promise<WriteResult> {
  const res = await postJson(
    "/wireless/password",
    { iface_section: ifaceSection, password, encryption },
    "Set password",
  );
  return opFrom(res);
}

export async function setWirelessChannel(
  radioSection: string,
  channel: string
): Promise<WriteResult> {
  const res = await postJson(
    "/wireless/channel",
    { radio_section: radioSection, channel },
    "Set channel",
  );
  return opFrom(res);
}

/**
 * Create (or re-provision) the isolated guest Wi-Fi network. Maps to the
 * routing service's `POST /wireless/guest` (CreateGuestNetworkRequest →
 * wireless.create_guest_network), which stands up the guest SSID on its own
 * firewall zone — internet only, no reach into the main LAN.
 */
export async function createGuestNetwork(
  radio: string,
  ssid: string,
  password: string,
  network: string = "guest"
): Promise<WriteResult> {
  const res = await postJson(
    "/wireless/guest",
    { radio, ssid, password, network },
    "Create guest network",
  );
  return opFrom(res);
}

export interface GuestWifiStatus {
  /** A guest wifi-iface exists. */
  configured: boolean;
  /** The guest iface is enabled (not uci-disabled). */
  enabled: boolean;
  ssid: string | null;
  /** The guest PSK — returned so the owner dashboard can render the join QR. */
  password: string | null;
}

export async function fetchGuestWifi(): Promise<GuestWifiStatus> {
  return routingFetchJson<GuestWifiStatus>("/wireless/guest", {
    label: "Guest Wi-Fi status",
  });
}

export async function removeGuestNetwork(): Promise<WriteResult> {
  const res = await routingFetch("/wireless/guest", {
    method: "DELETE",
    label: "Remove guest network",
  });
  return opFrom(res);
}

// --- UPnP / NAT-PMP ---

export interface UpnpStatus {
  /** miniupnpd present on the box. False = the secure default (no auto ports). */
  available: boolean;
  /** Automatic port opening currently on. */
  enabled: boolean;
}

export async function fetchUpnp(): Promise<UpnpStatus> {
  return routingFetchJson<UpnpStatus>("/upnp", { label: "UPnP status" });
}

export async function setUpnp(enabled: boolean): Promise<WriteResult> {
  const res = await postJson("/upnp", { enabled }, "Set UPnP");
  return opFrom(res);
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
): Promise<WriteResult> {
  const res = await postJson(
    "/dhcp/static-lease",
    { name, mac, ip, leasetime },
    "Add static lease",
  );
  return opFrom(res);
}

export async function setDnsServers(servers: string[]): Promise<WriteResult> {
  const res = await postJson("/dhcp/dns", { servers }, "Set DNS");
  return opFrom(res);
}

// --- Deployment topology (ADR-018) ---

export type DeploymentPosture =
  | "PRIMARY_ROUTER"
  | "DOWNSTREAM_ROUTER"
  | "UNKNOWN";

export interface NetworkTopology {
  posture: DeploymentPosture;
  evidence?: Record<string, unknown>;
}

// WARP-871: read-only posture probe (GET /network/topology). Lets the dashboard
// tell a primary router apart from a single-box sitting downstream of the
// home router, instead of silently rendering an absent WAN as "offline".
export async function fetchTopology(): Promise<NetworkTopology> {
  return routingFetchJson<NetworkTopology>("/network/topology", {
    label: "Network topology",
  });
}

// --- Static DNS host-records (dnsmasq name → IP) ---

export interface DnsHostRecord {
  section: string;
  hostname: string;
  ip: string;
}

// WARP-871: local DNS names (e.g. nas.lan → 192.168.50.20). Routing /dhcp/
// hostnames has full read/write/delete; these thin client methods front it.
export async function fetchDnsHostnames(): Promise<DnsHostRecord[]> {
  const data = await routingFetchJson<{ entries: DnsHostRecord[] }>(
    "/dhcp/hostnames",
    { label: "DNS hostnames" },
  );
  return data.entries;
}

export async function addDnsHostname(
  hostname: string,
  ip: string,
): Promise<WriteResult> {
  const res = await postJson(
    "/dhcp/hostnames",
    { hostname, ip },
    "Add DNS hostname",
  );
  return opFrom(res);
}

export async function deleteDnsHostname(hostname: string): Promise<WriteResult> {
  const res = await routingFetch(
    `/dhcp/hostnames/${encodeURIComponent(hostname)}`,
    { method: "DELETE", label: "Delete DNS hostname" },
  );
  return opFrom(res);
}

/** LAN DHCP pool range + lease time. Each field can be null when the box omits
 *  it (a default applies — not "broken"). */
export interface DhcpPool {
  start: string | null;
  limit: string | null;
  leasetime: string | null;
}

export async function fetchDhcpPool(): Promise<DhcpPool> {
  return routingFetchJson<DhcpPool>("/dhcp/pool", { label: "DHCP pool" });
}

export async function setDhcpPool(
  start: number,
  limit: number,
  leasetime: string,
): Promise<WriteResult> {
  const res = await postJson("/dhcp/pool", { start, limit, leasetime }, "Set DHCP pool");
  return opFrom(res);
}

// --- Firewall ---

// WARP-42: every firewall response is parsed through a zod schema so schema
// drift on the routing side surfaces as a typed error at this boundary
// instead of an `undefined` blowup deep in dashboard rendering.

export async function fetchFirewallZones(): Promise<FirewallZones> {
  const raw = await routingFetchJson<unknown>("/firewall/zones", {
    label: "Firewall zones",
  });
  return FirewallZonesSchema.parse(raw) as FirewallZones;
}

export async function fetchFirewallRules(): Promise<FirewallRules> {
  const raw = await routingFetchJson<unknown>("/firewall/rules", {
    label: "Firewall rules",
  });
  return FirewallRulesSchema.parse(raw) as FirewallRules;
}

export async function fetchFirewallRedirects(): Promise<FirewallRedirects> {
  const raw = await routingFetchJson<unknown>("/firewall/redirects", {
    label: "Firewall redirects",
  });
  return FirewallRedirectsSchema.parse(raw) as FirewallRedirects;
}

export async function blockDevice(mac: string, name?: string): Promise<WriteResult> {
  const res = await postJson("/firewall/block-device", { mac, name }, "Block device");
  return opFrom(res);
}

export async function unblockDevice(mac: string): Promise<WriteResult> {
  const res = await postJson("/firewall/unblock-device", { mac }, "Unblock device");
  return opFrom(res);
}

// WARP-613: phone-home egress control (ADR-012). A softer block than
// blockDevice — denies WAN egress but keeps NTP + local DNS.
export async function blockPhoneHome(mac: string): Promise<WriteResult> {
  const res = await postJson(
    "/firewall/phone-home/device",
    { mac, blocked: true },
    "Block phone-home",
  );
  return opFrom(res);
}

export async function unblockPhoneHome(mac: string): Promise<WriteResult> {
  const res = await postJson(
    "/firewall/phone-home/device",
    { mac, blocked: false },
    "Unblock phone-home",
  );
  return opFrom(res);
}

export async function setCameraPhoneHome(blocked: boolean): Promise<WriteResult> {
  const res = await postJson(
    "/firewall/phone-home/cameras",
    { blocked },
    "Set camera phone-home",
  );
  return opFrom(res);
}

export async function addPortForward(
  name: string,
  srcPort: string,
  destIp: string,
  destPort: string,
  proto: string = "tcp"
): Promise<WriteResult> {
  const res = await postJson(
    "/firewall/port-forward",
    { name, src_port: srcPort, dest_ip: destIp, dest_port: destPort, proto },
    "Add port forward",
  );
  return opFrom(res);
}

export async function addFirewallRule(opts: {
  name: string;
  src: string;
  dest: string;
  proto?: string;
  destPort?: string;
  srcPort?: string;
  target?: string;
  enabled?: string;
}): Promise<WriteResult> {
  const res = await postJson(
    "/firewall/rule",
    {
      name: opts.name,
      src: opts.src,
      dest: opts.dest,
      proto: opts.proto ?? "tcp",
      dest_port: opts.destPort,
      src_port: opts.srcPort,
      target: opts.target ?? "REJECT",
      enabled: opts.enabled ?? "1",
    },
    "Add firewall rule",
  );
  return opFrom(res);
}

export async function setZonePolicy(opts: {
  zone: string;
  input?: string;
  output?: string;
  forward?: string;
}): Promise<WriteResult> {
  const res = await postJson(
    "/firewall/zone-policy",
    { zone: opts.zone, input: opts.input, output: opts.output, forward: opts.forward },
    "Set zone policy",
  );
  return opFrom(res);
}

// --- System ---

export async function fetchSystemInfo(): Promise<RouterSystemInfo> {
  return routingFetchJson<RouterSystemInfo>("/system/info", { label: "System info" });
}

export async function rebootRouter(): Promise<WriteResult> {
  const res = await routingFetch("/system/reboot", { method: "POST", label: "Reboot" });
  return opFrom(res);
}

// --- System controls (hostname / NTP / status-LED / country) ---

/** Wire shape of GET /system/controls (snake_case from the routing service). */
interface SystemControlsWire {
  hostname: string | null;
  ntp_enabled: boolean;
  status_led: { supported: boolean; enabled: boolean };
  country: { value: string | null; editable: boolean };
}

export async function fetchSystemControls(): Promise<SystemControls> {
  const raw = await routingFetchJson<SystemControlsWire>("/system/controls", {
    label: "System controls",
  });
  return {
    hostname: raw.hostname,
    ntpEnabled: raw.ntp_enabled,
    statusLed: raw.status_led,
    country: raw.country,
  };
}

export async function setHostname(hostname: string): Promise<WriteResult> {
  const res = await postJson("/system/hostname", { hostname }, "Set hostname");
  return opFrom(res);
}

export async function setNtpEnabled(enabled: boolean): Promise<WriteResult> {
  const res = await postJson("/system/ntp", { enabled }, "Set NTP");
  return opFrom(res);
}

// --- KAN-8: router firmware upgrade + factory-reset (PRIMARY_ROUTER only) ---

/** Wire shape of GET /system/firmware-check (snake_case from the routing service). */
interface FirmwareCheckWire {
  current_version: string | null;
  pinned_version: string | null;
  up_to_date: boolean | null;
  upgrade_available: boolean | null;
}

export interface FirmwareCheck {
  currentVersion: string | null;
  pinnedVersion: string | null;
  /** Explicit tri-state: null = undetermined (pinned image carries no version). */
  upToDate: boolean | null;
  upgradeAvailable: boolean | null;
}

/**
 * KAN-8 AC 4 — read the running firmware version and compare it to the pinned
 * image. Read-only; safe on any deployment shape (the dashboard renders this on
 * the Maintenance card before the owner ever arms a flash).
 */
export async function fetchFirmwareCheck(pinnedImage: string): Promise<FirmwareCheck> {
  if (!pinnedImage) {
    // No pinned image configured — return undetermined state without hitting the
    // routing service (FastAPI's min_length=1 Query would reject an empty string).
    return { currentVersion: null, pinnedVersion: null, upToDate: null, upgradeAvailable: null };
  }
  const raw = await routingFetchJson<FirmwareCheckWire>(
    `/system/firmware-check?pinned_image=${encodeURIComponent(pinnedImage)}`,
    { label: "Firmware check" },
  );
  return {
    currentVersion: raw.current_version,
    pinnedVersion: raw.pinned_version,
    upToDate: raw.up_to_date,
    upgradeAvailable: raw.upgrade_available,
  };
}

/**
 * KAN-8 AC 1 — flash a staged OpenWrt sysupgrade image. ⚠️ BRICK RISK. The
 * deployment-shape gate (PRIMARY_ROUTER) and the owner-only Tier-3 confirm are
 * enforced in the service/route layer ABOVE; this is the wire call.
 */
export async function routerSysupgrade(
  imagePath: string,
  preserveConfig: boolean,
): Promise<WriteResult> {
  const res = await postJson(
    "/system/sysupgrade",
    { image_path: imagePath, preserve_config: preserveConfig },
    "Router sysupgrade",
  );
  return opFrom(res);
}

/**
 * KAN-8 AC 1 — wipe the OpenWrt overlay + reboot to defaults. ⚠️ BRICK RISK,
 * gated upstream (PRIMARY_ROUTER + owner-only Tier-3).
 */
export async function routerFactoryReset(): Promise<WriteResult> {
  const res = await routingFetch("/system/factory-reset", {
    method: "POST",
    label: "Router factory reset",
  });
  return opFrom(res);
}

// --- droplet-ai ubus RPC access (read-only) ---

interface AiAccessWire {
  user: string;
  endpoint: string;
  read_scopes: string[];
  write_scopes: string[];
  session: { active: boolean; expires_at: number | null; rotates: string };
}

export async function getAiNetworkAccess(): Promise<AiNetworkAccess> {
  const raw = await routingFetchJson<AiAccessWire>("/ai-access", {
    label: "AI agent access",
  });
  return {
    user: raw.user,
    endpoint: raw.endpoint,
    readScopes: raw.read_scopes,
    writeScopes: raw.write_scopes,
    session: {
      active: raw.session.active,
      expiresAt: raw.session.expires_at,
      rotates: raw.session.rotates,
    },
  };
}

// --- VPN (Remote Access / WireGuard) ---
//
// Thin wrappers over the routing service's /vpn/* surface (Phase 1). Higher-
// level orchestration (IP allocation, DB persistence, .conf rendering) lives
// in services/vpn.service.ts so this client stays a flat HTTP client.

export type VpnInterfaceInfo = {
  interface: string;
  public_key: string;
  listen_port: number | null;
  addresses: string[];
};

export type VpnPeerWire = {
  section: string;
  public_key: string;
  allowed_ips: string[];
  description: string;
  endpoint_host: string;
  persistent_keepalive: string;
  // WARP-1389 — runtime `latest handshake` epoch (seconds; 0 = never/unknown),
  // enriched by the routing /vpn/peers read. Absent on older routing builds.
  latest_handshake?: number;
};

export type VpnSetupResponse = VpnInterfaceInfo & {
  status: "ok";
  created: boolean;
};

export type VpnPeerCreateResponse = {
  status: "ok";
  interface: string;
  public_key: string;
  // ONE-SHOT — never persisted server-side. Caller must hand to user
  // (rendered into a .conf / QR) and discard.
  private_key: string;
  allowed_ips: string[];
  description: string;
  persistent_keepalive: number;
};

export async function vpnSetup(opts?: {
  interface?: string;
  listenPort?: number;
  address?: string;
}): Promise<VpnSetupResponse> {
  const body: Record<string, unknown> = {};
  if (opts?.interface) body.interface = opts.interface;
  if (opts?.listenPort) body.listen_port = opts.listenPort;
  if (opts?.address) body.address = opts.address;
  const res = await postJson("/vpn/setup", body, "VPN setup");
  return res.json() as Promise<VpnSetupResponse>;
}

export async function vpnStatus(
  iface: string = "wg0",
): Promise<(VpnInterfaceInfo & { peer_count: number }) | null> {
  try {
    return await routingFetchJson<VpnInterfaceInfo & { peer_count: number }>(
      `/vpn/status?interface=${encodeURIComponent(iface)}`,
      { label: "VPN status" },
    );
  } catch (err) {
    // 404 = interface not configured yet. Distinct from network errors which
    // we want to bubble up so the caller can decide.
    if (err instanceof RouterError && err.status === 404) return null;
    throw err;
  }
}

export async function listVpnPeers(
  iface: string = "wg0",
): Promise<VpnPeerWire[]> {
  const data = await routingFetchJson<{ interface: string; peers: VpnPeerWire[] }>(
    `/vpn/peers?interface=${encodeURIComponent(iface)}`,
    { label: "VPN peers" },
  );
  return data.peers;
}

export async function createVpnPeer(opts: {
  interface?: string;
  description: string;
  allowedIps: string[];
  persistentKeepalive?: number;
}): Promise<VpnPeerCreateResponse> {
  const body: Record<string, unknown> = {
    allowed_ips: opts.allowedIps,
    description: opts.description,
  };
  if (opts.interface) body.interface = opts.interface;
  if (opts.persistentKeepalive !== undefined) body.persistent_keepalive = opts.persistentKeepalive;
  const res = await postJson("/vpn/peers", body, "VPN create peer");
  return res.json() as Promise<VpnPeerCreateResponse>;
}

/**
 * WARP-1385 — install/refresh a direct-punch overlay peer (ADR-030). Unlike
 * createVpnPeer, the phone brings its OWN key (enrolled via HQ), so this installs
 * the given `publicKey` with the phone's observed `endpoint` + a keepalive.
 * Idempotent on the routing side (re-install refreshes the endpoint in place).
 */
export async function installOverlayVpnPeer(opts: {
  interface?: string;
  publicKey: string;
  endpoint: string;
  allowedIps: string[];
  persistentKeepalive?: number;
  description?: string;
}): Promise<{
  status: "ok";
  interface: string;
  public_key: string;
  endpoint: string;
  allowed_ips: string[];
  persistent_keepalive: number;
}> {
  const body: Record<string, unknown> = {
    public_key: opts.publicKey,
    endpoint: opts.endpoint,
    allowed_ips: opts.allowedIps,
  };
  if (opts.interface) body.interface = opts.interface;
  if (opts.persistentKeepalive !== undefined)
    body.persistent_keepalive = opts.persistentKeepalive;
  if (opts.description !== undefined) body.description = opts.description;
  const res = await postJson("/vpn/peers/overlay", body, "VPN install overlay peer");
  return res.json() as Promise<{
    status: "ok";
    interface: string;
    public_key: string;
    endpoint: string;
    allowed_ips: string[];
    persistent_keepalive: number;
  }>;
}

export async function deleteVpnPeer(opts: {
  interface?: string;
  publicKey: string;
}): Promise<{ status: "ok"; interface: string; removed: number }> {
  const body: Record<string, unknown> = { public_key: opts.publicKey };
  if (opts.interface) body.interface = opts.interface;
  const res = await routingFetch("/vpn/peers", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    label: "VPN delete peer",
  });
  return res.json() as Promise<{ status: "ok"; interface: string; removed: number }>;
}

/** Fetch the state of a previously-started operation (WARP-40).
 *  `rejected` is the routing service's neutral no-change terminal for a 4xx
 *  (auth / validation): the request was refused before any router change. */
export async function fetchOperation(opId: string): Promise<{
  id: string;
  state: "pending" | "applied" | "rejected" | "rolled_back";
  startedAt: number;
  finishedAt: number | null;
  reason: string | null;
}> {
  return routingFetchJson(`/operations/${encodeURIComponent(opId)}`, {
    label: "Operation lookup",
    // Polling every 1s — skip retries so rolled_back reads don't get retry-delayed.
    retry: { attempts: 1 },
  });
}

// ---------------------------------------------------------------------------
// AP onboarding (WARP-446)
// ---------------------------------------------------------------------------
//
// Thin pass-through to the routing service's `/aps/*` endpoints. The
// orchestrator's `ap-onboard.service.ts` owns the state machine (ApDevice
// rows, status transitions, audit columns); this client just shuttles
// JSON bodies + Operation-Id into and out of the routing layer. RouterError
// classification (UNREACHABLE / TIMEOUT / AUTH / etc.) flows through the
// shared retry helper, same as every other call here.

export type DiscoveredApInfo = {
  mac: string;
  model?: string;
  serial?: string;
  version?: string;
  last_ip?: string;
  hostname?: string;
  first_seen?: string;
  last_seen?: string;
};

export type ApStatusResponse = {
  mac: string;
  state: "discovered" | "online" | "decommissioned" | "unknown";
  model?: string;
  serial?: string;
  version?: string;
  last_ip?: string;
  hostname?: string;
  wireless?: {
    iface_section: string;
    radio: string;
    ssid: string;
    encryption: string;
    network: string;
    key_set: boolean;
  };
};

export type ApApproveResponse = {
  status: "ok";
  mac: string;
  iface_section: string;
  ssid: string;
  operation_id?: string;
};

export type ApDecommissionResponse = {
  status: "ok";
  mac: string;
  operation_id?: string;
};

export async function listDiscoveredAps(): Promise<DiscoveredApInfo[]> {
  const data = await routingFetchJson<{ discovered: DiscoveredApInfo[] }>(
    "/aps/discovered",
    { label: "AP discovery list" },
  );
  return data.discovered;
}

export async function getApStatus(opts: { mac: string }): Promise<ApStatusResponse | null> {
  try {
    return await routingFetchJson<ApStatusResponse>(
      `/aps/${encodeURIComponent(opts.mac)}`,
      { label: "AP status" },
    );
  } catch (err) {
    // 404 = unknown / never-discovered MAC. Caller decides what to do.
    if (err instanceof RouterError && err.status === 404) return null;
    throw err;
  }
}

export async function approveAp(opts: {
  mac: string;
  ssid: string;
  encryptionKey: string;
  radio?: string;
  encryption?: string;
  network?: string;
}): Promise<ApApproveResponse> {
  const body: Record<string, unknown> = {
    ssid: opts.ssid,
    encryption_key: opts.encryptionKey,
  };
  if (opts.radio) body.radio = opts.radio;
  if (opts.encryption) body.encryption = opts.encryption;
  if (opts.network) body.network = opts.network;
  const res = await postJson(
    `/aps/${encodeURIComponent(opts.mac)}/approve`,
    body,
    "AP approve",
  );
  return res.json() as Promise<ApApproveResponse>;
}

export async function decommissionAp(opts: { mac: string }): Promise<ApDecommissionResponse> {
  const res = await routingFetch(`/aps/${encodeURIComponent(opts.mac)}`, {
    method: "DELETE",
    label: "AP decommission",
  });
  return res.json() as Promise<ApDecommissionResponse>;
}

/**
 * WARP-1703: the AP image's band-steering master switch
 * (`droplet.wifi.band_steering`). `supported: false` is the honest
 * "can't do it on this shape" answer — no AP credential provisioned, or the
 * AP's image predates the droplet.wifi substrate — never an error.
 */
export type ApBandSteering = {
  supported: boolean;
  enabled: boolean;
  ap_detail?: string;
};

export async function getApBandSteering(opts: { mac: string }): Promise<ApBandSteering> {
  return routingFetchJson<ApBandSteering>(
    `/aps/${encodeURIComponent(opts.mac)}/band-steering`,
    { label: "AP band steering" },
  );
}

export async function setApBandSteering(opts: {
  mac: string;
  enabled: boolean;
}): Promise<WriteResult> {
  const res = await routingFetch(`/aps/${encodeURIComponent(opts.mac)}/band-steering`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: opts.enabled }),
    label: "AP band steering write",
  });
  return opFrom(res);
}

/**
 * WARP-1712: the AP's OWN wireless state, read live off its uci every time.
 *
 * There is deliberately no orchestrator-side cache of the network name — the
 * AP is authoritative for its own radios, so a stale copy here is exactly the
 * "two places disagreeing" failure this ticket exists to remove.
 *
 * `supported: false` is the honest "can't do it on this shape" answer (no AP
 * credential provisioned, or the AP reports no wireless interfaces) — never
 * an error.
 */
export type ApWirelessRadio = {
  section: string;
  radio: string | null;
  /** '2g' / '5g' / '6g' as uci reports it. */
  band: string | null;
  ssid: string | null;
  encryption: string | null;
  /** Configured channel — 'auto' is a legal uci value. */
  channel: string | null;
  htmode: string | null;
  disabled: boolean;
  /** True for the interface that owns the household name (the write target). */
  primary: boolean;
  ifname: string | null;
  up: boolean | null;
  /** Live channel/width off iwinfo; may differ from the configured value. */
  live_channel: number | null;
  live_htmode: string | null;
  clients: number | null;
};

export type ApWirelessDevice = {
  model: string | null;
  firmware: string | null;
  hostname: string | null;
  uptime_seconds: number | null;
};

export type ApWireless = {
  supported: boolean;
  ap_detail?: string;
  /** Null when the AP image predates the band-steering substrate. */
  band_steering?: boolean | null;
  primary_section?: string | null;
  ssid?: string | null;
  /** The live per-unit passphrase — owner/admin surfaces only. */
  key?: string | null;
  encryption?: string | null;
  /** What the AP's applier will name the 5 GHz network. Display only. */
  five_ghz_ssid?: string | null;
  radios: ApWirelessRadio[];
  device?: ApWirelessDevice;
};

export type ApWirelessWriteResponse = WriteResult & {
  ssid?: string | null;
  five_ghz_ssid?: string | null;
  sections_written?: string[];
};

export async function getApWireless(opts: { mac: string }): Promise<ApWireless> {
  return routingFetchJson<ApWireless>(
    `/aps/${encodeURIComponent(opts.mac)}/wireless`,
    { label: "AP wireless" },
  );
}

export async function setApWireless(opts: {
  mac: string;
  ssid?: string;
  key?: string;
}): Promise<ApWirelessWriteResponse> {
  const body: Record<string, unknown> = {};
  if (opts.ssid !== undefined) body.ssid = opts.ssid;
  if (opts.key !== undefined) body.key = opts.key;
  const res = await routingFetch(`/aps/${encodeURIComponent(opts.mac)}/wireless`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    label: "AP wireless write",
  });
  // opFrom only reads a header, so the body is still ours to consume. The
  // routing service reports the name it wrote, letting the dashboard confirm
  // what the network will be called without racing the AP's reload with an
  // immediate re-read. It also MIRRORS the Operation-Id into the body — some
  // proxies strip non-standard response headers — so fall back to that.
  const op = opFrom(res);
  const payload = (await res.json().catch(() => ({}))) as {
    ssid?: string | null;
    five_ghz_ssid?: string | null;
    sections_written?: string[];
    operation_id?: string | null;
  };
  return {
    operationId: op.operationId ?? payload.operation_id ?? null,
    ssid: payload.ssid,
    five_ghz_ssid: payload.five_ghz_ssid,
    sections_written: payload.sections_written,
  };
}

/** Test-only seam — only available when routing is in ROUTING_MODE=mock. */
export async function seedDiscoveredAp(opts: {
  mac: string;
  model?: string;
  serial?: string;
  version?: string;
  last_ip?: string;
  hostname?: string;
}): Promise<{ status: "ok"; mac: string }> {
  const body: Record<string, unknown> = { mac: opts.mac };
  for (const k of ["model", "serial", "version", "last_ip", "hostname"] as const) {
    if (opts[k] !== undefined) body[k] = opts[k];
  }
  const res = await postJson("/aps/_test_seed", body, "AP test seed");
  return res.json() as Promise<{ status: "ok"; mac: string }>;
}

// --- Health ---

export async function healthCheck(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    // /health is exempt from auth on the routing side (Docker healthcheck); send the
    // token anyway to keep the code path uniform. Retries are disabled — health
    // should be a cheap single probe, and the 3s AbortController cap is the SLO.
    //
    // skipContactMark=true: the routing service returns HTTP 200 even while
    // OpenWrt is still provisioning (body: { connected: false }). We must not
    // flip routerContacted until we've confirmed the payload says connected.
    const res = await routingFetch("/health", {
      signal: controller.signal,
      label: "Health",
      retry: { attempts: 1 },
      skipContactMark: true,
    });
    clearTimeout(timeout);
    const data = await res.json();
    const connected = data.connected === true;
    if (connected) {
      routerContacted = true;
    }
    return connected;
  } catch {
    return false;
  }
}
