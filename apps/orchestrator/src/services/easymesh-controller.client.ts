/**
 * prplMesh EasyMesh controller client (ADR-024 Phase 4, §2).
 *
 * The box runs prplMesh in **CONTROLLER-ONLY** mode. Per the ADR-024 §2
 * spike, prplMesh's wireless HAL targets Intel/Qualcomm, NOT the box's mt76
 * (MT7922) radio — so the box NEVER runs as an EasyMesh RF *agent*. The
 * certified third-party AP is the Agent (it brings its own vendor RF stack);
 * the box owns only the 1905.1 control plane + the M1/M2 credential push. Its
 * own fronthaul BSS uses hostapd Multi-AP (nl80211), which mt76 DOES support.
 *
 * This client is the orchestrator's typed seam to that local controller, over
 * its ubus / IPC data model. Methods the EASYMESH backend needs:
 *   - listOnboardingAgents()  : 1905.1 topology — Agents currently visible /
 *                               onboarding (surfaced as discovery observations).
 *   - onboardAgent(alMac, …)  : push the household SSID/PSK (Multi-AP M1/M2).
 *   - getAgentStatus(alMac)   : the Agent's controller-confirmed state.
 *   - removeAgent(alMac)      : remove the Agent from the controller.
 *
 * Design (testability without a real controller — there is none on the dev
 * laptop, and prplMesh-on-mt76 is the ADR's open hardware risk): ALL transport
 * / wire detail lives behind the `EasyMeshControllerClient` interface. The
 * discovery source (ap-discovery-multiplexer.ts) and the EASYMESH onboarding
 * handler (ap-onboard.service.ts) take that interface and are unit-tested
 * against a MOCK — the same pattern Phase 3 used for UniFi. The concrete impl
 * below carries the ubus calls / data-model paths AS BEST UNDERSTOOD from the
 * prplMesh data model; each one is flagged
 * `// VALIDATE against real prplMesh controller` because the exact shapes are
 * confirmed on real hardware in the lab, later — they must NOT block this build.
 *
 * Config: `DROPLET_AP_EASYMESH_CONTROLLER_URL` (the local controller's
 * ubus-over-HTTP endpoint / socket address). `DROPLET_AP_EASYMESH_ENABLED`
 * (config.ts) gates the whole path; default off, so a single-box never touches
 * this. The controller is a LOOPBACK/LAN local service — the URL is an address,
 * not a secret (mirrors DROPLET_AP_UNIFI_CONTROLLER_URL).
 */

import pino from "pino";
import { config } from "../config.js";

const logger = pino({ name: "easymesh-controller-client" });

/**
 * An Agent the controller's 1905.1 topology reports as visible / onboarding
 * (a certified third-party EasyMesh AP that has appeared on the fronthaul).
 * Surfaced by discovery as a `backend=EASYMESH` observation.
 */
export interface EasyMeshAgent {
  /** 1905.1 AL-MAC (the Agent's logical address); the row's backendRef. */
  alMac: string;
  /** Human vendor label from the Agent's 1905.1 device info, when present. */
  vendor?: string;
  /** Human model label, when the device info exposes one. */
  model?: string;
}

/** An Agent's current state as the controller's topology sees it. */
export interface EasyMeshAgentStatus {
  alMac: string;
  /** Controller lifecycle state, e.g. "onboarding" | "onboarded" | "offline". */
  state: string;
}

export interface EasyMeshOnboardCredentials {
  /** Household SSID pushed to the Agent's fronthaul/backhaul BSS. */
  ssid: string;
  /** WPA key — a SECRET, never logged. */
  key: string;
}

/**
 * Typed client interface — the SEAM the rest of Phase 4 depends on. Both the
 * discovery source and the onboarding handler take this, so they unit-test
 * against a mock with zero transport.
 */
