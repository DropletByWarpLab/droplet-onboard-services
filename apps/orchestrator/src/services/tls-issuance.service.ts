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
import { validateBoxName } from "@droplet/shared-types";
import type { DeviceIdentityClient, DeviceIdentityStatus } from "./device-identity.client.js";

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
  /**
   * WARP-979 — the owner-chosen box name (`DROPLET_BOX_NAME`), sent so HQ can
   * issue `<name>.droplet-us.com` instead of the opaque `d-<hmac>` fallback.
   * OPTIONAL: omitted when no name is chosen (opaque-HMAC fallback stays). This
   * is HARMLESS if HQ ignores it today — the HQ device-authed name CLAIM is a
   * COUPLED fleet-hq follow-up. When HQ honors it, the SAME PoP-signed challenge
   * that authorizes the order also authorizes the name claim.
   */
  requested_name?: string;
}

/**
 * ADR-023 PR-3 — DELETE /api/issuance/registration body. The deployed HQ Worker
 * REQUIRES a signed TPM-PoP body to unbind a device (a bodyless DELETE 422s):
 * it re-runs the SAME proof-of-possession check as order/renew (`verifyOrderAuth`)
 * over a fresh single-use challenge nonce. `device_id` travels in BOTH the query
 * string (read by the router) AND this body (read by the handler).
 */
export interface HqDeregisterRequest {
  device_id: string;
  nonce: string;
  /** base64 of the TPM signature over the challenge string. */
  signature: string;
  sig_alg: "ecdsa-sha256";
  key_fingerprint: string;
}

export interface HqDeregisterResponse {
  device_id: string;
  status: "revoked";
}

/**
 * WARP-983 — POST /api/issuance/provision body. A fresh / factory-reset box
 * self-enrolls into the HQ registry BEFORE it can ask for a cert: factory-reset
 * signed the ADR-023 deregister (which DELETED the device from the registry), so
 * on the next boot the challenge/order flow 404s with `device_id not in
 * registry`. This re-registers the box with a one-time HQ-minted token + a TPM
 * proof-of-possession over that token, using the SAME device key + signature
 * encoding the cert order flow uses (base64 DER ECDSA, `ecdsa-sha256`). The
 * signed bytes are pinned by the HQ contract (crypto.ts `buildProvisionMessage`)
 * to exactly `droplet-provision:v1:<token>:<device_id>:<key_fingerprint>` — a
 * distinct domain prefix from the cert PoP so neither signature can be replayed
 * as the other. Field names are snake_case on the wire (mirrors HQ types.ts).
 */
export interface HqProvisionRequest {
  device_id: string;
  /** The device identity's SubjectPublicKeyInfo PEM (extracted from the cert). */
  public_key_pem: string;
  key_fingerprint: string;
  /** The one-time HQ-minted provisioning token (`DROPLET_PROVISION_TOKEN`). */
  token: string;
  /** base64 DER ECDSA over `buildProvisionMessage(token, device_id, fingerprint)`. */
  signature: string;
  sig_alg: "ecdsa-sha256";
}

export interface HqProvisionResponse {
  device_id: string;
  status: "registered";
  idempotent: boolean;
}

/**
 * WARP-980 — POST /api/issuance/claim-name body. The owner renaming the box in
 * setup RE-CLAIMS a name via device-auth proof-of-possession (NO token). This is
 * the AUTHORITATIVE step that makes HQ honor `<name>.droplet-us.com`: the box
 * proves possession of its trusted device key over a fresh single-use nonce, and
 * HQ binds the (slugged) name to this device in the fleet registry. `name` is
 * the RAW owner-entered name — HQ slugs it (the box already validated the shape,
 * but HQ owns the canonical registry slug). Field names are snake_case on the
 * wire (mirrors the HQ worker's types).
 */
export interface HqClaimNameRequest {
  device_id: string;
  /** The RAW owner-entered name (HQ slugs it). Signed VERBATIM in the PoP. */
  name: string;
  nonce: string;
  /** base64 DER ECDSA over `buildClaimNameMessage(...)`. */
  signature: string;
  sig_alg: "ecdsa-sha256";
  key_fingerprint: string;
}

export interface HqClaimNameResponse {
  device_id: string;
  /** The canonical slug HQ bound (may differ from the raw name sent). */
  name: string;
  fqdn: string;
  /** `claimed` = newly bound to this device; `owned` = this device already held it. */
  status: "claimed" | "owned";
}

/**
 * WARP-980 — POST /api/issuance/release body. A factory-reset RELEASES the name
 * (frees it for re-use) and revokes the cert, but KEEPS the device registered +
 * trusted (self-heals — the durable TPM key stays authoritative, so the next
 * rename re-claims via PoP with no token). This replaces the full deregister as
 * the DEFAULT reset path. `device_id` travels in the QUERY STRING (read by the
 * router), NOT this body — the body is the PoP-only proof. Signed bytes are
 * pinned to `droplet-release:v1:<nonce>:<device_id>:<key_fingerprint>` — a
 * distinct domain prefix from cert/claim/provision so no signature can be
 * replayed across the four flows.
 */
export interface HqReleaseRequest {
  nonce: string;
  /** base64 DER ECDSA over `buildReleaseMessage(...)`. */
  signature: string;
  sig_alg: "ecdsa-sha256";
  key_fingerprint: string;
}

export interface HqReleaseResponse {
  device_id: string;
  status: "released";
}

/** The provisioning PoP message HQ verifies (crypto.ts `buildProvisionMessage`).
 *  MUST match the HQ Worker byte-for-byte: a distinct `droplet-provision:v1:`
 *  domain prefix from the cert challenge's `droplet-cert:v1:`. */
