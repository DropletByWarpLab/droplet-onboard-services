/**
 * Webhook request signing (WARP-3532, ADR-069 §9).
 *
 *   X-Droplet-Signature: t=<unix seconds>,v1=<hex hmac_sha256(secret, t + "." + body)>
 *
 * `body` is the exact request body, byte for byte, as sent; `secret` is the
 * `whsec_…` string shown once when the webhook was created or its secret rotated.
 * The timestamp is inside the signed text, so a captured request cannot be
 * replayed under a fresh `t`; a receiver that rejects `t` more than a few
 * minutes old (docs/work-webhooks.md recommends five) refuses a replay outright.
 *
 * HMAC-SHA-256 is FIPS-approved and `node:crypto` routes it through the OpenSSL
 * FIPS provider when `DROPLET_FIPS_MODE=1`, so nothing here needs an exception in
 * docs/security/fips-exceptions.md.
 *
 * The verifier lives in the tests and in the docs, not here: the box only ever
 * SIGNS. A verifier shipped in the orchestrator would be dead code whose only
 * job is to agree with itself.
 */
import { createHmac, randomBytes } from "node:crypto";

export const SIGNATURE_HEADER = "X-Droplet-Signature";
export const EVENT_HEADER = "X-Droplet-Event";
export const DELIVERY_HEADER = "X-Droplet-Delivery";

/** `whsec_` + 32 random bytes, base64url: 256 bits, recognisable in a leak scan. */
export const WEBHOOK_SECRET_PREFIX = "whsec_";

export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The `X-Droplet-Signature` value for `body` at `timestampSeconds`. */
export function signWebhookBody(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}