export interface EasyMeshControllerClient {
  /** Agents the 1905.1 topology shows as visible / currently onboarding. */
  listOnboardingAgents(): Promise<EasyMeshAgent[]>;
  /** Run M1/M2 onboarding: push the household SSID/PSK to an Agent by AL-MAC. */
  onboardAgent(alMac: string, creds: EasyMeshOnboardCredentials): Promise<void>;
  /** Current controller state for an AL-MAC, or null if the controller doesn't know it. */
  getAgentStatus(alMac: string): Promise<EasyMeshAgentStatus | null>;
  /** Remove an Agent from the controller. */
  removeAgent(alMac: string): Promise<void>;
}

/**
 * Typed error for the prplMesh controller surface — mirrors the UniFiClientError
 * (and RouterError) discipline (extends Error, carries a `code` + optional
 * `status`, has a `toJSON()`, built via static factories) so the onboarding
 * handler can classify failures and write a clean `failureReason` instead of
 * leaking a raw stack.
 */
export type EasyMeshControllerErrorCode =
  | "UNREACHABLE"
  | "AUTH"
  | "NOT_CONFIGURED"
  | "REJECTED"
  | "UNKNOWN";

export class EasyMeshControllerError extends Error {
  readonly code: EasyMeshControllerErrorCode;
  readonly status?: number;
  readonly label?: string;

