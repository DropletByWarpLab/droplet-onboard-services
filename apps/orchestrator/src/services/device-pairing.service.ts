/**
 * Device pairing orchestration (ADR-071 slices B + C, WARP-3739).
 *
 * A Droplet-image device (the edge router, the managed switch, an external AP)
 * opens a pairing window; the owning service (routing for the router and APs,
 * the switch service for the switch) mints + claims the `droplet-ai` credential
 * (`POST .../pairing/claim`), and this module is the middle hop that:
 * (1) tells that service which box fingerprint is "us", (2) dispatches the
 * freshly-claimed password to the device-bridge so it lands in
 * docker/secrets/<role>_password, (3) tells the service it was persisted, and
 * (4) writes ONE `CommandAuditLog` row per attempt.
 *
 * One implementation, three roles: `DevicePairingProfile` carries everything
 * that differs (service paths, bridge `target`, audit service name, copy). The
 * router profile reproduces the slice B behaviour exactly.
 *
 * THE PASSWORD'S ONLY ROUTE: owning-service response body -> a local const ->
 * the bridge request body. It is never logged, never put in an audit row, never
 * returned to the caller, and never held after the function returns.
 *
 * DEGRADATION: every call tolerates an owning-service build that predates the
 * pairing endpoints (404 / no `pairing` in the status body): the card simply
 * never shows and the existing "Credentials rejected" state stands.
 */

import { createHash, X509Certificate } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import { bridgeAdminToken, isBridgeConnectionError, isTimeoutOrAbort } from "../lib/bridge-errors.js";
import { RouterError } from "../types/router-error.js";
import type { RouterErrorCode } from "../types/router-error.js";

const logger = createLogger("device-pairing");

const AUDIT_DOMAIN = "network";
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Bounded: the owning service logs in with the new password before it answers. */
const CLAIM_TIMEOUT_MS = 30_000;
const ROUTING_TIMEOUT_MS = 10_000;
/** The bridge waits up to 130 s for the root unit (one compose recreate). */
const BRIDGE_TIMEOUT_MS = 140_000;

export type PairingState = "open" | "closed" | "paired" | "unknown";

/** Which device a pairing is for. Doubles as the device-bridge `target`. */
export type PairingRole = "router" | "switch" | "ap";

/** What the dashboard card reads. `available:false` = the service has no pairing surface. */
export interface PairingView {
  available: boolean;
  state: PairingState | null;
  windowEndsAt: string | null;
  pairedBox: string | null;
  pairedElsewhere: boolean;
  pendingPersist: boolean;
  /**
   * Typed device error right now (AUTH, PAIRED_ELSEWHERE, UNREACHABLE...), or null
   * when healthy. Named for the router because the slice B card reads it; the
   * switch and AP views carry the same field with their own device's state.
   */
  routerErrorCode: RouterErrorCode | null;
  host: string | null;
  model: string | null;
}

export interface PairResult {
  ok: boolean;
  /** Only meaningful when `ok`. false = the service holds the password in memory only. */
  persisted: boolean;
  host?: string;
  model?: string;
  paired_at?: string;
  error?: string;
  /** Machine code on failure (PAIR_WINDOW_CLOSED, ROUTER_PAIRED_ELSEWHERE, ...). */
  code?: string;
  /** HTTP status the route should answer with. */
  httpStatus: number;
}

/** The slice of the device-identity client this needs. */
export interface IdentityPort {
  getDeviceCert(): Promise<string>;
}

export type PairingServiceFetch = (
  path: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    label?: string;
    signal?: AbortSignal;
    retry?: { attempts: number };
    skipContactMark?: boolean;
    passthroughStatuses?: number[];
  },
) => Promise<Response>;

