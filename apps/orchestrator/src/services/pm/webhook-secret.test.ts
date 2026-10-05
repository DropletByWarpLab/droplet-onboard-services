/**
 * WARP-3532 — the signing secret at rest: sealed under column-crypto, bound to
 * its own row, never openable as something else.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  __setColumnCryptoKeyForTest,
  decryptColumn,
  deriveSaasCredentialKey,
  encryptColumn,
  saasCredentialAad,
} from "../column-crypto.service.js";
import { openWebhookSecret, sealWebhookSecret, webhookSecretAad } from "./webhook-secret.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
beforeEach(() => __setColumnCryptoKeyForTest(KEY));
afterEach(() => __setColumnCryptoKeyForTest(null));

describe("webhook secret sealing", () => {
  it("round-trips, and the stored blob is not the secret", () => {
    const blob = sealWebhookSecret("hook-1", "whsec_abc");
    expect(blob.startsWith("dcv1:")).toBe(true);
    expect(blob).not.toContain("whsec_abc");
    expect(openWebhookSecret("hook-1", blob)).toBe("whsec_abc");
  });

  it("seals the same secret differently each time (random IV)", () => {
    expect(sealWebhookSecret("hook-1", "s")).not.toBe(sealWebhookSecret("hook-1", "s"));
  });

  it("does not open on another webhook's row", () => {
    expect(() => openWebhookSecret("hook-2", sealWebhookSecret("hook-1", "whsec_abc"))).toThrow();
  });

  it("is not openable as a connector credential, nor the reverse (the AADs differ)", () => {
    const blob = sealWebhookSecret("same-id", "whsec_abc");
    expect(() => decryptColumn(deriveSaasCredentialKey(), blob, saasCredentialAad("same-id"))).toThrow();
    const credential = encryptColumn(deriveSaasCredentialKey(), "{}", saasCredentialAad("same-id"));
    expect(() => openWebhookSecret("same-id", credential)).toThrow();
  });

  it("binds to a stable AAD string", () => {
    expect(webhookSecretAad("abc")).toBe("pm-webhook-secret:abc");
  });

  it("does not open under a different device key (a factory reset shreds it)", () => {
    const blob = sealWebhookSecret("hook-1", "whsec_abc");
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));
    expect(() => openWebhookSecret("hook-1", blob)).toThrow();
  });
});
