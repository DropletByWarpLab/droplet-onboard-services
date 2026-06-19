/**
 * Official local UniFi Network API client (ADR-024 Phase 3, §3).
 *
 * Droplet is a PURE API CLIENT to a UniFi Network controller the household
 * already runs (ADR-024 §"Open decision" — Option B, customer-supplied
 * controller). We do NOT bundle or redistribute the controller, its Java
 * stack, or MongoDB; the box only points at an existing UDM / CloudKey /
 * self-host via `DROPLET_AP_UNIFI_CONTROLLER_URL` + an API key.
 *
 * Design (testability without a real controller — there is none on the dev
 * laptop): ALL HTTP / wire detail lives behind the `UniFiNetworkClient`
 * interface. The discovery source (ap-discovery-multiplexer.ts) and the
 * UNIFI onboarding handler (ap-onboard.service.ts) take that interface and
 * are unit-tested against a MOCK — the same pattern the routing service
 * uses with its mock router. The concrete HTTP impl below carries the wire
 * shapes; each endpoint path + body is flagged
 * `// VALIDATE against real controller` because the exact official-API REST
 * shapes are confirmed against a live controller in the lab, later — they
 * must NOT block this build.
 *
 * Auth: the official local API (released 2024) authenticates with an API key
 * sent in a request header — NOT the legacy `:8443` login-cookie flow, which
 * breaks across controller versions (ADR-024 §3). The key is a SECRET: it is
 * read from config (`DROPLET_AP_UNIFI_API_KEY`, sourced from the secret store
 * / .env), never a tracked default.
 */

import pino from "pino";
import { config } from "../config.js";

const logger = pino({ name: "unifi-network-client" });

/**
 * A device the controller reports as pending adoption (a factory-default
 * UniFi AP that has a lease and announced itself). Surfaced by discovery.
 */
export interface UniFiPendingDevice {
  /** Canonical-ish MAC as the controller reports it; normalized at the boundary. */
  mac: string;
  /** Controller-scoped opaque id, stored as ApDevice.backendRef. */
  deviceId?: string;
  /** Human model label, e.g. "U6-Lite". */
  model?: string;
  /** Lease IP, when the controller exposes it. */
  ip?: string;
}

/** Result of an adopt call — the controller's device_id is what we persist. */
export interface UniFiAdoptResult {
  deviceId: string;
}

/** A device's current state as the controller sees it. */
export interface UniFiDeviceStatus {
  mac: string;
  /** Controller lifecycle state, e.g. "connected" | "adopting" | "pending". */
  state: string;
  deviceId?: string;
}

export interface UniFiWlanConfig {
  mac: string;
  ssid: string;
  /** WPA key — a SECRET, never logged. */
  key: string;
  /** Optional band/radio hint; the controller picks sensibly when omitted. */
  band?: string;
}

/**
 * Typed client interface — the SEAM the rest of Phase 3 depends on. Both the
 * discovery source and the onboarding handler take this, so they unit-test
 * against a mock with zero HTTP.
 */
export interface UniFiNetworkClient {
  /** Devices the controller is showing as *Pending Adoption*. */
  listPendingDevices(): Promise<UniFiPendingDevice[]>;
  /** Adopt a pending device by MAC; resolves the controller's device_id. */
  adoptDevice(mac: string): Promise<UniFiAdoptResult>;
  /** Push the household WLAN (SSID + key) to an adopted device. */
  pushWlanConfig(cfg: UniFiWlanConfig): Promise<void>;
  /** Current controller state for a MAC, or null if the controller doesn't know it. */
  getDeviceStatus(mac: string): Promise<UniFiDeviceStatus | null>;
  /** Forget / remove a device from the controller (de-adopt). */
  forgetDevice(mac: string): Promise<void>;
}

/**
 * Typed error for the UniFi controller surface — mirrors the RouterError
 * discipline (extends Error, carries a `code` + optional `status`, has a
 * `toJSON()`, built via static factories) so the onboarding handler can
 * classify failures and write a clean `failureReason` instead of leaking a
 * raw stack.
 */
export type UniFiClientErrorCode =
  | "UNREACHABLE"
  | "AUTH"
  | "NOT_CONFIGURED"
  | "REJECTED"
  | "UNKNOWN";

export class UniFiClientError extends Error {
  readonly code: UniFiClientErrorCode;
  readonly status?: number;
  readonly label?: string;

