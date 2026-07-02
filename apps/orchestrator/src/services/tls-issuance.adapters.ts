/**
 * ADR-023 (C2) — production adapters for the TLS issuance service.
 *
 * The pure state-machine lives in tls-issuance.service.ts and takes its
 * collaborators by injection so it unit-tests with fakes. This file wires the
 * real implementations:
 *   - HqIssuanceHttpClient  — plain outbound HTTPS to the HQ fleet-server
 *                            (repo DropletByWarpLab/droplet-fleet-hq).
 *   - PrismaTlsCertStore    — the explicit `TlsCert` enum-backed model.
 *   - DiskTlsFileOps        — atomic temp→fsync→rename writes into docker/certs.
 *   - bridgeNginxReloader   — triggers the host reload via the device-bridge.
 *
 * Kept out of the .test.ts's import graph (the service test never touches real
 * disk / gRPC / network); index.ts composes these into createTlsIssuanceService.
 */
import { createHash } from "node:crypto";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { bridgeAuthToken } from "../lib/bridge-errors.js";
import { RouterError, routingFetch } from "./openwrt.client.js";
import { claimBoxName, type ClaimBoxNameResult } from "./tls-issuance.service.js";
import { createDeviceIdentityClient } from "./device-identity.client.js";
import type {
  DnsRegistrar,
  HqChallengeResponse,
  HqClaimNameRequest,
  HqClaimNameResponse,
  HqDeregisterRequest,
  HqDeregisterResponse,
  HqIssuanceClient,
  HqOrderRequest,
  HqOrderResponse,
  HqPollResponse,
  HqProvisionRequest,
  HqProvisionResponse,
  HqReleaseRequest,
  HqReleaseResponse,
  TlsCertRow,
  TlsCertStateValue,
  TlsCertStore,
  TlsFileOps,
} from "./tls-issuance.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("tls-issuance-adapters");

/** docker/certs lives at the repo root; the orchestrator container mounts it
 *  read-write at /app/docker/certs (see docker-compose.yml). The dir is
 *  configurable for tests / non-standard layouts. */
const CERTS_DIR = process.env.DROPLET_CERTS_DIR || "/app/docker/certs";

const HQ_HTTP_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HQ issuance HTTP client
// ---------------------------------------------------------------------------

