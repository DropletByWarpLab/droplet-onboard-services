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
  const { headers = {}, label, retry = {}, ...rest } = init;
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...retry };
  const sleep = policy.sleep ?? defaultSleep;
  const random = policy.random ?? Math.random;

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
    logger.warn(
      {
        path,
        attempt,
        maxAttempts: policy.attempts,
        code: outcome.err.code,
        status: outcome.err.status,
        err: outcome.err.message,
        waitMs,
      },
      "routing call failed, retrying",
    );
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

// --- Health ---

export async function healthCheck(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    // /health is exempt from auth on the routing side (Docker healthcheck); send the
    // token anyway to keep the code path uniform. Retries are disabled — health
    // should be a cheap single probe, and the 3s AbortController cap is the SLO.
    const res = await routingFetch("/health", {
      signal: controller.signal,
      label: "Health",
      retry: { attempts: 1 },
    });
    clearTimeout(timeout);
    const data = await res.json();
    return data.connected === true;
  } catch {
    return false;
  }
}
