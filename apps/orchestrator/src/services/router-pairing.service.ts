/**
 * Router pairing orchestration (ADR-071 slice B, WARP-3739).
 *
 * The edge router opens a pairing window, the routing service mints + claims the
 * `droplet-ai` credential (`POST /pairing/claim`), and this module is the middle
 * hop that: (1) tells routing which box fingerprint is "us", (2) dispatches the
 * freshly-claimed password to the device-bridge so it lands in
 * docker/secrets/openwrt_password, (3) tells routing it was persisted, and
 * (4) writes ONE `CommandAuditLog` row per attempt.
 *
 * THE PASSWORD'S ONLY ROUTE: routing response body -> a local const -> the
 * bridge request body. It is never logged, never put in an audit row, never
 * returned to the caller, and never held after the function returns.
 *
 * DEGRADATION: every routing call tolerates a routing build that predates the
 * pairing endpoints (404 / no `pairing` in /health): the card simply never shows
 * and the existing "Credentials rejected" state stands.
 */

import { createHash, X509Certificate } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import { bridgeAdminToken, isBridgeConnectionError, isTimeoutOrAbort } from "../lib/bridge-errors.js";
import { RouterError } from "../types/router-error.js";
import type { RouterErrorCode } from "../types/router-error.js";

const logger = createLogger("router-pairing");

const AUDIT_DOMAIN = "network";
const AUDIT_SERVICE = "router-pairing";
const AUDIT_ENTITY = "network.router_pairing";
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Bounded: routing logs in with the new password before it answers. */
const CLAIM_TIMEOUT_MS = 30_000;
const ROUTING_TIMEOUT_MS = 10_000;
/** The bridge waits up to 130 s for the root unit (one compose recreate). */
const BRIDGE_TIMEOUT_MS = 140_000;

export type PairingState = "open" | "closed" | "paired" | "unknown";

/** What the dashboard card reads. `available:false` = routing has no pairing surface. */
export interface PairingView {
  available: boolean;
  state: PairingState | null;
  windowEndsAt: string | null;
  pairedBox: string | null;
  pairedElsewhere: boolean;
  pendingPersist: boolean;
  /** Typed router error right now (AUTH, PAIRED_ELSEWHERE, UNREACHABLE...), or null when healthy. */
  routerErrorCode: RouterErrorCode | null;
  host: string | null;
  model: string | null;
}

