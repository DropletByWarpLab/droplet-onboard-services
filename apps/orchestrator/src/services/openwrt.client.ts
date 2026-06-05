/**
 * OpenWrt routing service client — HTTP wrapper.
 *
 * Talks to the routing microservice (FastAPI) which proxies
 * requests to the OpenWrt ubus JSON-RPC API.
 */

import pino from "pino";
import { config } from "../config.js";
import {
  RouterError,
  routerErrorFromResponse,
  routerErrorFromThrown,
} from "../types/router-error.js";
import type {
  NetworkSummary,
  NetworkInterfaces,
  InterfaceStatus,
  WirelessStatus,
  WirelessScanResult,
  WirelessClient,
  DhcpLease,
  RouterSystemInfo,
  FirewallZones,
  FirewallRules,
  FirewallRedirects,
} from "../types/network.js";
import {
  FirewallZonesSchema,
  FirewallRulesSchema,
  FirewallRedirectsSchema,
} from "../types/firewall-schema.js";

export { RouterError } from "../types/router-error.js";
export type { RouterErrorCode } from "../types/router-error.js";

const logger = pino({ name: "openwrt-client" });

const BASE_URL = config.ROUTING_SERVICE_URL;
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
    const res = await fetch(url, init);
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

// --- Wireless ---

export async function fetchWirelessStatus(): Promise<WirelessStatus> {
  return routingFetchJson<WirelessStatus>("/wireless/status", { label: "Wireless status" });
}

// WARP-815 (K4): `device` is OPTIONAL and has no default. When the caller
// omits it we send no `device` query param so the routing service resolves the
// radio from DROPLET_WIFI_SCAN_DEVICE (see services/routing/droplet_openwrt_sdk.py
// `_default_scan_device`). A hardcoded `wlan0` default here always overrode that
// env on the wire — and the single-box radio is `wlp14s0`, not `wlan0` — so the
// scan hit a radio the box doesn't have. Rule 12: no host-specific defaults.
// Explicit-device callers still get verbatim forwarding.
export async function scanWireless(device?: string): Promise<WirelessScanResult[]> {
  const query = device ? `?device=${encodeURIComponent(device)}` : "";
  const data = await routingFetchJson<{ results: WirelessScanResult[] }>(
    `/wireless/scan${query}`,
    { label: "Wireless scan" },
  );
  return data.results;
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

// --- System ---

export async function fetchSystemInfo(): Promise<RouterSystemInfo> {
  return routingFetchJson<RouterSystemInfo>("/system/info", { label: "System info" });
}

export async function rebootRouter(): Promise<WriteResult> {
  const res = await routingFetch("/system/reboot", { method: "POST", label: "Reboot" });
  return opFrom(res);
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

// --- DDNS (DuckDNS) ---
//
// The token is write-only on this client too: the GET return value carries
// `tokenSet: boolean` rather than the token itself, matching the routing
// service contract. Dashboard renders a placeholder password input that
// shows "stored" instead of dots when tokenSet is true.

export type DuckDnsStatus =
  | { configured: false }
  | {
      configured: true;
      subdomain: string;
      fullDomain: string;
      enabled: boolean;
      tokenSet: boolean;
      lastUpdate?: string;
    };

export async function fetchDuckDnsStatus(): Promise<DuckDnsStatus> {
  return routingFetchJson<DuckDnsStatus>("/ddns/duckdns", { label: "DuckDNS status" });
}

export async function setDuckDnsConfig(opts: {
  subdomain: string;
  // Optional: when undefined the routing service preserves the existing
  // /etc/config/ddns password value. Used by the wizard's "keep stored
  // token" path so returning customers don't have to re-type the token.
  token?: string;
  enabled?: boolean;
}): Promise<DuckDnsStatus & { status: "ok" }> {
  const body: { subdomain: string; token?: string; enabled: boolean } = {
    subdomain: opts.subdomain,
    enabled: opts.enabled ?? true,
  };
  if (opts.token !== undefined) body.token = opts.token;
  const res = await routingFetch("/ddns/duckdns", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    label: "DuckDNS set",
  });
  return res.json() as Promise<DuckDnsStatus & { status: "ok" }>;
}

/** Fetch the state of a previously-started operation (WARP-40). */
export async function fetchOperation(opId: string): Promise<{
  id: string;
  state: "pending" | "applied" | "rolled_back";
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
