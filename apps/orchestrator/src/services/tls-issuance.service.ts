/**
 * ADR-023 (C2) — Public-CA per-device TLS issuance client.
 *
 * Box-side half of the "automatic publicly-trusted TLS + one-URL-everywhere"
 * design. The box generates its own RSA-2048 serving keypair + a PKCS#10 CSR
 * (the CSR's only SAN is the opaque per-device FQDN), proves possession of its
 * WARP-230 TPM identity key over a single-use HQ nonce, and asks the fleet HQ
 * (`hq.warp-lab.com`) to run the ACME DNS-01 dance on `warp-lab.ai` and return
 * the signed leaf + chain. **The private serving key never leaves the box.**
 *
 * Driven by `cron-runtime.service.ts` (`scheduleCron`, daily, lockKey
 * "droplet:tls-renewal") — there is NO `while True`. Each tick is `runOnce()`:
 *
 *   - read the installed cert at docker/certs/droplet.crt
 *   - read the explicit `TlsCertState` row keyed by fqdn (NEVER infer from
 *     IS NULL — ADR-023 + architecture-guard rule on explicit enum state)
 *   - BOOTSTRAP_SELF_SIGNED  → issue now (full challenge → order → poll → install)
 *   - LE_ISSUED + (not_after - now) <= 30d → renew (same flow, /renew endpoint)
 *   - LE_ISSUED + >30d left  → no-op
 *
 * Install is atomic: temp → fsync → rename, with the LE **fullchain** written
 * into droplet.crt (so nginx needs zero config change) and the private key into
 * droplet.key (0600). The host-side nginx reload is delegated to a helper
 * (scripts/lib/tls-reload.sh) — we never mount the docker socket into the
 * orchestrator.
 *
 * Failure posture (mirrors the cron-canary convention in index.ts):
 *   - HQ unreachable / order failed / poll not active → keep serving the
 *     current cert, set state LE_RENEW_FAILED, log a warning, do NOT throw.
 *   - Any other (unexpected, non-network) error → throw, so cron-runtime's
 *     `safeRun` increments the per-handler `consecutiveFailures` canary.
 *
 * Testability: every side-effecting collaborator is injected (HQ client, the
 * device-identity client, the cert-state store, the fs ops, the nginx reloader)
 * so the unit test runs with deterministic fakes and never touches real disk,
 * gRPC, or the network.
 */
import * as forge from "node-forge";
import type { DeviceIdentityClient } from "./device-identity.client.js";

/** The exact bytes signed by the device TPM key, per the issuance contract:
 *  `droplet-cert:v1:<nonce>:<key_fingerprint>:<public_label>`. */
export const CHALLENGE_PREFIX = "droplet-cert:v1:";

/** Renew when the installed LE cert has <= this many days of validity left. */
export const RENEW_THRESHOLD_DAYS = 30;

/** The four explicit cert states. Mirrors the Prisma enum `TlsCertState`
 *  (never inferred from IS NULL — ADR-023). */
export type TlsCertStateValue =
  | "BOOTSTRAP_SELF_SIGNED"
  | "LE_ISSUED"
  | "LE_RENEWING"
  | "LE_RENEW_FAILED";

// --- HQ issuance contract (must match the HQ fleet-server EXACTLY) ----------
// Authoritative in repo DropletByWarpLab/droplet-fleet-hq (README); box mirrors HQ.

export interface HqChallengeResponse {
  nonce: string;
  expires_at: string;
  public_label: string;
  fqdn: string;
}

export interface HqOrderResponse {
  order_id: string;
  status: "pending";
  fqdn: string;
}

export interface HqPollResponse {
  status: "pending" | "active" | "failed";
  fullchain_pem?: string;
  not_after?: string;
}

export interface HqOrderRequest {
  device_id: string;
  csr_pem: string;
  nonce: string;
  /** base64 of the TPM signature over the challenge string. */
  signature: string;
  sig_alg: "ecdsa-sha256";
  key_fingerprint: string;
}

/**
 * Plain outbound HTTPS to the HQ fleet-server. The base URL comes from
 * `HQ_ISSUANCE_URL`; this client owns the five endpoints in the contract.
 */
export interface HqIssuanceClient {
  challenge(deviceId: string): Promise<HqChallengeResponse>;
  order(req: HqOrderRequest): Promise<HqOrderResponse>;
  poll(orderId: string, deviceId: string): Promise<HqPollResponse>;
  renew(req: HqOrderRequest): Promise<HqOrderResponse>;
}

// --- Persistence seam (the Prisma TlsCertState model) ----------------------

export interface TlsCertRow {
  fqdn: string;
  state: TlsCertStateValue;
  notAfter: string | null;
}

