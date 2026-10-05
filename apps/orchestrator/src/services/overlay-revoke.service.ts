/**
 * Revocation only for devices enrolled through the retired fleet overlay.
 * New remote access uses direct WireGuard; this client cannot enroll, poll,
 * answer or install devices. Existing fleet grants still need a signed cleanup
 * revoke after local access stops, including any in-flight brokered session.
 */
import type { DeviceIdentityClient } from "./device-identity.client.js";

type Identity = Pick<DeviceIdentityClient, "signWithDeviceKey" | "getDeviceIdentityStatus">;

export interface LegacyOverlayRevokeDeps {
  config: { hqBaseUrl: string; deviceId: string; httpTimeoutMs?: number };
  identity: Identity;
  fetchImpl?: typeof fetch;
}

/** The deployed fleet revoke protocol is retained for existing grants. */
export function buildOverlayRevokeMessage(deviceId: string, wgPublicKey: string): string {
  return `droplet-overlay-revoke:v1:${deviceId}:${wgPublicKey}`;
}

/** 404 means the grant is already gone; other failures must remain visible. */
export async function revokeOverlayDeviceAtHq(
  deps: LegacyOverlayRevokeDeps,
  wgPublicKey: string,
): Promise<void> {
  const { config, identity } = deps;
  if (!config.hqBaseUrl) {
    throw new Error("HQ_ISSUANCE_URL not configured — cannot revoke legacy overlay device at HQ");
  }
  const keyFingerprint = (await identity.getDeviceIdentityStatus()).certFingerprint;
  const signed = await identity.signWithDeviceKey(
    new TextEncoder().encode(buildOverlayRevokeMessage(config.deviceId, wgPublicKey)),
  );
  const algorithm = signed.algorithm.trim().toLowerCase();
  const sigAlg = algorithm.includes("ecdsa")
    ? "ecdsa-sha256"
    : algorithm.includes("rsa") ? "rsa-pss" : algorithm;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.httpTimeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(
      `${config.hqBaseUrl.replace(/\/+$/, "")}/api/overlay/devices/revoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: config.deviceId,
          key_fingerprint: keyFingerprint,
          sig: Buffer.from(signed.signature).toString("base64"),
          sig_alg: sigAlg,
          wg_public_key: wgPublicKey,
        }),
        signal: ctrl.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) return;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HQ overlay revoke returned ${response.status}: ${body.slice(0, 200)}`);
  }
}