  constructor(
    code: UniFiClientErrorCode,
    message: string,
    options?: { status?: number; label?: string; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "UniFiClientError";
    this.code = code;
    this.status = options?.status;
    this.label = options?.label;
  }

  static notConfigured(label = "unifi"): UniFiClientError {
    return new UniFiClientError(
      "NOT_CONFIGURED",
      "UniFi controller URL / API key is not configured",
      { label, status: 503 },
    );
  }
  static unreachable(message: string, opts?: { label?: string; cause?: unknown }): UniFiClientError {
    return new UniFiClientError("UNREACHABLE", message, { ...opts, status: 503 });
  }
  static auth(message: string, opts?: { label?: string; status?: number }): UniFiClientError {
    return new UniFiClientError("AUTH", message, opts);
  }
  static rejected(message: string, opts?: { label?: string; status?: number }): UniFiClientError {
    return new UniFiClientError("REJECTED", message, opts);
  }
  static unknown(message: string, opts?: { label?: string; status?: number; cause?: unknown }): UniFiClientError {
    return new UniFiClientError("UNKNOWN", message, opts);
  }

  toJSON(): { code: UniFiClientErrorCode; message: string; status?: number; label?: string } {
    return { code: this.code, message: this.message, status: this.status, label: this.label };
  }
}

/** Normalize a controller-reported MAC to the codebase canonical form. */
function canonicalMac(raw: string): string {
  return raw.replace(/[:\-.]/g, "").toUpperCase().match(/.{2}/g)?.join(":") ?? raw.toUpperCase();
}

/**
 * Concrete HTTP impl over the official local UniFi Network API.
 *
 * Every endpoint path + request body below is the official-API shape AS BEST
 * UNDERSTOOD from the 2024 docs and MUST be confirmed against a live
 * controller in the lab — each carries a `// VALIDATE against real controller`
 * marker. They are deliberately NOT asserted byte-for-byte in the unit tests
 * (no controller on the dev laptop); the tests pin auth + error classification,
 * which is the contract the discovery source + handler actually rely on.
 */
class HttpUniFiNetworkClient implements UniFiNetworkClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; label: string },
  ): Promise<T> {
    if (!this.baseUrl || !this.apiKey) {
      throw UniFiClientError.notConfigured(init.label);
    }
    // Trim a trailing slash on the base so `${base}${path}` never doubles up.
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          // Official local API: API-key header auth (ADR-024 §3). The exact
          // header name is confirmed against the live controller.
          // VALIDATE against real controller — header name (X-API-Key vs Authorization)
          "X-API-Key": this.apiKey,
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      throw UniFiClientError.unreachable(`${init.label}: ${error.message}`, {
        label: init.label,
        cause: error,
      });
    }
    if (!res.ok) {
      const base = `${init.label}: ${res.status} ${res.statusText || ""}`.trim();
      if (res.status === 401 || res.status === 403) {
        throw UniFiClientError.auth(base, { label: init.label, status: res.status });
      }
      if (res.status >= 400 && res.status < 500) {
        throw UniFiClientError.rejected(base, { label: init.label, status: res.status });
      }
      throw UniFiClientError.unreachable(base, { label: init.label });
    }
    // 204 / empty body tolerated for write calls.
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async listPendingDevices(): Promise<UniFiPendingDevice[]> {
    // VALIDATE against real controller — pending-adoption list endpoint + payload shape
    const raw = await this.request<
      Array<{ mac: string; device_id?: string; model?: string; ip?: string }>
    >("/proxy/network/integration/v1/devices/pending", { label: "UniFi pending devices" });
    const list = Array.isArray(raw) ? raw : [];
    return list.map((d) => ({
      mac: canonicalMac(d.mac),
      deviceId: d.device_id,
      model: d.model,
      ip: d.ip,
    }));
  }

  async adoptDevice(mac: string): Promise<UniFiAdoptResult> {
    // VALIDATE against real controller — adopt-by-MAC endpoint + request body key
    const raw = await this.request<{ device_id?: string }>(
      "/proxy/network/integration/v1/devices/adopt",
      { method: "POST", body: { mac: canonicalMac(mac) }, label: "UniFi adopt" },
    );
    const deviceId = raw?.device_id;
    if (!deviceId) {
      throw UniFiClientError.unknown("UniFi adopt did not return a device_id", {
        label: "UniFi adopt",
      });
    }
    return { deviceId };
  }

  async pushWlanConfig(cfg: UniFiWlanConfig): Promise<void> {
    // VALIDATE against real controller — WLAN-config push endpoint + body keys
    await this.request<unknown>("/proxy/network/integration/v1/devices/wlan", {
      method: "POST",
      body: {
        mac: canonicalMac(cfg.mac),
        ssid: cfg.ssid,
        // The key is a secret on the wire; never logged by this client.
        passphrase: cfg.key,
        ...(cfg.band ? { band: cfg.band } : {}),
      },
      label: "UniFi WLAN push",
    });
  }

  async getDeviceStatus(mac: string): Promise<UniFiDeviceStatus | null> {
    const target = canonicalMac(mac);
    // VALIDATE against real controller — device-list endpoint + state field name
    const raw = await this.request<
      Array<{ mac: string; state?: string; device_id?: string }>
    >("/proxy/network/integration/v1/devices", { label: "UniFi device status" });
    const list = Array.isArray(raw) ? raw : [];
    const found = list.find((d) => canonicalMac(d.mac) === target);
    if (!found) return null;
    return { mac: target, state: found.state ?? "unknown", deviceId: found.device_id };
  }

  async forgetDevice(mac: string): Promise<void> {
    // VALIDATE against real controller — forget/remove endpoint + request body key
    await this.request<unknown>("/proxy/network/integration/v1/devices/forget", {
      method: "POST",
      body: { mac: canonicalMac(mac) },
      label: "UniFi forget",
    });
  }
}

/**
 * Build the concrete HTTP client from config. The controller URL + API key
 * come from `DROPLET_AP_UNIFI_CONTROLLER_URL` / `DROPLET_AP_UNIFI_API_KEY`
 * (Option B — customer-supplied controller; the key is a secret, default
 * empty). A client built with empty config still constructs, but every call
 * throws `UniFiClientError.notConfigured` — the discovery source only invokes
 * it when `DROPLET_AP_UNIFI_ENABLED` is on, so a default single-box never
 * touches it.
 */
export function createUniFiNetworkClient(): UniFiNetworkClient {
  const url = config.DROPLET_AP_UNIFI_CONTROLLER_URL ?? "";
  const apiKey = config.DROPLET_AP_UNIFI_API_KEY ?? "";
  if (!url || !apiKey) {
    logger.debug(
      "unifi client created without controller URL / API key — calls will throw NOT_CONFIGURED until both are set",
    );
  }
  return new HttpUniFiNetworkClient(url, apiKey);
}