export function buildProvisionMessage(
  token: string,
  deviceId: string,
  keyFingerprint: string,
): string {
  return `droplet-provision:v1:${token}:${deviceId}:${keyFingerprint}`;
}

/** The name-claim PoP message HQ verifies (WARP-980). MUST match the HQ worker
 *  byte-for-byte: `droplet-claim:v1:<nonce>:<name>:<device_id>:<key_fingerprint>`,
 *  where `<name>` is the RAW owner-entered name (HQ slugs it). A distinct
 *  `droplet-claim:v1:` domain prefix from cert/provision/release so signatures
 *  can never be replayed across flows. */
export function buildClaimNameMessage(
  nonce: string,
  name: string,
  deviceId: string,
  keyFingerprint: string,
): string {
  return `droplet-claim:v1:${nonce}:${name}:${deviceId}:${keyFingerprint}`;
}

/** The release PoP message HQ verifies (WARP-980). MUST match the HQ worker
 *  byte-for-byte: `droplet-release:v1:<nonce>:<device_id>:<key_fingerprint>`. A
 *  distinct `droplet-release:v1:` domain prefix from cert/provision/claim. */
export function buildReleaseMessage(
  nonce: string,
  deviceId: string,
  keyFingerprint: string,
): string {
  return `droplet-release:v1:${nonce}:${deviceId}:${keyFingerprint}`;
}

/**
 * Plain outbound HTTPS to the HQ fleet-server. The base URL comes from
 * `HQ_ISSUANCE_URL`; this client owns the contract's endpoints.
 */