/** Everything that differs between the router, the switch and an AP. */
export interface DevicePairingProfile {
  role: PairingRole;
  /** CommandAuditLog.service. */
  auditService: string;
  /** CommandAuditLog.entityId. */
  auditEntity: string;
  /** User-facing noun used in the error copy ("router", "switch", "access point"). */
  noun: string;
  /** User-facing name of the owning service, for the "not supported" copy. */
  serviceNoun: string;
  /** Sentence fragment: how the owner re-opens a closed window ("Press the router's button"). */
  reopenHint: string;
  /** JSON key naming the device host in the status body. */
  hostKey: string;
  /** GET path of a health-shaped status body (`{connected, error_code, pairing:{...}}`). */
  statusPath: (deviceId?: string) => string;
  /** PUT path publishing the box fingerprint; undefined = nothing to publish. */
  identityPath?: string;
  claimPath: (deviceId?: string) => string;
  pendingPath: string;
  persistedPath: string;
  /** Wire code the owning service uses for "enrolled to another box". */
  pairedElsewhereCode: string;
  /** Wire code for "device does not answer" on a claim, when it has its own copy. */
  unreachableCode?: string;
  /** Whether `reconcile()` has anything to do (a per-device role has no standing status). */
  reconcilable: boolean;
}

export const ROUTER_PROFILE: DevicePairingProfile = {
  role: "router",
  auditService: "router-pairing",
  auditEntity: "network.router_pairing",
  noun: "router",
  serviceNoun: "routing service",
  reopenHint: "Press the router's button",
  hostKey: "router_host",
  statusPath: () => "/health",
  identityPath: "/pairing/identity",
  claimPath: () => "/pairing/claim",
  pendingPath: "/pairing/pending",
  persistedPath: "/pairing/persisted",
  pairedElsewhereCode: "ROUTER_PAIRED_ELSEWHERE",
  reconcilable: true,
};

export const SWITCH_PROFILE: DevicePairingProfile = {
  role: "switch",
  auditService: "switch-pairing",
  auditEntity: "network.switch_pairing",
  noun: "switch",
  serviceNoun: "switch service",
  reopenHint: "Press the switch's button, or reset it to factory settings",
  hostKey: "switch_host",
  statusPath: () => "/health",
  identityPath: "/pairing/identity",
  claimPath: () => "/pairing/claim",
  pendingPath: "/pairing/pending",
  persistedPath: "/pairing/persisted",
  pairedElsewhereCode: "SWITCH_PAIRED_ELSEWHERE",
  unreachableCode: "SWITCH_UNREACHABLE",
  reconcilable: true,
};

const encMac = (deviceId?: string): string => encodeURIComponent(deviceId ?? "");

/**
 * AP pairing runs through routing's AP onboarding path, per MAC. The box
 * fingerprint reaches routing through the router's `PUT /pairing/identity`
 * (routing applies it to both), so the AP role publishes nothing of its own.
 * ADR-071 §2.3: ONE `ap_openwrt_password` for every AP, so pairing a second AP
 * replaces the first one's credential.
 */
export const AP_PROFILE: DevicePairingProfile = {
  role: "ap",
  auditService: "ap-pairing",
  auditEntity: "network.ap_pairing",
  noun: "access point",
  serviceNoun: "routing service",
  reopenHint: "Press the access point's button",
  hostKey: "host",
  statusPath: (mac) => `/aps/${encMac(mac)}/pairing`,
  claimPath: (mac) => `/aps/${encMac(mac)}/pairing/claim`,
  pendingPath: "/aps/pairing/pending",
  persistedPath: "/aps/pairing/persisted",
  pairedElsewhereCode: "AP_PAIRED_ELSEWHERE",
  unreachableCode: "AP_UNREACHABLE",
  reconcilable: false,
};

export interface DevicePairingDeps {
  profile: DevicePairingProfile;
  prisma: Pick<PrismaClient, "commandAuditLog">;
  identity: IdentityPort;
  /** Fetch against the OWNING service (routing for router/AP, switch service for the switch). */
  serviceFetch: PairingServiceFetch;
  /**
   * Authenticated probe that throws a typed RouterError (router only: GET
   * /system/info). Without one, the typed error comes from the status body's
   * `error_code` (the switch and AP services name their own state).
   */
  probeDevice?: () => Promise<unknown>;
  /** Defaults to global fetch; tests inject. */
  fetchImpl?: typeof fetch;
  bridgeUrl?: string;
  bridgeToken?: () => string;
}