export interface PairResult {
  ok: boolean;
  /** Only meaningful when `ok`. false = routing holds the password in memory only. */
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

type RoutingFetch = (
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

export interface RouterPairingDeps {
  prisma: Pick<PrismaClient, "commandAuditLog">;
  identity: IdentityPort;
  routingFetch: RoutingFetch;
  /** Authenticated probe that throws a typed RouterError (default: GET /system/info). */
  probeRouter: () => Promise<unknown>;
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

/** Routing's error bodies are FastAPI `{detail: {code, message}}` or flat `{code,...}`. */
function errorCodeOf(body: unknown): { code: string | null; message: string | null } {
  const top = asRecord(body);
  const inner = asRecord(top?.detail) ?? top;
  return {
    code: typeof inner?.code === "string" ? inner.code : null,
    message: typeof inner?.message === "string" ? inner.message : null,
  };
}

const CLAIM_FAILURES: Record<string, { status: number; error: string }> = {
  PAIR_WINDOW_CLOSED: {
    status: 409,
    error: "The router is not accepting a pairing right now. Press the router's button, then try again.",
  },
  ROUTER_PAIRED_ELSEWHERE: {
    status: 409,
    error: "This router is paired to another device. Press the router's button to re-pair.",
  },
  PAIR_UNSUPPORTED: { status: 502, error: "This router does not support pairing." },
  PAIR_CLAIM_FAILED: { status: 502, error: "The router did not accept the pairing. Try again." },
  PAIR_VERIFY_FAILED: {
    status: 502,
    error: "The router accepted the pairing but the new credential did not work. Try again.",
  },
};

const UNSUPPORTED: PairResult = {
  ok: false,
  persisted: false,
  code: "pairing_unsupported",
  error: "This Droplet's routing service does not support pairing yet.",
  httpStatus: 501,
};

export function createRouterPairingService(deps: RouterPairingDeps) {
  const { prisma, identity, routingFetch } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const bridgeToken = deps.bridgeToken ?? bridgeAdminToken;
  const bridgeUrl = (): string => deps.bridgeUrl ?? config.DEVICE_BRIDGE_URL;

  /** One pairing write at a time per process (double-click / two admins). */
  let inFlight = false;
  /** Foreign fingerprints already audited this process (ADR-071 §2.2 step 1). */
  const auditedForeign = new Set<string>();

  async function routing(
    path: string,
    method: "GET" | "POST" | "PUT",
    body?: unknown,
    label?: string,
    timeoutMs = ROUTING_TIMEOUT_MS,
  ): Promise<{ status: number; json: unknown }> {
    const res = await routingFetch(path, {
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
    data?: Record<string, unknown>;
    blocked?: boolean;
    confirmed: boolean;
    reason?: string;
    tier?: number;
  }): Promise<void> {
    try {
      await prisma.commandAuditLog.create({
        data: {
          userId: entry.userId || null,
          entityId: AUDIT_ENTITY,
          domain: AUDIT_DOMAIN,
          service: AUDIT_SERVICE,
          data: entry.data ? JSON.parse(JSON.stringify(entry.data)) : undefined,
          tier: entry.tier ?? 2,
          confirmed: entry.confirmed,
          blocked: entry.blocked ?? false,
          reason: entry.reason ?? null,
        },
      });
    } catch (err) {
      logger.error({ err }, "Failed to write router-pairing audit row");
    }
  }

  /** PUT /pairing/identity. Best effort: false on any failure, never throws. */
  async function publishIdentity(): Promise<boolean> {
    try {
      const fingerprint = await getBoxFingerprint(identity);
      const r = await routing("/pairing/identity", "PUT", { box_fingerprint: fingerprint }, "Pairing identity");
      if (r.status >= 200 && r.status < 300) return true;
      logger.debug({ status: r.status }, "routing did not accept the box identity (older routing build?)");
      return false;
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : String(err) }, "box identity not published");
      return false;
    }
  }

  /** One audit row per distinct foreign fingerprint, deduped in memory. */
  async function noteForeignPairing(info: { host: string | null; pairedBox: string | null }): Promise<void> {
    const key = info.pairedBox ?? "unknown";
    if (auditedForeign.has(key)) return;
    auditedForeign.add(key);
    await audit({
      confirmed: false,
      tier: 1,
      reason: "paired_elsewhere",
      data: { host: info.host, paired_box: info.pairedBox },
    });
    logger.warn({ pairedBox: info.pairedBox }, "router is paired to another device");
  }

  async function readHealth(): Promise<{ json: Record<string, unknown>; pairing: Record<string, unknown> | null } | null> {
    try {
      const r = await routing("/health", "GET", undefined, "Health");
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

  /** GET /api/network/router/pairing */
  async function getPairingView(): Promise<PairingView> {
    const health = await readHealth();
    if (!health) return empty();
    const p = health.pairing;
    const host = typeof health.json.router_host === "string" ? health.json.router_host : null;
    if (!p) return { ...empty(), host };

    const state: PairingState =
      p.state === "open" || p.state === "closed" || p.state === "paired" ? p.state : "unknown";
    const pairedBox = typeof p.paired_box === "string" && HEX64.test(p.paired_box) ? p.paired_box : null;
    const pairedElsewhere = p.paired_elsewhere === true;

    let routerErrorCode: RouterErrorCode | null = null;
    if (pairedElsewhere) {
      routerErrorCode = "PAIRED_ELSEWHERE";
      await noteForeignPairing({ host, pairedBox });
    } else if (health.json.connected !== true) {
      try {
        await deps.probeRouter();
      } catch (err) {
        routerErrorCode = err instanceof RouterError ? err.code : "UNKNOWN";
        if (err instanceof RouterError && err.code === "PAIRED_ELSEWHERE") {
          await noteForeignPairing({ host, pairedBox: err.pairedBox ?? pairedBox });
        }
      }
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
        body: JSON.stringify({ target: "router", password }),
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
      const r = await routing("/pairing/persisted", "POST", {}, "Pairing persisted");
      if (r.status < 200 || r.status >= 300) {
        logger.warn({ status: r.status }, "routing did not acknowledge the persisted password");
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "could not tell routing the password was persisted");
    }
  }

  /** POST /api/network/router/pair: steps 3-5 of ADR-071 §2.2. */
  async function pair(userId?: string): Promise<PairResult> {
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
        await audit({ userId, confirmed: true, reason: "identity_unavailable", data: {} });
        return r;
      }

      // Routing needs the identity to recognise "paired elsewhere"; it also
      // refuses to claim without one, so a failure here surfaces below.
      await publishIdentity();

      let claim: { status: number; json: unknown };
      try {
        claim = await routing("/pairing/claim", "POST", { box_fingerprint: fingerprint }, "Pairing claim", CLAIM_TIMEOUT_MS);
      } catch (err) {
        const code = err instanceof RouterError ? err.code : "UNREACHABLE";
        await audit({ userId, confirmed: true, reason: `routing_${code.toLowerCase()}`, data: { box_fingerprint: fingerprint } });
        return {
          ok: false,
          persisted: false,
          code: "routing_unavailable",
          error: "The routing service could not be reached. Try again in a moment.",
          httpStatus: 503,
        };
      }

      const body = asRecord(claim.json);
      if (claim.status === 404 && !errorCodeOf(claim.json).code) {
        await audit({ userId, confirmed: true, reason: "pairing_unsupported", data: { box_fingerprint: fingerprint } });
        return UNSUPPORTED;
      }
      const password = typeof body?.password === "string" ? body.password : "";
      if (claim.status !== 200 || body?.ok !== true || !HEX32.test(password)) {
        const { code } = errorCodeOf(claim.json);
        const known = code ? CLAIM_FAILURES[code] : undefined;
        await audit({
          userId,
          confirmed: true,
          reason: code ?? `claim_http_${claim.status}`,
          data: { box_fingerprint: fingerprint },
        });
        return {
          ok: false,
          persisted: false,
          code: code ?? "PAIR_CLAIM_FAILED",
          error: known?.error ?? "The router did not accept the pairing. Try again.",
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
        confirmed: true,
        data: auditData,
        reason: saved.ok ? undefined : "persist_failed",
      });
      if (!saved.ok) logger.warn({ reason: saved.error }, "router paired but the password was not persisted");
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

  /** POST /api/network/router/pair/persist: step 4 only, for the Retry button. */
  async function persistPending(userId?: string): Promise<PairResult> {
    if (inFlight) {
      return { ok: false, persisted: false, code: "busy", error: "A pairing is already in progress.", httpStatus: 409 };
    }
    inFlight = true;
    try {
      let pending: { status: number; json: unknown };
      try {
        pending = await routing("/pairing/pending", "GET", undefined, "Pairing pending");
      } catch {
        return {
          ok: false,
          persisted: false,
          code: "routing_unavailable",
          error: "The routing service could not be reached. Try again in a moment.",
          httpStatus: 503,
        };
      }
      if (pending.status === 404) return UNSUPPORTED;
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
      const saved = await persistViaBridge(password);
      if (saved.ok) await markPersisted();
      await audit({
        userId,
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
   * Startup + periodic: tell routing who this box is, and audit a router that
   * reports it is paired to someone else even when nobody has the dashboard open.
   */
  async function reconcile(): Promise<void> {
    await publishIdentity();
    const health = await readHealth();
    const p = health?.pairing;
    if (p && p.paired_elsewhere === true) {
      await noteForeignPairing({
        host: typeof health?.json.router_host === "string" ? health.json.router_host : null,
        pairedBox: typeof p.paired_box === "string" && HEX64.test(p.paired_box) ? p.paired_box : null,
      });
    }
  }

  return { getPairingView, pair, persistPending, publishIdentity, noteForeignPairing, reconcile };
}

export type RouterPairingService = ReturnType<typeof createRouterPairingService>;