export interface HqIssuanceClient {
  challenge(deviceId: string): Promise<HqChallengeResponse>;
  order(req: HqOrderRequest): Promise<HqOrderResponse>;
  poll(orderId: string, deviceId: string): Promise<HqPollResponse>;
  renew(req: HqOrderRequest): Promise<HqOrderResponse>;
  /** ADR-023 PR-3 — signed FULL unbind on factory reset (deletes the device).
   *  WARP-980: this is now the `--decommission`-only path; the DEFAULT reset
   *  path uses `release` (frees the name, keeps the device registered). */
  deregister(req: HqDeregisterRequest): Promise<HqDeregisterResponse>;
  /** WARP-983 — box self-enrolls into the HQ registry with a one-time token. */
  provision(req: HqProvisionRequest): Promise<HqProvisionResponse>;
  /** WARP-980 — device-auth PoP name claim (rename → authoritative name). */
  claimName(req: HqClaimNameRequest): Promise<HqClaimNameResponse>;
  /** WARP-980 — device-auth PoP release (factory-reset frees the NAME but keeps
   *  the device registered/trusted). `deviceId` rides in the QUERY string. */
  release(deviceId: string, req: HqReleaseRequest): Promise<HqReleaseResponse>;
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

/**
 * Split-horizon DNS registrar (ADR-023 C3). Registers the learned per-device
 * FQDN → the WireGuard-gateway IP with the routing service's dnsmasq on every
 * successful install, so the one publicly-trusted name resolves to the box on
 * the LAN AND over the tunnel. Best-effort: a failure here NEVER aborts
 * issuance (the cert is already installed and serving).
 */
export interface DnsRegistrar {
  register(hostname: string): Promise<void>;
}

export interface TlsIssuanceDeps {
  /** The opaque per-device FQDN `d-<hmac>.devices.warp-lab.ai`. Empty before
   *  first HQ contact — the box LEARNS it from the HQ challenge response and
   *  (zero-touch) issues a cert + persists the name back to .env. */
  fqdn: string;
  deviceId: string;
  hq: HqIssuanceClient;
  identity: Pick<
    DeviceIdentityClient,
    "signWithDeviceKey" | "getDeviceIdentityStatus" | "getDeviceCert"
  >;
  store: TlsCertStore;
  files: TlsFileOps;
  /** Trigger the host-side `nginx -s reload` (scripts/lib/tls-reload.sh). */
  reloadNginx(): Promise<void>;
  logger: TlsLogger;
  /**
   * ADR-023 PR-1 (Gap 1) — whether the box is wired to a live HQ issuance API
   * (`!!config.HQ_ISSUANCE_URL`). Gates the ZERO-TOUCH bootstrap path: with an
   * empty `fqdn`, runOnce only reaches HQ to LEARN its name when HQ is
   * configured (and the device is provisioned). Optional + defaults false so
   * dev/CI (and the injected-fakes test harness) keep the pre-existing no-op
   * posture without setting it.
   */
  hqConfigured?: boolean;
  /**
   * ADR-023 PR-1 (Gap 1) — persist a freshly-LEARNED fqdn back to `.env`
   * (`DROPLET_PUBLIC_FQDN`) so the next boot reads it directly. Called only
   * when the learned name differs from the configured seed. Fire-and-forget:
   * the implementation swallows + logs its own errors; this service never lets
   * a write-back failure abort or throw out of a successful issuance.
   */
  persistFqdn?: (fqdn: string) => Promise<void>;
  /**
   * ADR-023 PR-1 (Gap 2) — register the learned fqdn → WG-gateway IP with the
   * routing service's split-horizon dnsmasq after every successful install.
   * Optional + best-effort: a DNS failure NEVER aborts issuance.
   */
  dns?: DnsRegistrar;
  /**
   * WARP-979 — the owner-chosen box name (`config.DROPLET_BOX_NAME`, empty when
   * none chosen). Sent to HQ as `requested_name` on the cert ORDER so HQ issues
   * `<name>.droplet-us.com` rather than the opaque `d-<hmac>` fallback. Optional
   * + harmless if HQ ignores it (the HQ device-authed name claim is a coupled
   * fleet-hq follow-up); the opaque-HMAC fallback stays when it's empty.
   */
  requestedName?: string;
  /**
   * WARP-983 — the one-time HQ-minted provisioning token
   * (`config.DROPLET_PROVISION_TOKEN`, empty when self-provision is disabled).
   * When a fresh / factory-reset box hits the HQ challenge/order flow and HQ
   * rejects it with 404 `device_id not in registry` (a signed deregister freed
   * the row on the previous reset), a NON-EMPTY token lets the box re-enroll
   * itself via `hq.provision()` and RETRY the issuance ONCE. Empty (the default)
   * disables self-provision — the box keeps serving its bootstrap self-signed
   * cert and warns, exactly like the "HQ unreachable" path (fail-safe). Optional
   * + defaults empty so dev/CI + the injected-fakes test harness keep the
   * pre-existing posture without setting it.
   */
  provisionToken?: string;
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

// --- Shared challenge + sign (PoP) -----------------------------------------

/** The collaborators `signChallenge` needs. A subset of `TlsIssuanceDeps` so
 *  both the order/renew flow AND the standalone deregister CLI can reuse it. */
export interface SignChallengeDeps {
  deviceId: string;
  hq: Pick<HqIssuanceClient, "challenge">;
  identity: Pick<
    DeviceIdentityClient,
    "signWithDeviceKey" | "getDeviceIdentityStatus"
  >;
}

/** The proof-of-possession material HQ checks on order / renew / deregister:
 *  a single-use `nonce`, the base64 `signature` over the contract string, the
 *  `sig_alg`, and the device `key_fingerprint`. `fqdn` + `public_label` are the
 *  learned identity from the SAME challenge response (callers issuing a cert
 *  reuse them; deregister ignores them). */
export interface SignedChallenge {
  nonce: string;
  signature: string;
  sig_alg: "ecdsa-sha256";
  key_fingerprint: string;
  fqdn: string;
  public_label: string;
}

/**
 * Fetch a FRESH HQ challenge and sign it with the device TPM key. The signed
 * bytes are pinned by the issuance contract to exactly:
 *
 *   `droplet-cert:v1:<nonce>:<key_fingerprint>:<public_label>`
 *
 * (verified byte-for-byte against the HQ Worker's `buildSignedMessage`). HQ
 * nonces are single-use, so this ALWAYS hits `hq.challenge` — never a cached
 * nonce. Extracted from issueOrRenew so the factory-reset deregister proves
 * possession the same way the order flow does (the comment in factory-reset.sh
 * that claimed the box "can't compute the PoP" was wrong — it can, via this).
 */
export async function signChallenge(
  deps: SignChallengeDeps,
): Promise<SignedChallenge> {
  const { deviceId, hq, identity } = deps;
  const ch = await hq.challenge(deviceId);
  const fingerprint = (await identity.getDeviceIdentityStatus()).certFingerprint;
  const challengeStr = `${CHALLENGE_PREFIX}${ch.nonce}:${fingerprint}:${ch.public_label}`;
  const sig = await identity.signWithDeviceKey(
    new TextEncoder().encode(challengeStr),
  );
  return {
    nonce: ch.nonce,
    signature: Buffer.from(sig.signature).toString("base64"),
    sig_alg: "ecdsa-sha256",
    key_fingerprint: fingerprint,
    fqdn: ch.fqdn,
    public_label: ch.public_label,
  };
}

// --- Self-provision (WARP-983) ---------------------------------------------

/**
 * Extract the SubjectPublicKeyInfo PEM from the device-identity cert. HQ's
 * `provision` verifies the token PoP against `public_key_pem`, so the box needs
 * to present its identity PUBLIC key — but the device-identity sidecar only
 * exposes the cert (`getDeviceCert`), NOT a bare public key (there is no
 * public-key RPC in device_identity.proto). node-forge parses the cert and
 * re-emits its embedded SPKI as a `PUBLIC KEY` PEM. Key-type-agnostic: it lifts
 * whatever key the cert carries (EC P-256 in production; RSA in tests).
 */
export function extractPublicKeyPem(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  return forge.pki.publicKeyToPem(cert.publicKey);
}

/** The exact HQ 404 that a factory-reset box hits when its registration was
 *  freed by the signed deregister. `hqFetch` throws
 *  `HQ <path> returned <status>: <body>`; the deployed Worker's challenge
 *  handler responds 404 with body `{"error":"device_id not in registry"}`
 *  (handlers.ts::challenge). Match BOTH the 404 status and the not-in-registry
 *  marker so a different 404 (or a 503/500) never triggers a re-enroll. */
export function isNotInRegistryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.startsWith("HQ ") &&
    m.includes(" returned 404") &&
    m.includes("not in registry")
  );
}

/** The collaborators `provisionWithHq` needs — a subset of `TlsIssuanceDeps`. */
export interface ProvisionDeps {
  deviceId: string;
  hq: Pick<HqIssuanceClient, "provision">;
  identity: Pick<
    DeviceIdentityClient,
    "signWithDeviceKey" | "getDeviceIdentityStatus" | "getDeviceCert"
  >;
  provisionToken: string;
}

/**
 * Self-enroll this box into the HQ registry with the one-time provisioning
 * token. Builds the SAME PoP the cert flow uses (base64 DER ECDSA over a pinned
 * message, `ecdsa-sha256`) — only the message differs (`droplet-provision:v1:…`
 * vs `droplet-cert:v1:…`, a distinct domain prefix so signatures can't be
 * replayed across the two). The `public_key_pem` is the SPKI extracted from the
 * device-identity cert. Returns HQ's response; throws on any HQ error (the
 * caller keeps the bootstrap cert on failure — fail-safe, no crash).
 */
