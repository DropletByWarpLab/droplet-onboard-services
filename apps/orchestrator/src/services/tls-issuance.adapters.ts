/**
 * ADR-023 (C2) — production adapters for the TLS issuance service.
 *
 * The pure state-machine lives in tls-issuance.service.ts and takes its
 * collaborators by injection so it unit-tests with fakes. This file wires the
 * real implementations:
 *   - HqIssuanceHttpClient  — plain outbound HTTPS to the HQ fleet-server.
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
import pino from "pino";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { bridgeAuthToken } from "../lib/bridge-errors.js";
import type {
  HqChallengeResponse,
  HqIssuanceClient,
  HqOrderRequest,
  HqOrderResponse,
  HqPollResponse,
  TlsCertRow,
  TlsCertStateValue,
  TlsCertStore,
  TlsFileOps,
} from "./tls-issuance.service.js";

const logger = pino({ name: "tls-issuance-adapters" });

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

/** Stable fingerprint helper kept here so callers outside the service can
 *  derive the same value the device-identity status reports if ever needed. */
export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