export interface TlsCertStore {
  get(fqdn: string): Promise<TlsCertRow | null>;
  upsert(
    fqdn: string,
    state: TlsCertStateValue,
    notAfter: string | null,
  ): Promise<void>;
}

// --- Filesystem seam (docker/certs) ----------------------------------------

export interface TlsFileOps {
  /** The currently-installed leaf at docker/certs/droplet.crt, or null. */
  readCert(): Promise<string | null>;
  /** Atomic write into docker/certs: temp → fsync → rename, with `mode`. */
  writeAtomic(name: "droplet.crt" | "droplet.key", data: string, mode: number): Promise<void>;
}

export interface TlsLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface TlsIssuanceDeps {
  /** The opaque per-device FQDN `d-<hmac>.devices.warp-lab.ai`. Empty before
   *  first HQ contact — runOnce() is a no-op until it is known. */
  fqdn: string;
  deviceId: string;
  hq: HqIssuanceClient;
  identity: Pick<
    DeviceIdentityClient,
    "signWithDeviceKey" | "getDeviceIdentityStatus"
  >;
  store: TlsCertStore;
  files: TlsFileOps;
  /** Trigger the host-side `nginx -s reload` (scripts/lib/tls-reload.sh). */
  reloadNginx(): Promise<void>;
  logger: TlsLogger;
}

export interface TlsIssuanceService {
  /** One cron tick. See the file header for the state machine. */
  runOnce(): Promise<void>;
}

/** Network-ish failure → degrade gracefully (keep cert, mark LE_RENEW_FAILED,
 *  warn, no throw). Anything else (TypeError, programming bugs) propagates. */
function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return false;
  const code = (err as { code?: string })?.code;
  if (
    code &&
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EHOSTUNREACH",
      "ENETUNREACH",
    ].includes(code)
  ) {
    return true;
  }
  // Only treat Errors that originate from the HQ HTTP client as transient.
  // hqFetch throws `new Error("HQ <path> returned <status>: …")` for non-2xx.
  // RangeError, ReferenceError, SyntaxError, and other programming bugs must
  // propagate so the cron canary increments (no silent cert-renewal failure).
  return err instanceof Error && (err as Error).message.startsWith("HQ ");
}

function daysUntil(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const ms = new Date(iso).getTime() - Date.now();
  return ms / 86_400_000;
}

/**
 * Generate an RSA-2048 keypair + a PKCS#10 CSR whose ONLY SAN is `fqdn`.
 * The private key is returned PEM-encoded for local storage and is NEVER
 * transmitted; only `csrPem` leaves the box.
 */