export async function provisionWithHq(
  deps: ProvisionDeps,
): Promise<HqProvisionResponse> {
  const { deviceId, hq, identity, provisionToken } = deps;
  const fingerprint = (await identity.getDeviceIdentityStatus()).certFingerprint;
  const publicKeyPem = extractPublicKeyPem(await identity.getDeviceCert());
  const message = buildProvisionMessage(provisionToken, deviceId, fingerprint);
  const sig = await identity.signWithDeviceKey(
    new TextEncoder().encode(message),
  );
  const req: HqProvisionRequest = {
    device_id: deviceId,
    public_key_pem: publicKeyPem,
    key_fingerprint: fingerprint,
    token: provisionToken,
    // Same encoding as the cert order signature (signChallenge above).
    signature: Buffer.from(sig.signature).toString("base64"),
    sig_alg: "ecdsa-sha256",
  };
  return hq.provision(req);
}

// --- Factory-reset HQ deregistration (ADR-023 PR-3) ------------------------

/** Outcome sentinels for `deregisterFromHq`. It NEVER throws (factory-reset
 *  must always complete), so callers/tests branch on these instead. */
export const DEREGISTER_RESULT_OK = "ok" as const;
export const DEREGISTER_RESULT_SKIPPED = "skipped" as const;
export const DEREGISTER_RESULT_FAILED = "failed" as const;
export type DeregisterResult =
  | typeof DEREGISTER_RESULT_OK
  | typeof DEREGISTER_RESULT_SKIPPED
  | typeof DEREGISTER_RESULT_FAILED;

export interface DeregisterDeps {
  deviceId: string;
  hq: Pick<HqIssuanceClient, "challenge" | "deregister">;
  identity: Pick<
    DeviceIdentityClient,
    "signWithDeviceKey" | "getDeviceIdentityStatus"
  >;
  logger: TlsLogger;
}

/**
 * Signed unbind of this box from HQ, run during factory-reset (Phase 0b, while
 * the stack is still UP). Signs a fresh challenge (proving possession of the
 * device TPM key) and DELETEs the HQ registration with the full PoP body, so HQ
 * frees the device row and revokes the cert.
 *
 * NON-FATAL by contract: a reset MUST complete even if HQ or the device-identity
 * sidecar is unreachable. Every failure path returns a sentinel and logs a
 * warning — this function never throws. (HQ also reaps stale registrations
 * server-side, so a missed deregister is recoverable.)
 *
 *   - device not provisioned (no key to sign with)         → SKIPPED
 *   - challenge / sign / DELETE failed                     → FAILED
 *   - HQ acknowledged the unbind                           → OK
 */
export async function deregisterFromHq(
  deps: DeregisterDeps,
): Promise<DeregisterResult> {
  const { deviceId, hq, identity, logger } = deps;
  try {
    // Don't even reach HQ if there's no provisioned identity — the sidecar can
    // be down at reset time and we have no key to sign the PoP with.
    const status = await identity.getDeviceIdentityStatus();
    if (!status.provisioned) {
      logger.info(
        { deviceId },
        "tls-deregister: device identity not provisioned — skipping HQ deregistration (nothing to unbind)",
      );
      return DEREGISTER_RESULT_SKIPPED;
    }

    const signed = await signChallenge({ deviceId, hq, identity });
    const req: HqDeregisterRequest = {
      device_id: deviceId,
      nonce: signed.nonce,
      signature: signed.signature,
      sig_alg: signed.sig_alg,
      key_fingerprint: signed.key_fingerprint,
    };
    const res = await hq.deregister(req);
    logger.info(
      { deviceId, status: res.status },
      "tls-deregister: HQ acknowledged deregistration (device row freed, cert revoked)",
    );
    return DEREGISTER_RESULT_OK;
  } catch (err) {
    logger.warn(
      { err, deviceId },
      "tls-deregister: HQ deregistration failed — non-fatal, factory-reset continues (HQ reaps stale registrations server-side)",
    );
    return DEREGISTER_RESULT_FAILED;
  }
}

// --- Device-auth name claim (WARP-980) -------------------------------------

/** Parse the HTTP status embedded in an `hqFetch` error message. hqFetch throws
 *  `HQ <path> returned <status>: <body>`; return the numeric status, or null for
 *  anything that isn't a recognizable HQ HTTP error (a network error, a bug). */
export function parseHqStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const m = /^HQ .* returned (\d{3})/.exec(err.message);
  return m ? Number(m[1]) : null;
}

/** Best-effort extraction of the `suggestions` array HQ returns in a 409
 *  name-taken body (`… returned 409: {"error":"…","suggestions":[…]}`). Returns
 *  [] when the body isn't JSON, has no suggestions, or isn't a string array — a
 *  claim outcome must never crash on a malformed HQ body. */
export function parseTakenSuggestions(err: unknown): string[] {
  if (!(err instanceof Error)) return [];
  const jsonStart = err.message.indexOf("{");
  if (jsonStart < 0) return [];
  try {
    const body = JSON.parse(err.message.slice(jsonStart)) as {
      suggestions?: unknown;
    };
    if (
      Array.isArray(body.suggestions) &&
      body.suggestions.every((s) => typeof s === "string")
    ) {
      return body.suggestions as string[];
    }
  } catch {
    // Non-JSON / truncated body — no suggestions to surface.
  }
  return [];
}

/** Typed outcomes of a name claim. `claimBoxName` NEVER throws (it must not
 *  crash issuance / the rename endpoint), so callers branch on these. */
