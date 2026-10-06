/**
 * Fleet device registration and legacy cleanup for private OTA pulls and
 * telemetry. Public certificate issuance, renewal and box-name claims are
 * retired. These signed contracts retain provisioning and factory reset
 * compatibility with the fleet registry; no remote access is provisioned here.
 */
import { X509Certificate } from "node:crypto";
import { config } from "../config.js";
import type { DeviceIdentityClient } from "./device-identity.client.js";

/** Existing deregistration proof domain required by the deployed registry. */
export const CHALLENGE_PREFIX = "droplet-cert:v1:";

export interface HqChallengeResponse {
  nonce: string;
  expires_at: string;
  public_label: string;
  fqdn: string;
}

export interface HqDeregisterRequest {
  device_id: string;
  nonce: string;

  signature: string;
  sig_alg: "ecdsa-sha256";
  key_fingerprint: string;
}

export interface HqDeregisterResponse {
  device_id: string;
  status: "revoked";
}

export interface HqProvisionRequest {
  device_id: string;

  public_key_pem: string;
  key_fingerprint: string;

  token: string;

  signature: string;
  sig_alg: "ecdsa-sha256";
}

export interface HqProvisionResponse {
  device_id: string;
  status: "registered";
  idempotent: boolean;
}

export interface HqReleaseRequest {
  nonce: string;

  signature: string;
  sig_alg: "ecdsa-sha256";
  key_fingerprint: string;
}

export interface HqReleaseResponse {
  device_id: string;
  status: "released";
}

export function buildProvisionMessage(
  token: string,
  deviceId: string,
  keyFingerprint: string,
): string {
  return `droplet-provision:v1:${token}:${deviceId}:${keyFingerprint}`;
}

export function buildReleaseMessage(
  nonce: string,
  deviceId: string,
  keyFingerprint: string,
): string {
  return `droplet-release:v1:${nonce}:${deviceId}:${keyFingerprint}`;
}

export interface FleetRegistrationClient {
  challenge(deviceId: string): Promise<HqChallengeResponse>;
  deregister(req: HqDeregisterRequest): Promise<HqDeregisterResponse>;
  provision(req: HqProvisionRequest): Promise<HqProvisionResponse>;
  release(deviceId: string, req: HqReleaseRequest): Promise<HqReleaseResponse>;
}

export interface FleetLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface SignChallengeDeps {
  deviceId: string;
  hq: Pick<FleetRegistrationClient, "challenge">;
  identity: Pick<
    DeviceIdentityClient,
    "signWithDeviceKey" | "getDeviceIdentityStatus"
  >;
}

export interface SignedChallenge {
  nonce: string;
  signature: string;
  sig_alg: "ecdsa-sha256";
  key_fingerprint: string;
  fqdn: string;
  public_label: string;
}

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

/** Lift the SPKI from the identity certificate, including TPM EC keys. */
export function extractPublicKeyPem(certPem: string): string {
  return new X509Certificate(certPem).publicKey.export({ type: "spki", format: "pem" }).toString();
}

export interface ProvisionDeps {
  deviceId: string;
  hq: Pick<FleetRegistrationClient, "provision">;
  identity: Pick<
    DeviceIdentityClient,
    "signWithDeviceKey" | "getDeviceIdentityStatus" | "getDeviceCert"
  >;
  provisionToken: string;
}

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
    signature: Buffer.from(sig.signature).toString("base64"),
    sig_alg: "ecdsa-sha256",
  };
  return hq.provision(req);
}

export const DEREGISTER_RESULT_OK = "ok" as const;
export const DEREGISTER_RESULT_SKIPPED = "skipped" as const;
export const DEREGISTER_RESULT_FAILED = "failed" as const;
export type DeregisterResult =
  | typeof DEREGISTER_RESULT_OK
  | typeof DEREGISTER_RESULT_SKIPPED
  | typeof DEREGISTER_RESULT_FAILED;

export interface DeregisterDeps {
  deviceId: string;
  hq: Pick<FleetRegistrationClient, "challenge" | "deregister">;
  identity: Pick<
    DeviceIdentityClient,
    "signWithDeviceKey" | "getDeviceIdentityStatus"
  >;
  logger: FleetLogger;
}

export async function deregisterFromHq(
  deps: DeregisterDeps,
): Promise<DeregisterResult> {
  const { deviceId, hq, identity, logger } = deps;
  try {
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

export const RELEASE_RESULT_OK = "ok" as const;
export const RELEASE_RESULT_SKIPPED = "skipped" as const;
export const RELEASE_RESULT_FAILED = "failed" as const;
export type ReleaseResult =
  | typeof RELEASE_RESULT_OK
  | typeof RELEASE_RESULT_SKIPPED
  | typeof RELEASE_RESULT_FAILED;

export interface ReleaseDeps {
  deviceId: string;
  hq: Pick<FleetRegistrationClient, "challenge" | "release">;
  identity: Pick<
    DeviceIdentityClient,
    "signWithDeviceKey" | "getDeviceIdentityStatus"
  >;
  logger: FleetLogger;
}

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

async function signReleaseChallenge(deps: {
  deviceId: string;
  hq: Pick<FleetRegistrationClient, "challenge">;
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

/** Explicit registry-only HTTP client; it has no cert order/renew/poll or name-claim methods. */
export function createFleetRegistrationClient(): FleetRegistrationClient {
  async function hqFetch<T>(path: string, init: RequestInit): Promise<T> {
    const base = config.HQ_ISSUANCE_URL.replace(/\/+$/, "");
    if (!base) throw new Error("HQ_ISSUANCE_URL not configured");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
        signal: ctrl.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HQ ${path} returned ${response.status}: ${body.slice(0, 200)}`);
      }
      return await response.json() as T;
    } finally { clearTimeout(timer); }
  }
  return {
    challenge(deviceId) {
      return hqFetch<HqChallengeResponse>("/api/issuance/order/challenge", {
        method: "POST", body: JSON.stringify({ device_id: deviceId }),
      });
    },
    provision(req) {
      return hqFetch<HqProvisionResponse>("/api/issuance/provision", {
        method: "POST", body: JSON.stringify(req),
      });
    },
    deregister(req) {
      const qs = new URLSearchParams({ device_id: req.device_id }).toString();
      return hqFetch<HqDeregisterResponse>(`/api/issuance/registration?${qs}`, {
        method: "DELETE", body: JSON.stringify(req),
      });
    },
    release(deviceId, req) {
      const qs = new URLSearchParams({ device_id: deviceId }).toString();
      return hqFetch<HqReleaseResponse>(`/api/issuance/release?${qs}`, {
        method: "POST", body: JSON.stringify(req),
      });
    },
  };
}