async function hqFetch<T>(path: string, init: RequestInit): Promise<T> {
  const base = config.HQ_ISSUANCE_URL.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HQ_HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      // A non-2xx is a recoverable HQ-side condition — the service classifies a
      // generic Error as transient (keep cert, LE_RENEW_FAILED), so a flaky HQ
      // never crash-loops the box.
      throw new Error(`HQ ${path} returned ${r.status}: ${body.slice(0, 200)}`);
    }
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function createHqIssuanceClient(): HqIssuanceClient {
  return {
    challenge(deviceId) {
      return hqFetch<HqChallengeResponse>("/api/issuance/order/challenge", {
        method: "POST",
        body: JSON.stringify({ device_id: deviceId }),
      });
    },
    order(req: HqOrderRequest) {
      return hqFetch<HqOrderResponse>("/api/issuance/order", {
        method: "POST",
        body: JSON.stringify(req),
      });
    },
    poll(orderId, deviceId) {
      const qs = new URLSearchParams({ device_id: deviceId }).toString();
      return hqFetch<HqPollResponse>(
        `/api/issuance/order/${encodeURIComponent(orderId)}?${qs}`,
        { method: "GET" },
      );
    },
    renew(req: HqOrderRequest) {
      return hqFetch<HqOrderResponse>("/api/issuance/renew", {
        method: "POST",
        body: JSON.stringify(req),
      });
    },
    deregister(req: HqDeregisterRequest) {
      // ADR-023 PR-3: the deployed HQ Worker reads device_id from BOTH the query
      // string (router) AND the JSON body (handler), and requires the four PoP
      // auth fields in the body. Send device_id in both so a stricter Worker
      // build can't 422 us; the body carries the signed proof-of-possession.
      const qs = new URLSearchParams({ device_id: req.device_id }).toString();
      return hqFetch<HqDeregisterResponse>(
        `/api/issuance/registration?${qs}`,
        { method: "DELETE", body: JSON.stringify(req) },
      );
    },
    provision(req: HqProvisionRequest) {
      // WARP-983: box self-enrolls into the HQ registry with the one-time token
      // + a TPM PoP over it. Same hqFetch error handling as the other calls — a
      // non-2xx throws `HQ /api/issuance/provision returned <status>: <body>`,
      // which the service treats as a fail-safe (keep the bootstrap cert, never
      // crash). HQ returns { device_id, status: "registered", idempotent }.
      return hqFetch<HqProvisionResponse>("/api/issuance/provision", {
        method: "POST",
        body: JSON.stringify(req),
      });
    },
    claimName(req: HqClaimNameRequest) {
      // WARP-980: the owner renaming the box RE-CLAIMS a name via device-auth
      // PoP (no token). The RAW name rides in the body (HQ slugs it); the four
      // PoP fields authenticate the claim over a fresh nonce. Same hqFetch error
      // handling — a non-2xx throws `HQ /api/issuance/claim-name returned
      // <status>: <body>`, which claimBoxName classifies (409 taken +
      // suggestions, 403 not-registered, 422 invalid, 401 retryable). HQ returns
      // { device_id, name(slug), fqdn, status: "claimed"|"owned" }.
      return hqFetch<HqClaimNameResponse>("/api/issuance/claim-name", {
        method: "POST",
        body: JSON.stringify(req),
      });
    },
    release(deviceId: string, req: HqReleaseRequest) {
      // WARP-980: factory-reset's DEFAULT path — frees the NAME + revokes the
      // cert but KEEPS the device registered/trusted (self-heals). device_id
      // rides in the QUERY string (read by the router); the body is the PoP-only
      // proof and MUST NOT carry device_id. Same hqFetch error handling — a
      // non-2xx throws `HQ /api/issuance/release returned <status>: <body>`,
      // which releaseFromHq treats as non-fatal (a reset must complete). HQ
      // returns { device_id, status: "released" }.
      const qs = new URLSearchParams({ device_id: deviceId }).toString();
      return hqFetch<HqReleaseResponse>(`/api/issuance/release?${qs}`, {
        method: "POST",
        body: JSON.stringify(req),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Prisma-backed cert-state store
// ---------------------------------------------------------------------------

export function createPrismaTlsCertStore(
  prisma: Pick<PrismaClient, "tlsCert">,
): TlsCertStore {
  return {
    async get(fqdn): Promise<TlsCertRow | null> {
      const row = await prisma.tlsCert.findUnique({ where: { fqdn } });
      if (!row) return null;
      return {
        fqdn: row.fqdn,
        state: row.state as TlsCertStateValue,
        notAfter: row.notAfter ? row.notAfter.toISOString() : null,
      };
    },
    async upsert(fqdn, state, notAfter) {
      const notAfterDate = notAfter ? new Date(notAfter) : null;
      await prisma.tlsCert.upsert({
        where: { fqdn },
        create: { fqdn, state, notAfter: notAfterDate },
        update: { state, notAfter: notAfterDate },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Atomic disk file ops (docker/certs)
// ---------------------------------------------------------------------------

/** Atomic write: write to a sibling temp, fsync it, then rename over the target
 *  (rename is atomic on the same filesystem). The temp carries the final mode
 *  so the rename never exposes a transiently-permissive file. */
async function writeFileAtomic(
  target: string,
  data: string,
  mode: number,
): Promise<void> {
  const dir = dirname(target);
  const tmp = join(dir, `.${Date.now()}.${process.pid}.tmp`);
  await writeFile(tmp, data, { mode });
  // fsync the file contents before the rename so a power-cut can't leave a
  // renamed-but-empty file (mirrors scripts/lib/secrets.sh's durable writes).
  const fh = await open(tmp, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, target);
  } catch (err) {
    // Clean up the temp file so private-key material doesn't linger in
    // docker/certs/ after a failed atomic swap (e.g. volume remount).
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export function createDiskTlsFileOps(): TlsFileOps {
  const certPath = join(CERTS_DIR, "droplet.crt");
  const keyPath = join(CERTS_DIR, "droplet.key");
  return {
    async readCert() {
      try {
        const { readFile } = await import("node:fs/promises");
        return await readFile(certPath, "utf8");
      } catch {
        // Missing cert is not an error here — the bootstrap path may not have
        // run yet; the state row is the source of truth, not the file.
        return null;
      }
    },
    async writeAtomic(name, data, mode) {
      await writeFileAtomic(name === "droplet.crt" ? certPath : keyPath, data, mode);
    },
  };
}

// ---------------------------------------------------------------------------
// nginx reload via the device-bridge (no docker socket in the orchestrator)
// ---------------------------------------------------------------------------

/**
 * Trigger the host-side `nginx -s reload` through the device-bridge's auth-gated
 * POST /tls/reload. The cert files are already on disk; this only asks the
 * gateway container to re-read them. A reload failure is logged but does NOT
 * throw — the box keeps serving the previous cert and the next tick retries.
 */
export async function bridgeNginxReloader(): Promise<void> {
  const token = bridgeAuthToken();
  if (!token) {
    logger.warn(
      {},
      "tls-issuance: device-bridge auth token not configured — cannot reload nginx; new cert serves on next gateway restart",
    );
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HQ_HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(`${config.DEVICE_BRIDGE_URL}/tls/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Droplet-Auth": token },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      logger.warn(
        { status: r.status, body: body.slice(0, 200) },
        "tls-issuance: device-bridge nginx reload failed — new cert serves on next gateway restart",
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "tls-issuance: could not reach device-bridge to reload nginx — new cert serves on next gateway restart",
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// ADR-023 PR-1 (Gap 1) — persist a learned FQDN back to .env via the bridge
// ---------------------------------------------------------------------------

/**
 * Write a freshly-LEARNED `DROPLET_PUBLIC_FQDN` back to the host `.env` through
 * the device-bridge's auth-gated POST /host/public-fqdn (which shells the
 * repo-tracked host wrapper scripts/host/droplet-set-public-fqdn.sh). The
 * orchestrator deliberately can't write the host `.env` itself (no host mount),
 * so — exactly like bridgeNginxReloader for the docker socket — the write-back
 * runs on the host behind the bridge.
 *
 * Fire-and-forget: every failure (no auth token, bridge unreachable, non-2xx,
 * host-script refusal) is LOGGED, never thrown. The learned name is already in
 * the running cert-state row, so a missed write-back only means the next boot
 * re-learns it from HQ — no correctness loss.
 */
export function createBridgeFqdnPersister(): (fqdn: string) => Promise<void> {
  return async function persistFqdn(fqdn: string): Promise<void> {
    const token = bridgeAuthToken();
    if (!token) {
      logger.warn(
        {},
        "tls-issuance: device-bridge auth token not configured — cannot persist learned DROPLET_PUBLIC_FQDN; it will be re-learned next boot",
      );
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HQ_HTTP_TIMEOUT_MS);
    try {
      const r = await fetch(`${config.DEVICE_BRIDGE_URL}/host/public-fqdn`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Droplet-Auth": token },
        body: JSON.stringify({ fqdn }),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        logger.warn(
          { status: r.status, body: body.slice(0, 200), fqdn },
          "tls-issuance: device-bridge public-fqdn write-back failed — DROPLET_PUBLIC_FQDN will be re-learned next boot",
        );
      }
    } catch (err) {
      logger.warn(
        { err, fqdn },
        "tls-issuance: could not reach device-bridge to persist DROPLET_PUBLIC_FQDN — it will be re-learned next boot",
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// WARP-979 — persist the owner-chosen box name back to .env via the bridge
// ---------------------------------------------------------------------------

/**
 * Write the owner-chosen `DROPLET_BOX_NAME` back to the host `.env` through the
 * device-bridge's auth-gated POST /host/box-name (the SAME transport
 * createBridgeFqdnPersister uses for DROPLET_PUBLIC_FQDN — the orchestrator has
 * no host mount, so host `.env` writes run behind the bridge). tls-issuance
 * reads this on the next boot and sends it to HQ as `requested_name`.
 *
 * Fire-and-forget: every failure (no auth token, bridge unreachable, non-2xx,
 * host-script refusal) is LOGGED, never thrown — matching the fqdn persister.
 * The route has already accepted the request; a failed write-back only means
 * the box keeps its previous name until the owner retries.
 */
export function createBridgeBoxNamePersister(): (name: string) => Promise<void> {
  return async function persistBoxName(name: string): Promise<void> {
    const token = bridgeAuthToken();
    if (!token) {
      logger.warn(
        {},
        "box-name: device-bridge auth token not configured — cannot persist DROPLET_BOX_NAME; the box keeps its previous name",
      );
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HQ_HTTP_TIMEOUT_MS);
    try {
      const r = await fetch(`${config.DEVICE_BRIDGE_URL}/host/box-name`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Droplet-Auth": token },
        body: JSON.stringify({ name }),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        logger.warn(
          { status: r.status, body: body.slice(0, 200), name },
          "box-name: device-bridge box-name write-back failed — the box keeps its previous name",
        );
      }
    } catch (err) {
      logger.warn(
        { err, name },
        "box-name: could not reach device-bridge to persist DROPLET_BOX_NAME — the box keeps its previous name",
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// WARP-980 — device-auth box-name claimer (rename → authoritative name claim)
// ---------------------------------------------------------------------------

/**
 * Compose the production `claimBoxName` bound to this box's identity: the real HQ
 * HTTP client + the device-identity gRPC signer + `config.DROPLET_DEVICE_ID`. The
 * rename endpoint calls this AFTER persisting the chosen name so HQ makes the name
 * AUTHORITATIVE via device-auth PoP (no token). Injectable into the setup router
 * so route tests pass a fake (no HQ / device-identity sidecar touched).
 *
 * `claimBoxName` is itself fail-safe (never throws), so this is a thin binder — no
 * extra error handling needed here.
 */
export function createBoxNameClaimer(): (raw: string) => Promise<ClaimBoxNameResult> {
  return function claim(raw: string): Promise<ClaimBoxNameResult> {
    return claimBoxName(raw, {
      deviceId: config.DROPLET_DEVICE_ID,
      hq: createHqIssuanceClient(),
      identity: createDeviceIdentityClient(),
      logger,
    });
  };
}

// ---------------------------------------------------------------------------
// ADR-023 PR-1 (Gap 2) — split-horizon DNS registrar (routing/container leg)
// ---------------------------------------------------------------------------

/**
 * Register the learned per-device FQDN → `DROPLET_PUBLIC_FQDN_IP` (the WG
 * gateway, default 192.168.20.1) with the routing service's dnsmasq via POST
 * /dhcp/hostnames — the SAME mechanism setup_router_dns / setup_public_fqdn_dns
 * use, so the name resolves on the LAN AND over the tunnel.
 *
 * Uses the shared `routingFetch` helper, so ROUTING_MODE=disabled short-circuits
 * with RouterError.disabled() (no spurious retries against a non-existent
 * service) and the shared bearer token is attached automatically. Best-effort:
 * any failure — disabled mode, unreachable router, non-2xx — is swallowed +
 * logged so a DNS hiccup NEVER aborts a successful cert install. (The host
 * dnsmasq leg is owned by droplet-set-public-fqdn.sh → setup_public_fqdn_dns;
 * this is the routing/container leg.)
 */
export function createRoutingDnsRegistrar(): DnsRegistrar {
  return {
    async register(hostname: string): Promise<void> {
      try {
        await routingFetch("/dhcp/hostnames", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hostname,
            ip: config.DROPLET_PUBLIC_FQDN_IP,
          }),
          label: "Split-horizon FQDN registration",
        });
      } catch (err) {
        if (err instanceof RouterError && err.code === "DISABLED") return;
        logger.warn(
          { err, hostname, ip: config.DROPLET_PUBLIC_FQDN_IP },
          "tls-issuance: split-horizon DNS registration failed — cert installed, name resolves on next setup run",
        );
      }
    },
  };
}

/** Stable fingerprint helper kept here so callers outside the service can
 *  derive the same value the device-identity status reports if ever needed. */
export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