export const CLAIM_RESULT_CLAIMED = "claimed" as const;
export const CLAIM_RESULT_NAME_TAKEN = "name_taken" as const;
export const CLAIM_RESULT_NOT_REGISTERED = "not_registered" as const;
export const CLAIM_RESULT_INVALID = "invalid" as const;
export const CLAIM_RESULT_FAILED = "failed" as const;
export type ClaimOutcome =
  | typeof CLAIM_RESULT_CLAIMED
  | typeof CLAIM_RESULT_NAME_TAKEN
  | typeof CLAIM_RESULT_NOT_REGISTERED
  | typeof CLAIM_RESULT_INVALID
  | typeof CLAIM_RESULT_FAILED;

/** The result of a name claim. `authoritative` is TRUE only when HQ actually
 *  answered (claimed/owned = the name IS ours; name_taken = HQ authoritatively
 *  says it's taken). It's FALSE when we fell back without HQ confirming
 *  (not_registered / a transient failure), so the wizard can be honest. */
export interface ClaimBoxNameResult {
  outcome: ClaimOutcome;
  authoritative: boolean;
  /** HQ's canonical slug + fqdn on success; undefined on failure. */
  slug?: string;
  fqdn?: string;
  /** Alternate names HQ offered on a 409 name-taken. */
  suggestions?: string[];
}

export interface ClaimBoxNameDeps {
  deviceId: string;
  hq: Pick<HqIssuanceClient, "challenge" | "claimName">;
  identity: Pick<
    DeviceIdentityClient,
    "signWithDeviceKey" | "getDeviceIdentityStatus"
  >;
  logger: TlsLogger;
}

/**
 * WARP-980 — claim a box name via device-auth proof-of-possession. Given the RAW
 * owner-entered name, this: fetches a FRESH HQ challenge → signs
 * `droplet-claim:v1:<nonce>:<name>:<device_id>:<key_fingerprint>` with the device
 * TPM key (the SAME signing path the cert order flow uses) → POSTs claim-name.
 * This is the AUTHORITATIVE step that makes HQ honor `<name>.droplet-us.com`; the
 * subsequent issuance path issues UNDER that claimed name.
 *
 * FAIL-SAFE by contract: it NEVER throws (a claim must not crash the rename
 * endpoint or issuance) — every path returns a typed outcome:
 *   - device not provisioned (no key to sign) → NOT_REGISTERED (fallback)
 *   - HQ 200 (claimed/owned)                  → CLAIMED (authoritative)
 *   - HQ 409 (name taken / holds another)     → NAME_TAKEN (authoritative) + suggestions
 *   - HQ 403 (not registered / fp mismatch)   → NOT_REGISTERED (graceful fallback)
 *   - HQ 422 (invalid / reserved)             → INVALID
 *   - HQ 401 (bad/expired nonce or sig) / net → FAILED (retryable)
 */
export async function claimBoxName(
  rawName: string,
  deps: ClaimBoxNameDeps,
): Promise<ClaimBoxNameResult> {
  const { deviceId, hq, identity, logger } = deps;
  try {
    // No provisioned identity → no trusted key to sign the PoP with. The device
    // isn't claimable yet (e.g. a fresh box before first-factory enroll) — fall
    // back gracefully (bootstrap/opaque issuance) with a clear log.
    const status = await identity.getDeviceIdentityStatus();
    if (!status.provisioned) {
      logger.warn(
        { deviceId, name: rawName },
        "tls-claim: device identity not provisioned — cannot device-auth claim the name yet; falling back to opaque/bootstrap issuance",
      );
      return { outcome: CLAIM_RESULT_NOT_REGISTERED, authoritative: false };
    }

    // Fresh single-use challenge; sign the claim PoP (RAW name, HQ slugs it).
    const ch = await hq.challenge(deviceId);
    const fingerprint = status.certFingerprint;
    const message = buildClaimNameMessage(ch.nonce, rawName, deviceId, fingerprint);
    const sig = await identity.signWithDeviceKey(
      new TextEncoder().encode(message),
    );
    const req: HqClaimNameRequest = {
      device_id: deviceId,
      name: rawName,
      nonce: ch.nonce,
      signature: Buffer.from(sig.signature).toString("base64"),
      sig_alg: "ecdsa-sha256",
      key_fingerprint: fingerprint,
    };
    const res = await hq.claimName(req);
    logger.info(
      { deviceId, name: res.name, fqdn: res.fqdn, status: res.status },
      "tls-claim: HQ bound the name to this device (authoritative)",
    );
    return {
      outcome: CLAIM_RESULT_CLAIMED,
      authoritative: true,
      slug: res.name,
      fqdn: res.fqdn,
    };
  } catch (err) {
    const httpStatus = parseHqStatus(err);
    if (httpStatus === 409) {
      // Name taken (or the device holds a DIFFERENT name). Authoritative: HQ
      // owns the registry. Surface any suggestions so the wizard shows the truth.
      const suggestions = parseTakenSuggestions(err);
      logger.warn(
        { deviceId, name: rawName, suggestions },
        "tls-claim: HQ rejected the name as taken (409) — surfacing suggestions",
      );
      return {
        outcome: CLAIM_RESULT_NAME_TAKEN,
        authoritative: true,
        suggestions,
      };
    }
    if (httpStatus === 403) {
      // Not registered / fingerprint mismatch — the device isn't trusted for
      // this claim. Fall back gracefully (opaque/bootstrap issuance).
      logger.warn(
        { deviceId, name: rawName },
        "tls-claim: HQ says this device is not registered / fingerprint mismatch (403) — falling back to opaque/bootstrap issuance",
      );
      return { outcome: CLAIM_RESULT_NOT_REGISTERED, authoritative: false };
    }
    if (httpStatus === 422) {
      logger.warn(
        { deviceId, name: rawName },
        "tls-claim: HQ rejected the name as invalid/reserved (422)",
      );
      return { outcome: CLAIM_RESULT_INVALID, authoritative: true };
    }
    // 401 (bad/expired nonce or sig), a network error, or anything else — a
    // retryable failure. Non-fatal: the box keeps serving, the next issuance
    // tick re-attempts, and the persisted name is unaffected.
    logger.warn(
      { err, deviceId, name: rawName },
      "tls-claim: name claim failed (non-fatal) — keeping the current cert; the name will be re-claimed on the next issuance tick",
    );
    return { outcome: CLAIM_RESULT_FAILED, authoritative: false };
  }
}