export function generateKeyPairAndCsr(fqdn: string): {
  csrPem: string;
  keyPem: string;
} {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: "commonName", value: fqdn }]);
  // The single SAN. ADR-023: CSR's only SAN == fqdn (CT publishes the name;
  // no other identifier ever appears in the cert).
  csr.setAttributes([
    {
      name: "extensionRequest",
      extensions: [
        {
          name: "subjectAltName",
          altNames: [{ type: 2, value: fqdn }], // type 2 = dNSName
        },
      ],
    },
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return {
    csrPem: forge.pki.certificationRequestToPem(csr),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

export function createTlsIssuanceService(
  deps: TlsIssuanceDeps,
): TlsIssuanceService {
  const { fqdn, deviceId, hq, identity, store, files, reloadNginx, logger } =
    deps;

  /** The full issuance/renewal flow. Returns the new not_after on success. */
  async function issueOrRenew(mode: "issue" | "renew"): Promise<string> {
    // 1. Challenge.
    const ch = await hq.challenge(deviceId);

    // 2. Sign the exact contract string with the device TPM key.
    const fingerprint = (await identity.getDeviceIdentityStatus())
      .certFingerprint;
    const challengeStr = `${CHALLENGE_PREFIX}${ch.nonce}:${fingerprint}:${ch.public_label}`;
    const sig = await identity.signWithDeviceKey(
      new TextEncoder().encode(challengeStr),
    );
    const signatureB64 = Buffer.from(sig.signature).toString("base64");

    // 3. Generate keypair + CSR locally (private key never transmitted).
    const { csrPem, keyPem } = generateKeyPairAndCsr(ch.fqdn);

    const orderReq: HqOrderRequest = {
      device_id: deviceId,
      csr_pem: csrPem,
      nonce: ch.nonce,
      signature: signatureB64,
      sig_alg: "ecdsa-sha256",
      key_fingerprint: fingerprint,
    };

    // 4. Submit the order (issue vs renew share the body shape).
    const placed = mode === "renew" ? await hq.renew(orderReq) : await hq.order(orderReq);

    // 5. Poll until active. Up to 5 attempts with exponential back-off (10 s,
    //    20 s, 40 s, 80 s, capped at 5 min) to absorb DNS propagation delays at
    //    HQ. If still not active after all attempts, throw TlsIssuancePendingError
    //    so the catch records LE_RENEW_FAILED and the next daily tick retries.
    const POLL_MAX_ATTEMPTS = 5;
    const POLL_BASE_DELAY_MS = 10_000;
    let result = await hq.poll(placed.order_id, deviceId);
    for (
      let attempt = 1;
      attempt < POLL_MAX_ATTEMPTS && result.status === "pending";
      attempt++
    ) {
      const delay = Math.min(POLL_BASE_DELAY_MS * 2 ** (attempt - 1), 300_000);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      result = await hq.poll(placed.order_id, deviceId);
    }
    if (result.status !== "active" || !result.fullchain_pem || !result.not_after) {
      // HQ accepted the order but the DNS-01 dance didn't complete (or failed).
      // Treat as a recoverable failure: keep the current cert, mark
      // LE_RENEW_FAILED. The next cron tick retries.
      throw new TlsIssuancePendingError(
        `HQ order ${placed.order_id} is ${result.status}, not active`,
      );
    }

    // 6. Atomic install: LE fullchain → droplet.crt (644), key → droplet.key (600).
    //    Write the key FIRST so a crash between writes never leaves a cert
    //    whose matching key is missing (nginx would fail to start); a cert
    //    that still trails the old key just keeps serving the old pair until
    //    the next tick.
    await files.writeAtomic("droplet.key", keyPem, 0o600);
    await files.writeAtomic("droplet.crt", result.fullchain_pem, 0o644);

    // 7. Reload nginx so the new pair is served immediately.
    await reloadNginx();

    return result.not_after;
  }

  return {
    async runOnce() {
      // No fqdn yet (box hasn't learned its name from HQ) → nothing to do.
      // The bootstrap self-signed cert keeps the box serving TLS meanwhile.
      if (!fqdn) {
        logger.info(
          {},
          "tls-issuance: no DROPLET_PUBLIC_FQDN configured yet — skipping (serving bootstrap self-signed cert)",
        );
        return;
      }

      // Read the explicit state row. A missing row is treated as
      // BOOTSTRAP_SELF_SIGNED (the box has a self-signed cert from secrets.sh)
      // — NEVER inferred from a null cert.
      const existing = await store.get(fqdn);
      const state: TlsCertStateValue =
        existing?.state ?? "BOOTSTRAP_SELF_SIGNED";

      // Decide: issue, renew, or no-op.
      let mode: "issue" | "renew" | "noop";
      if (state === "BOOTSTRAP_SELF_SIGNED") {
        mode = "issue";
      } else if (state === "LE_ISSUED" || state === "LE_RENEW_FAILED" || state === "LE_RENEWING") {
        if (state === "LE_RENEW_FAILED" && (existing?.notAfter ?? null) === null) {
          // First-ever issuance failed (no cert ever issued). Use order(), NOT
          // renew(): /api/issuance/renew requires an existing cert at HQ; calling
          // it without one permanently routes this box to the wrong endpoint with
          // no self-recovery.
          mode = "issue";
        } else {
          // For an issued (or previously-failed / interrupted) cert, renew when
          // we're inside the 30-day window. A LE_RENEW_FAILED row with time left
          // also retries via the renew path.
          mode = daysUntil(existing?.notAfter ?? null) <= RENEW_THRESHOLD_DAYS ? "renew" : "noop";
        }
      } else {
        mode = "noop";
      }

      if (mode === "noop") {
        logger.info(
          { fqdn, state, notAfter: existing?.notAfter },
          "tls-issuance: cert healthy, nothing to do",
        );
        return;
      }

      // Mark in-flight so a concurrent observer sees the renewal underway.
      if (mode === "renew") {
        await store.upsert(fqdn, "LE_RENEWING", existing?.notAfter ?? null);
      }

      try {
        const notAfter = await issueOrRenew(mode);
        await store.upsert(fqdn, "LE_ISSUED", notAfter);
        logger.info(
          { fqdn, mode, notAfter },
          "tls-issuance: installed publicly-trusted cert",
        );
      } catch (err) {
        if (err instanceof TlsIssuancePendingError || isTransientNetworkError(err)) {
          // Keep serving the current cert; record the failure for the next tick.
          await store.upsert(fqdn, "LE_RENEW_FAILED", existing?.notAfter ?? null);
          logger.warn(
            { err, fqdn, mode },
            "tls-issuance: HQ unreachable or order not ready — keeping current cert (LE_RENEW_FAILED)",
          );
          return;
        }
        // Unexpected error — let it propagate so the cron canary increments.
        throw err;
      }
    },
  };
}

/** HQ accepted the order but it isn't active yet (or failed). Recoverable. */
export class TlsIssuancePendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsIssuancePendingError";
  }
}
