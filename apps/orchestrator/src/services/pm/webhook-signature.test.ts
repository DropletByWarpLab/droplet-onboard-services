/**
 * WARP-3532 — "Signature verified by a test using the documented algorithm."
 *
 * The verifier below is written from docs/work-webhooks.md and shares no code
 * with the signer: if the two ever disagree, a receiver following the document
 * is the one who is locked out, so the document is the authority.
 */
import { describe, it, expect } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  WEBHOOK_SECRET_PREFIX,
  generateWebhookSecret,
  signWebhookBody,
} from "./webhook-signature.js";

/** What docs/work-webhooks.md tells a receiver to do. */
function verify(secret: string, body: string, header: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SECRET = "whsec_test-secret-0123456789";
const BODY = '{"version":1,"id":"evt-1","event":"work_item.created"}';

describe("signWebhookBody", () => {
  it("is t=<unix>,v1=<hex hmac_sha256(secret, t + dot + body)>", () => {
    const header = signWebhookBody(SECRET, BODY, 1_791_000_000);
    const expected = createHmac("sha256", SECRET).update(`1791000000.${BODY}`).digest("hex");
    expect(header).toBe(`t=1791000000,v1=${expected}`);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies under the documented algorithm", () => {
    const t = 1_791_000_000;
    expect(verify(SECRET, BODY, signWebhookBody(SECRET, BODY, t), t + 30)).toBe(true);
  });

  it("does not verify with another secret, another body, or another timestamp", () => {
    const t = 1_791_000_000;
    const header = signWebhookBody(SECRET, BODY, t);
    expect(verify("whsec_other", BODY, header, t)).toBe(false);
    expect(verify(SECRET, `${BODY} `, header, t)).toBe(false);
    // The timestamp is inside the signed text: swapping `t` invalidates `v1`.
    const swapped = header.replace(`t=${t}`, `t=${t + 1}`);
    expect(verify(SECRET, BODY, swapped, t)).toBe(false);
  });

  it("is refused outside the replay window, even when the MAC is right", () => {
    const t = 1_791_000_000;
    const header = signWebhookBody(SECRET, BODY, t);
    expect(verify(SECRET, BODY, header, t + 301)).toBe(false);
    expect(verify(SECRET, BODY, header, t - 301)).toBe(false);
    expect(verify(SECRET, BODY, header, t + 299)).toBe(true);
  });

  it("signs the bytes as sent: a re-serialised body does not verify", () => {
    const t = 1_791_000_000;
    const header = signWebhookBody(SECRET, BODY, t);
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verify(SECRET, reserialised, header, t)).toBe(false);
  });
});

describe("generateWebhookSecret", () => {
  it("is whsec_ plus 256 bits of base64url, and never repeats", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(a.slice(WEBHOOK_SECRET_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});