// --- Factory-reset HQ release (WARP-980) -----------------------------------

/** Outcome sentinels for `releaseFromHq`. Mirrors the deregister sentinels: it
 *  NEVER throws (a reset must always complete). */
export const RELEASE_RESULT_OK = "ok" as const;
export const RELEASE_RESULT_SKIPPED = "skipped" as const;
export const RELEASE_RESULT_FAILED = "failed" as const;
export type ReleaseResult =
  | typeof RELEASE_RESULT_OK
  | typeof RELEASE_RESULT_SKIPPED
  | typeof RELEASE_RESULT_FAILED;

export interface ReleaseDeps {
  deviceId: string;
  hq: Pick<HqIssuanceClient, "challenge" | "release">;
  identity: Pick<
    DeviceIdentityClient,
    "signWithDeviceKey" | "getDeviceIdentityStatus"
  >;
  logger: TlsLogger;
}

/**
 * WARP-980 — the DEFAULT factory-reset HQ path: RELEASE (not full deregister).
 * Signs a fresh challenge (proving possession of the durable device TPM key) and
 * POSTs /api/issuance/release with `device_id` in the QUERY string + the PoP body
 * (`droplet-release:v1:…`). HQ frees the NAME and revokes the cert but KEEPS the
 * device REGISTERED + trusted, so the box self-heals: the next rename re-claims a
 * name via device-auth PoP (no token). This AMENDS ADR-023 reset behavior —
 * reset ≠ deregister.
 *
 * NON-FATAL by contract (mirrors deregisterFromHq): every failure returns a
 * sentinel and logs a warning; this function never throws.
 *   - device not provisioned (no key to sign) → SKIPPED
 *   - challenge / sign / POST failed          → FAILED
 *   - HQ acknowledged the release             → OK
 */
export async function releaseFromHq(deps: ReleaseDeps): Promise<ReleaseResult> {
  const { deviceId, hq, identity, logger } = deps;
  try {
    const status = await identity.getDeviceIdentityStatus();
    if (!status.provisioned) {
      logger.info(
        { deviceId },
        "tls-release: device identity not provisioned — skipping HQ release (nothing to release)",
      );
      return RELEASE_RESULT_SKIPPED;
    }

    const signed = await signReleaseChallenge({ deviceId, hq, identity });
    const req: HqReleaseRequest = {
      nonce: signed.nonce,
      signature: signed.signature,
      sig_alg: signed.sig_alg,
      key_fingerprint: signed.key_fingerprint,
    };
    const res = await hq.release(deviceId, req);
    logger.info(
      { deviceId, status: res.status },
      "tls-release: HQ acknowledged release (name freed, cert revoked, device STAYS registered)",
    );
    return RELEASE_RESULT_OK;
  } catch (err) {
    logger.warn(
      { err, deviceId },
      "tls-release: HQ release failed — non-fatal, factory-reset continues (device stays registered; HQ reaps stale names server-side)",
    );
    return RELEASE_RESULT_FAILED;
  }
}

/** Fetch a fresh HQ challenge and sign the RELEASE PoP message. Mirrors
 *  `signChallenge` but signs the `droplet-release:v1:` domain (release carries no
 *  fqdn/public_label — only the nonce + device id + fingerprint). */
async function signReleaseChallenge(deps: {
  deviceId: string;
  hq: Pick<HqIssuanceClient, "challenge">;
  identity: Pick<
    DeviceIdentityClient,
    "signWithDeviceKey" | "getDeviceIdentityStatus"
  >;
}): Promise<{
  nonce: string;
  signature: string;
  sig_alg: "ecdsa-sha256";
  key_fingerprint: string;
}> {
  const { deviceId, hq, identity } = deps;
  const ch = await hq.challenge(deviceId);
  const fingerprint = (await identity.getDeviceIdentityStatus()).certFingerprint;
  const message = buildReleaseMessage(ch.nonce, deviceId, fingerprint);
  const sig = await identity.signWithDeviceKey(
    new TextEncoder().encode(message),
  );
  return {
    nonce: ch.nonce,
    signature: Buffer.from(sig.signature).toString("base64"),
    sig_alg: "ecdsa-sha256",
    key_fingerprint: fingerprint,
  };
}