  constructor(
    code: EasyMeshControllerErrorCode,
    message: string,
    options?: { status?: number; label?: string; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "EasyMeshControllerError";
    this.code = code;
    this.status = options?.status;
    this.label = options?.label;
  }

  static notConfigured(label = "easymesh"): EasyMeshControllerError {
    return new EasyMeshControllerError(
      "NOT_CONFIGURED",
      "EasyMesh controller URL is not configured",
      { label, status: 503 },
    );
  }
  static unreachable(
    message: string,
    opts?: { label?: string; cause?: unknown },
  ): EasyMeshControllerError {
    return new EasyMeshControllerError("UNREACHABLE", message, { ...opts, status: 503 });
  }
  static auth(message: string, opts?: { label?: string; status?: number }): EasyMeshControllerError {
    return new EasyMeshControllerError("AUTH", message, opts);
  }
  static rejected(message: string, opts?: { label?: string; status?: number }): EasyMeshControllerError {
    return new EasyMeshControllerError("REJECTED", message, opts);
  }
  static unknown(
    message: string,
    opts?: { label?: string; status?: number; cause?: unknown },
  ): EasyMeshControllerError {
    return new EasyMeshControllerError("UNKNOWN", message, opts);
  }

  toJSON(): { code: EasyMeshControllerErrorCode; message: string; status?: number; label?: string } {
    return { code: this.code, message: this.message, status: this.status, label: this.label };
  }
}

/** Normalize a controller-reported MAC to the codebase canonical form. */
function canonicalMac(raw: string): string {
  return raw.replace(/[:\-.]/g, "").toUpperCase().match(/.{2}/g)?.join(":") ?? raw.toUpperCase();
}

/**
 * Concrete impl over the local prplMesh controller's ubus / IPC data model,
 * reached over its ubus-over-HTTP endpoint (`DROPLET_AP_EASYMESH_CONTROLLER_URL`).
 *
 * Every endpoint path + request body below is the prplMesh data-model shape AS
 * BEST UNDERSTOOD and MUST be confirmed against a live controller on the lab box
 * — each carries a `// VALIDATE against real prplMesh controller` marker. They
 * are deliberately NOT asserted byte-for-byte in the unit tests (no controller
 * on the dev laptop, and prplMesh-on-mt76 is the ADR's open hardware risk); the
 * tests pin transport + error classification, which is the contract the
 * discovery source + handler actually rely on.
 */
class HttpEasyMeshControllerClient implements EasyMeshControllerClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; label: string },
  ): Promise<T> {
    if (!this.baseUrl) {
      throw EasyMeshControllerError.notConfigured(init.label);
    }
    // Trim a trailing slash on the base so `${base}${path}` never doubles up.
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      throw EasyMeshControllerError.unreachable(`${init.label}: ${error.message}`, {
        label: init.label,
        cause: error,
      });
    }
    if (!res.ok) {
      const base = `${init.label}: ${res.status} ${res.statusText || ""}`.trim();
      if (res.status === 401 || res.status === 403) {
        throw EasyMeshControllerError.auth(base, { label: init.label, status: res.status });
      }
      if (res.status >= 400 && res.status < 500) {
        throw EasyMeshControllerError.rejected(base, { label: init.label, status: res.status });
      }
      throw EasyMeshControllerError.unreachable(base, { label: init.label });
    }
    // 204 / empty body tolerated for write calls.
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async listOnboardingAgents(): Promise<EasyMeshAgent[]> {
    // VALIDATE against real prplMesh controller — 1905.1 topology ubus object +
    // method (e.g. `ubus call Device.WiFi.DataElementsNetwork ...` / the
    // controller's topology dump) and the AL-MAC / device-info field names.
    const raw = await this.request<
      Array<{ al_mac: string; manufacturer?: string; model?: string }>
    >("/topology/agents", { label: "EasyMesh topology" });
    const list = Array.isArray(raw) ? raw : [];
    return list.map((a) => ({
      alMac: canonicalMac(a.al_mac),
      // Vendor comes from the Agent's 1905.1 device info WHEN PRESENT — never
      // guessed when the topology omits it (CLAUDE.md no-guessing rule).
      vendor: a.manufacturer,
      model: a.model,
    }));
  }

  async onboardAgent(alMac: string, creds: EasyMeshOnboardCredentials): Promise<void> {
    // VALIDATE against real prplMesh controller — Multi-AP M1/M2 onboarding
    // ubus method + credential body keys (the controller pushes these as the
    // EasyMesh credential set to the Agent's fronthaul/backhaul BSS).
    await this.request<unknown>("/agents/onboard", {
      method: "POST",
      body: {
        al_mac: canonicalMac(alMac),
        ssid: creds.ssid,
        // The key is a secret on the wire; never logged by this client.
        key: creds.key,
      },
      label: "EasyMesh onboard",
    });
  }

  async getAgentStatus(alMac: string): Promise<EasyMeshAgentStatus | null> {
    const target = canonicalMac(alMac);
    // VALIDATE against real prplMesh controller — agent-status / topology query
    // ubus method + the state field name.
    const raw = await this.request<
      Array<{ al_mac: string; state?: string }>
    >("/topology/agents", { label: "EasyMesh agent status" });
    const list = Array.isArray(raw) ? raw : [];
    const found = list.find((a) => canonicalMac(a.al_mac) === target);
    if (!found) return null;
    return { alMac: target, state: found.state ?? "unknown" };
  }

  async removeAgent(alMac: string): Promise<void> {
    // VALIDATE against real prplMesh controller — agent-remove / de-onboard
    // ubus method + request body key.
    await this.request<unknown>("/agents/remove", {
      method: "POST",
      body: { al_mac: canonicalMac(alMac) },
      label: "EasyMesh remove",
    });
  }
}

/**
 * Build the concrete controller client from config. The controller URL comes
 * from `DROPLET_AP_EASYMESH_CONTROLLER_URL` (the local prplMesh controller's
 * ubus endpoint / socket address). A client built with empty config still
 * constructs, but every call throws `EasyMeshControllerError.notConfigured` —
 * the discovery source only invokes it when `DROPLET_AP_EASYMESH_ENABLED` is
 * on, so a default single-box never touches it.
 */
export function createEasyMeshControllerClient(): EasyMeshControllerClient {
  const url = config.DROPLET_AP_EASYMESH_CONTROLLER_URL ?? "";
  if (!url) {
    logger.debug(
      "easymesh controller client created without a controller URL — calls will throw NOT_CONFIGURED until it is set",
    );
  }
  return new HttpEasyMeshControllerClient(url);
}