/** SHA-256 of the DER SPKI of the box's device certificate, lowercase hex. */
export async function getBoxFingerprint(identity: IdentityPort): Promise<string> {
  const pem = await identity.getDeviceCert();
  const spki = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("hex");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The owning services' error bodies are FastAPI `{detail: {code, message}}` or flat `{code,...}`. */
function errorCodeOf(body: unknown): { code: string | null; message: string | null } {
  const top = asRecord(body);
  const inner = asRecord(top?.detail) ?? top;
  return {
    code: typeof inner?.code === "string" ? inner.code : null,
    message: typeof inner?.message === "string" ? inner.message : null,
  };
}

/** `ROUTER_AUTH` / `SWITCH_AUTH` / `AP_PAIRED_ELSEWHERE` ... -> the shared RouterErrorCode. */
function errorCodeFromWire(wire: unknown): RouterErrorCode | null {
  if (typeof wire !== "string" || !wire) return null;
  switch (wire.replace(/^(ROUTER|SWITCH|AP)_/, "")) {
    case "AUTH":
      return "AUTH";
    case "PAIRED_ELSEWHERE":
      return "PAIRED_ELSEWHERE";
    case "UNREACHABLE":
      return "UNREACHABLE";
    default:
      return "UNKNOWN";
  }
}

function claimFailure(
  profile: DevicePairingProfile,
  code: string | null,
): { status: number; error: string } | undefined {
  if (!code) return undefined;
  const { noun, reopenHint } = profile;
  if (code === profile.pairedElsewhereCode) {
    return { status: 409, error: `This ${noun} is paired to another device. ${reopenHint} to re-pair.` };
  }
  if (profile.unreachableCode && code === profile.unreachableCode) {
    return { status: 503, error: `The ${noun} could not be reached. Try again in a moment.` };
  }
  switch (code) {
    case "PAIR_WINDOW_CLOSED":
      return {
        status: 409,
        error: `The ${noun} is not accepting a pairing right now. ${reopenHint}, then try again.`,
      };
    case "PAIR_BUSY":
      return { status: 409, error: "A pairing is already in progress." };
    case "PAIR_UNSUPPORTED":
      return { status: 502, error: `This ${noun} does not support pairing.` };
    case "PAIR_CLAIM_FAILED":
      return { status: 502, error: `The ${noun} did not accept the pairing. Try again.` };
    case "PAIR_VERIFY_FAILED":
      return {
        status: 502,
        error: `The ${noun} accepted the pairing but the new credential did not work. Try again.`,
      };
    default:
      return undefined;
  }
}

export function createDevicePairingService(deps: DevicePairingDeps) {
  const { profile, prisma, identity, serviceFetch } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const bridgeToken = deps.bridgeToken ?? bridgeAdminToken;
  const bridgeUrl = (): string => deps.bridgeUrl ?? config.DEVICE_BRIDGE_URL;

  const unsupported: PairResult = {
    ok: false,
    persisted: false,
    code: "pairing_unsupported",
    error: `This Droplet's ${profile.serviceNoun} does not support pairing yet.`,
    httpStatus: 501,
  };
  const serviceUnavailable: PairResult = {
    ok: false,
    persisted: false,
    code: "routing_unavailable",
    error: `The ${profile.serviceNoun} could not be reached. Try again in a moment.`,
    httpStatus: 503,
  };

  /** One pairing write at a time per process (double-click / two admins). */
  let inFlight = false;
  /** Foreign fingerprints already audited this process (ADR-071 §2.2 step 1). */
  const auditedForeign = new Set<string>();

  async function call(
    path: string,
    method: "GET" | "POST" | "PUT",
    body?: unknown,
    label?: string,
    timeoutMs = ROUTING_TIMEOUT_MS,
  ): Promise<{ status: number; json: unknown }> {
    const res = await serviceFetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      label: label ?? path,
      signal: AbortSignal.timeout(timeoutMs),
      retry: { attempts: 1 },
      skipContactMark: path === "/health",
      passthroughStatuses: [400, 404, 409, 422, 502, 503],
    });
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  async function audit(entry: {
    userId?: string;
    deviceId?: string;
    data?: Record<string, unknown>;
    blocked?: boolean;
    confirmed: boolean;
    reason?: string;
    tier?: number;
  }): Promise<void> {
    const data = entry.deviceId ? { ...(entry.data ?? {}), mac: entry.deviceId } : entry.data;
    try {
      await prisma.commandAuditLog.create({
        data: {
          userId: entry.userId || null,
          entityId: profile.auditEntity,
          domain: AUDIT_DOMAIN,
          service: profile.auditService,
          data: data ? JSON.parse(JSON.stringify(data)) : undefined,
          tier: entry.tier ?? 2,
          confirmed: entry.confirmed,
          blocked: entry.blocked ?? false,
          reason: entry.reason ?? null,
        },
      });
    } catch (err) {
      logger.error({ err, service: profile.auditService }, "Failed to write pairing audit row");
    }
  }

  /** PUT identity. Best effort: false on any failure, never throws. */
  async function publishIdentity(): Promise<boolean> {
    if (!profile.identityPath) return false;
    try {
      const fingerprint = await getBoxFingerprint(identity);
      const r = await call(profile.identityPath, "PUT", { box_fingerprint: fingerprint }, "Pairing identity");
      if (r.status >= 200 && r.status < 300) return true;
      logger.debug(
        { status: r.status, role: profile.role },
        "service did not accept the box identity (older build?)",
      );
      return false;
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : String(err), role: profile.role },
        "box identity not published",
      );
      return false;
    }
  }

  /** One audit row per distinct foreign fingerprint (per AP, for APs), deduped in memory. */
  async function noteForeignPairing(info: {
    host: string | null;
    pairedBox: string | null;
    deviceId?: string;
  }): Promise<void> {
    const key = `${info.deviceId ? `${info.deviceId}:` : ""}${info.pairedBox ?? "unknown"}`;
    if (auditedForeign.has(key)) return;
    auditedForeign.add(key);
    await audit({
      deviceId: info.deviceId,
      confirmed: false,
      tier: 1,
      reason: "paired_elsewhere",
      data: { host: info.host, paired_box: info.pairedBox },
    });
    logger.warn({ pairedBox: info.pairedBox, role: profile.role }, "device is paired to another box");
  }

  async function readStatus(
    deviceId?: string,
  ): Promise<{ json: Record<string, unknown>; pairing: Record<string, unknown> | null } | null> {
    try {
      const r = await call(profile.statusPath(deviceId), "GET", undefined, "Health");
      const json = asRecord(r.json);
      if (!json) return null;
      return { json, pairing: asRecord(json.pairing) };
    } catch {
      return null;
    }
  }

  const empty = (code: RouterErrorCode | null = null): PairingView => ({
    available: false,
    state: null,
    windowEndsAt: null,
    pairedBox: null,
    pairedElsewhere: false,
    pendingPersist: false,
    routerErrorCode: code,
    host: null,
    model: null,
  });

  /** GET /api/network/{router|switch}/pairing, GET /api/network/aps/:mac/pairing */
  async function getPairingView(deviceId?: string): Promise<PairingView> {
    const health = await readStatus(deviceId);
    if (!health) return empty();
    const p = health.pairing;
    const hostValue = health.json[profile.hostKey];
    const host = typeof hostValue === "string" ? hostValue : null;
    if (!p) return { ...empty(), host };

    const state: PairingState =
      p.state === "open" || p.state === "closed" || p.state === "paired" ? p.state : "unknown";
    const pairedBox = typeof p.paired_box === "string" && HEX64.test(p.paired_box) ? p.paired_box : null;
    const pairedElsewhere = p.paired_elsewhere === true;

    let routerErrorCode: RouterErrorCode | null = null;
    if (pairedElsewhere) {
      routerErrorCode = "PAIRED_ELSEWHERE";
      await noteForeignPairing({ host, pairedBox, deviceId });
    } else if (deps.probeDevice) {
      if (health.json.connected !== true) {
        try {
          await deps.probeDevice();
        } catch (err) {
          routerErrorCode = err instanceof RouterError ? err.code : "UNKNOWN";
          if (err instanceof RouterError && err.code === "PAIRED_ELSEWHERE") {
            await noteForeignPairing({ host, pairedBox: err.pairedBox ?? pairedBox, deviceId });
          }
        }
      }
    } else {
      routerErrorCode = errorCodeFromWire(health.json.error_code);
    }

    return {
      available: true,
      state,
      windowEndsAt: typeof p.window_ends_at === "string" ? p.window_ends_at : null,
      pairedBox,
      pairedElsewhere,
      pendingPersist: p.pending_persist === true,
      routerErrorCode,
      host,
      model: typeof p.model === "string" ? p.model : typeof health.json.model === "string" ? health.json.model : null,
    };
  }

  /** Step 4 (persist) on its own: spool the password to the bridge. Never throws. */
  async function persistViaBridge(password: string): Promise<{ ok: boolean; error?: string }> {
    const token = bridgeToken();
    if (!token) return { ok: false, error: "bridge_auth_unconfigured" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT_MS);
    try {
      const r = await doFetch(`${bridgeUrl()}/host/router-pairing`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Droplet-Auth": token },
        body: JSON.stringify({ target: profile.role, password }),
        signal: ctrl.signal,
      });
      if (r.ok) return { ok: true };
      const parsed = asRecord(await r.json().catch(() => null));
      const code = typeof parsed?.code === "string" ? parsed.code : `http_${r.status}`;
      return { ok: false, error: code };
    } catch (err) {
      if (isBridgeConnectionError(err)) return { ok: false, error: "bridge_unavailable" };
      if (isTimeoutOrAbort(err)) return { ok: false, error: "bridge_timeout" };
      return { ok: false, error: "bridge_error" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function markPersisted(): Promise<void> {
    try {
      const r = await call(profile.persistedPath, "POST", {}, "Pairing persisted");
      if (r.status < 200 || r.status >= 300) {
        logger.warn({ status: r.status, role: profile.role }, "service did not acknowledge the persisted password");
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), role: profile.role },
        "could not tell the service the password was persisted",
      );
    }
  }

  /** POST /api/network/{router|switch}/pair, POST /api/network/aps/:mac/pair: steps 3-5 of ADR-071 §2.2. */
  async function pair(userId?: string, deviceId?: string): Promise<PairResult> {
    if (inFlight) {
      return { ok: false, persisted: false, code: "busy", error: "A pairing is already in progress.", httpStatus: 409 };
    }
    inFlight = true;
    try {
      let fingerprint: string;
      try {
        fingerprint = await getBoxFingerprint(identity);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "box identity unavailable");
        const r: PairResult = {
          ok: false,
          persisted: false,
          code: "identity_unavailable",
          error: "This Droplet's identity is not available yet. Try again in a minute.",
          httpStatus: 503,
        };
        await audit({ userId, deviceId, confirmed: true, reason: "identity_unavailable", data: {} });
        return r;
      }

      // The service needs the identity to recognise "paired elsewhere"; it also
      // refuses to claim without one, so a failure here surfaces below.
      await publishIdentity();

      let claim: { status: number; json: unknown };
      try {
        claim = await call(profile.claimPath(deviceId), "POST", { box_fingerprint: fingerprint }, "Pairing claim", CLAIM_TIMEOUT_MS);
      } catch (err) {
        const code = err instanceof RouterError ? err.code : "UNREACHABLE";
        await audit({
          userId,
          deviceId,
          confirmed: true,
          reason: `routing_${code.toLowerCase()}`,
          data: { box_fingerprint: fingerprint },
        });
        return serviceUnavailable;
      }

      const body = asRecord(claim.json);
      if (claim.status === 404 && !errorCodeOf(claim.json).code) {
        await audit({ userId, deviceId, confirmed: true, reason: "pairing_unsupported", data: { box_fingerprint: fingerprint } });
        return unsupported;
      }
      const password = typeof body?.password === "string" ? body.password : "";
      if (claim.status !== 200 || body?.ok !== true || !HEX32.test(password)) {
        const { code } = errorCodeOf(claim.json);
        const known = claimFailure(profile, code);
        await audit({
          userId,
          deviceId,
          confirmed: true,
          reason: code ?? `claim_http_${claim.status}`,
          data: { box_fingerprint: fingerprint },
        });
        return {
          ok: false,
          persisted: false,
          code: code ?? "PAIR_CLAIM_FAILED",
          error: known?.error ?? `The ${profile.noun} did not accept the pairing. Try again.`,
          httpStatus: known?.status ?? 502,
        };
      }

      const host = typeof body.host === "string" ? body.host : "";
      const model = typeof body.model === "string" ? body.model : "";
      const pairedAt = typeof body.paired_at === "string" ? body.paired_at : new Date().toISOString();
      const auditData = { host, model, box_fingerprint: fingerprint, paired_at: pairedAt };

      const saved = await persistViaBridge(password);
      if (saved.ok) await markPersisted();
      await audit({
        userId,
        deviceId,
        confirmed: true,
        data: auditData,
        reason: saved.ok ? undefined : "persist_failed",
      });
      if (!saved.ok) {
        logger.warn({ reason: saved.error, role: profile.role }, "device paired but the password was not persisted");
      }
      return {
        ok: true,
        persisted: saved.ok,
        host,
        model,
        paired_at: pairedAt,
        ...(saved.ok
          ? {}
          : { error: "Paired, but the password could not be saved. It will be lost on the next restart." }),
        httpStatus: 200,
      };
    } finally {
      inFlight = false;
    }
  }

  /** POST /api/network/{router|switch}/pair/persist: step 4 only, for the Retry button. */
  async function persistPending(userId?: string, deviceId?: string): Promise<PairResult> {
    if (inFlight) {
      return { ok: false, persisted: false, code: "busy", error: "A pairing is already in progress.", httpStatus: 409 };
    }
    inFlight = true;
    try {
      let pending: { status: number; json: unknown };
      try {
        pending = await call(profile.pendingPath, "GET", undefined, "Pairing pending");
      } catch {
        return serviceUnavailable;
      }
      if (pending.status === 404) return unsupported;
      const body = asRecord(pending.json);
      if (pending.status !== 200 || !body) {
        return { ok: false, persisted: false, code: "PAIR_PENDING_FAILED", error: "Could not read the pending pairing.", httpStatus: 502 };
      }
      if (body.pending !== true) {
        // Nothing waiting: it was already persisted (or never claimed).
        return { ok: true, persisted: true, httpStatus: 200 };
      }
      const password = typeof body.password === "string" ? body.password : "";
      if (!HEX32.test(password)) {
        return { ok: false, persisted: false, code: "PAIR_PENDING_FAILED", error: "Could not read the pending pairing.", httpStatus: 502 };
      }
      const pairedAt = typeof body.paired_at === "string" ? body.paired_at : undefined;
      // An AP's pending password belongs to the AP that was claimed last (one
      // shared secret); the service names it, the caller's MAC is not trusted.
      const pendingMac = profile.role === "ap" && typeof body.mac === "string" ? body.mac : deviceId;
      const saved = await persistViaBridge(password);
      if (saved.ok) await markPersisted();
      await audit({
        userId,
        deviceId: pendingMac,
        confirmed: true,
        data: { step: "persist", paired_at: pairedAt ?? null },
        reason: saved.ok ? undefined : "persist_failed",
      });
      return saved.ok
        ? { ok: true, persisted: true, paired_at: pairedAt, httpStatus: 200 }
        : {
            ok: true,
            persisted: false,
            paired_at: pairedAt,
            error: "Paired, but the password could not be saved. It will be lost on the next restart.",
            httpStatus: 200,
          };
    } finally {
      inFlight = false;
    }
  }

  /**
   * Startup + periodic: tell the service who this box is, and audit a device that
   * reports it is paired to someone else even when nobody has the dashboard open.
   * A per-device role (APs) has no standing status to read: no-op.
   */
  async function reconcile(): Promise<void> {
    if (!profile.reconcilable) return;
    await publishIdentity();
    const health = await readStatus();
    const p = health?.pairing;
    if (p && p.paired_elsewhere === true) {
      const hostValue = health?.json[profile.hostKey];
      await noteForeignPairing({
        host: typeof hostValue === "string" ? hostValue : null,
        pairedBox: typeof p.paired_box === "string" && HEX64.test(p.paired_box) ? p.paired_box : null,
      });
    }
  }

  return { getPairingView, pair, persistPending, publishIdentity, noteForeignPairing, reconcile };
}

export type DevicePairingService = ReturnType<typeof createDevicePairingService>;