export function createTlsIssuanceService(
  deps: TlsIssuanceDeps,
): TlsIssuanceService {
  const {
    fqdn,
    deviceId,
    hq,
    identity,
    store,
    files,
    reloadNginx,
    logger,
    hqConfigured = false,
    persistFqdn,
    dns,
    requestedName,
    provisionToken = "",
  } = deps;

  // WARP-983 — self-provision is enabled only when a non-empty token is
  // configured. Guard/trim like the other config-sourced strings so a
  // whitespace-only hand-edit in .env can never masquerade as a real token.
  const trimmedProvisionToken = provisionToken.trim();
  const selfProvisionEnabled = trimmedProvisionToken.length > 0;

  // Defense-in-depth (WARP-979 review follow-up): DROPLET_BOX_NAME is normally
  // written only by the validated persist path, but the box treats its own .env
  // as untrusted — a hand-edited value (" ", "UpperCase", an over-long label)
  // must never reach HQ as a raw `requested_name`. Re-validate once here through
  // the SAME shared ruleset; an invalid value falls back to the opaque
  // `d-<hmac>` issuance instead of the box emitting a malformed name.
  const requestedCheck = requestedName ? validateBoxName(requestedName) : undefined;
  const requestedSlug = requestedCheck?.ok ? requestedCheck.slug : undefined;
  if (requestedName && !requestedCheck?.ok) {
    logger.warn(
      { reason: requestedCheck?.reason },
      "tls-issuance: DROPLET_BOX_NAME is set but not a valid box name — omitting requested_name, falling back to opaque issuance",
    );
  }

  /**
   * The full issuance/renewal flow. Returns the LEARNED fqdn (from the HQ
   * challenge response) + the new not_after on success. The learned fqdn is the
   * authoritative name: a zero-touch box starts with an empty seed and only
   * learns its opaque name here, so callers MUST key the cert-state row on the
   * RETURNED fqdn, never on the (possibly-empty) `deps.fqdn`.
   */
  async function issueOrRenew(
    mode: "issue" | "renew",
  ): Promise<{ fqdn: string; notAfter: string }> {
    // 1-2. Fetch a fresh challenge + sign the exact contract string with the
    //      device TPM key (shared with the factory-reset deregister path).
    const signed = await signChallenge({ deviceId, hq, identity });

    // 3. Generate keypair + CSR locally (private key never transmitted). The
    //    learned FQDN comes from the SAME challenge response.
    const { csrPem, keyPem } = generateKeyPairAndCsr(signed.fqdn);

    const orderReq: HqOrderRequest = {
      device_id: deviceId,
      csr_pem: csrPem,
      nonce: signed.nonce,
      signature: signed.signature,
      sig_alg: signed.sig_alg,
      key_fingerprint: signed.key_fingerprint,
      // WARP-979 — carry the owner-chosen box name so HQ can issue
      // `<name>.droplet-us.com`. Only when a VALID name is configured (see the
      // requestedSlug guard above); otherwise HQ keeps minting the opaque
      // `d-<hmac>` fallback. Harmless if HQ ignores the field today (coupled
      // fleet-hq device-auth follow-up, WARP-980).
      ...(requestedSlug ? { requested_name: requestedSlug } : {}),
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

    // 8. ADR-023 (C3) — register the learned FQDN with the split-horizon
    //    dnsmasq (routing/container leg) AFTER the reload, so the publicly-
    //    trusted name resolves to the box on the LAN AND over the tunnel.
    //    Best-effort: a DNS failure must NEVER abort issuance — the cert is
    //    already installed and serving. (The host dnsmasq leg is handled
    //    separately by droplet-set-public-fqdn.sh → setup_public_fqdn_dns.)
    if (dns) {
      try {
        await dns.register(signed.fqdn);
      } catch (err) {
        logger.warn(
          { err, fqdn: signed.fqdn },
          "tls-issuance: split-horizon DNS registration failed — cert installed, name resolves on next setup run",
        );
      }
    }

    return { fqdn: signed.fqdn, notAfter: result.not_after };
  }

  /**
   * WARP-983 — run the issuance/renewal flow, and if HQ rejects the very first
   * challenge with 404 `device_id not in registry` (a factory-reset deregister
   * freed this box's registry row), SELF-ENROLL once with the provisioning token
   * and RETRY exactly ONCE. The retry is bounded to a single attempt: if it 404s
   * again (e.g. provision succeeded server-side but the registry still can't be
   * read, or a bogus provision), the error propagates to the normal catch and
   * the box keeps its bootstrap cert (LE_RENEW_FAILED) — the next daily tick
   * re-attempts from scratch. Only reached when a non-empty token is configured;
   * otherwise `issueOrRenew` runs exactly as before (the 404 is caught upstream
   * as a transient HQ failure).
   */
  async function issueOrRenewWithSelfProvision(
    mode: "issue" | "renew",
  ): Promise<{ fqdn: string; notAfter: string }> {
    try {
      return await issueOrRenew(mode);
    } catch (err) {
      if (!selfProvisionEnabled || !isNotInRegistryError(err)) throw err;
      logger.warn(
        { deviceId },
        "tls-issuance: HQ reports this device is not in the registry (a factory-reset deregister freed the row) — self-provisioning with the configured token, then retrying issuance once",
      );
      // Re-enroll. A provision failure (invalid/expired/consumed token, 4xx)
      // throws out here → the outer catch keeps the bootstrap cert (fail-safe).
      const res = await provisionWithHq({
        deviceId,
        hq,
        identity,
        provisionToken: trimmedProvisionToken,
      });
      logger.info(
        { deviceId, idempotent: res.idempotent },
        "tls-issuance: HQ re-registered this device — retrying certificate issuance",
      );
      // Single retry. A second not-in-registry here is NOT re-provisioned.
      return issueOrRenew(mode);
    }
  }

  /**
   * ADR-023 PR-1 (Gap 1) — fire-and-forget write-back of a freshly-LEARNED
   * fqdn to .env. Only fires when the learned name differs from the configured
   * seed (`deps.fqdn`). The persister swallows + logs its own errors; we add a
   * belt-and-braces catch here so a rejected promise can NEVER bubble out of a
   * successful issuance or churn the cron canary.
   */
  async function maybePersistLearnedFqdn(learned: string): Promise<void> {
    if (!persistFqdn || !learned || learned === fqdn) return;
    try {
      await persistFqdn(learned);
    } catch (err) {
      logger.warn(
        { err, fqdn: learned },
        "tls-issuance: persisting learned DROPLET_PUBLIC_FQDN failed (non-fatal — write-back retries next tick)",
      );
    }
  }

  return {
    async runOnce() {
      // The cert-state row is keyed on the fqdn (`TlsCert.fqdn @id`). A
      // zero-touch box starts with an empty seed and only LEARNS its opaque
      // name from the HQ challenge, so `seed` may be empty here. The row + the
      // .env write-back are keyed on the LEARNED name returned by issueOrRenew,
      // never on the empty seed.
      const seed = fqdn;

      let state: TlsCertStateValue;
      let existingNotAfter: string | null;
      let mode: "issue" | "renew" | "noop";

      if (!seed) {
        // ZERO-TOUCH bootstrap (Gap 1). No fqdn yet AND no state row to read
        // (there can't be one — the row keys on the not-yet-known fqdn). Only
        // reach HQ to learn the name when this box is actually wired for live
        // issuance (HQ configured) AND its device identity is provisioned. On a
        // dev laptop / CI / un-provisioned box, keep the pre-existing no-op +
        // info-log posture (serving the bootstrap self-signed cert).
        if (!hqConfigured) {
          logger.info(
            {},
            "tls-issuance: no DROPLET_PUBLIC_FQDN configured yet and HQ issuance disabled — skipping (serving bootstrap self-signed cert)",
          );
          return;
        }
        let idStatus: DeviceIdentityStatus;
        try {
          idStatus = await identity.getDeviceIdentityStatus();
        } catch (err) {
          if (isTransientNetworkError(err)) {
            logger.info(
              {},
              "tls-issuance: device-identity sidecar unreachable on zero-touch provisioning check — will retry on next tick",
            );
            return;
          }
          throw err;
        }
        if (!idStatus.provisioned) {
          logger.info(
            {},
            "tls-issuance: no DROPLET_PUBLIC_FQDN yet and device identity not provisioned — skipping (serving bootstrap self-signed cert)",
          );
          return;
        }
        // Treat an unseeded-but-HQ-ready box as BOOTSTRAP_SELF_SIGNED → issue.
        state = "BOOTSTRAP_SELF_SIGNED";
        existingNotAfter = null;
        mode = "issue";
      } else {
        // Seeded box — the pre-existing state-machine, verbatim. Read the
        // explicit state row; a missing row is treated as BOOTSTRAP_SELF_SIGNED
        // (the box has a self-signed cert from secrets.sh) — NEVER inferred
        // from a null cert.
        const existing = await store.get(seed);
        state = existing?.state ?? "BOOTSTRAP_SELF_SIGNED";
        existingNotAfter = existing?.notAfter ?? null;

        // Decide: issue, renew, or no-op.
        if (state === "BOOTSTRAP_SELF_SIGNED") {
          mode = "issue";
        } else if (
          state === "LE_ISSUED" ||
          state === "LE_RENEW_FAILED" ||
          state === "LE_RENEWING"
        ) {
          if (state === "LE_RENEW_FAILED" && existingNotAfter === null) {
            // First-ever issuance failed (no cert ever issued). Use order(),
            // NOT renew(): /api/issuance/renew requires an existing cert at HQ;
            // calling it without one permanently routes this box to the wrong
            // endpoint with no self-recovery.
            mode = "issue";
          } else {
            // For an issued (or previously-failed / interrupted) cert, renew
            // when we're inside the 30-day window. A LE_RENEW_FAILED row with
            // time left also retries via the renew path.
            mode =
              daysUntil(existingNotAfter) <= RENEW_THRESHOLD_DAYS
                ? "renew"
                : "noop";
          }
        } else {
          mode = "noop";
        }
      }

      if (mode === "noop") {
        logger.info(
          { fqdn: seed, state, notAfter: existingNotAfter },
          "tls-issuance: cert healthy, nothing to do",
        );
        return;
      }

      // Mark in-flight so a concurrent observer sees the renewal underway. Only
      // a seeded box can renew (a zero-touch box always issues), so `seed` is
      // guaranteed non-empty here — never upsert an empty-key row.
      if (mode === "renew" && seed) {
        await store.upsert(seed, "LE_RENEWING", existingNotAfter);
      }

      try {
        const { fqdn: learnedFqdn, notAfter } =
          await issueOrRenewWithSelfProvision(mode);
        // Key the upsert on the LEARNED fqdn. Guard against an empty key so a
        // misbehaving HQ response can never write a TlsCert row keyed on ''.
        if (learnedFqdn) {
          await store.upsert(learnedFqdn, "LE_ISSUED", notAfter);
          if (seed && seed !== learnedFqdn) {
            await store.upsert(seed, "BOOTSTRAP_SELF_SIGNED", null);
          }
        } else {
          logger.warn(
            { mode },
            "tls-issuance: HQ returned an empty fqdn — installed cert but skipping state upsert",
          );
        }
        // Persist a newly-learned name back to .env (fire-and-forget).
        await maybePersistLearnedFqdn(learnedFqdn);
        logger.info(
          { fqdn: learnedFqdn, mode, notAfter },
          "tls-issuance: installed publicly-trusted cert",
        );
      } catch (err) {
        if (
          err instanceof TlsIssuancePendingError ||
          isTransientNetworkError(err)
        ) {
          // Keep serving the current cert; record the failure for the next
          // tick — but ONLY when we have a real key. A zero-touch box that
          // failed before learning its name has an empty seed: do NOT upsert an
          // empty-key row (TlsCert.fqdn @id must never be '') — just warn; the
          // next tick re-attempts the bootstrap from scratch.
          if (seed) {
            await store.upsert(seed, "LE_RENEW_FAILED", existingNotAfter);
          }
          logger.warn(
            { err, fqdn: seed, mode },
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
