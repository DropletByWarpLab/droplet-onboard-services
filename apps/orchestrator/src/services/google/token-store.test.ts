import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { openGoogleFlow, openGoogleGrant, sealGoogleFlow, sealGoogleGrant } from "./token-store.js";
import { DEFAULT_GOOGLE_FEATURES, scopesForGoogleFeatures } from "./scopes.js";

describe("Google credentials at rest", () => {
  beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 6).toString("base64")));
  afterEach(() => __setColumnCryptoKeyForTest(null));
  const grant = { clientId: "customer-client", clientSecret: "client-secret", refreshToken: "refresh-secret", scopes: scopesForGoogleFeatures(DEFAULT_GOOGLE_FEATURES) };
  it("encrypts refresh tokens and customer client credentials with owner binding", () => {
    const blob = sealGoogleGrant("user-a", grant);
    expect(blob).toMatch(/^dcv1:/);
    expect(blob).not.toContain(grant.refreshToken);
    expect(blob).not.toContain(grant.clientSecret);
    expect(openGoogleGrant("user-a", blob)).toEqual(grant);
    expect(() => openGoogleGrant("user-b", blob)).toThrow();
  });
  it("separates pending-flow secrets from a persisted grant", () => {
    const blob = sealGoogleFlow("user-a", { ...grant, ...DEFAULT_GOOGLE_FEATURES, codeVerifier: "verifier", redirectUri: "https://box.example.com/api/google/callback" });
    expect(openGoogleFlow("user-a", blob).codeVerifier).toBe("verifier");
    expect(() => openGoogleGrant("user-a", blob)).toThrow();
    expect(() => openGoogleFlow("user-a", sealGoogleGrant("user-a", grant))).toThrow();
  });
  it("crypto-shreds old connections when the device key rotates", () => {
    const blob = sealGoogleGrant("user-a", grant);
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 7).toString("base64"));
    expect(() => openGoogleGrant("user-a", blob)).toThrow();
  });
  it("owner-binds and validates the prior connection state carried by repeated consent", () => {
    const prior = { state: "CONNECTED" as const, calendarSyncState: "DISCONNECTED" as const,
      mail: true, calendar: false, connectedAt: "2026-10-05T15:00:00.000Z", lastRefreshOkAt: null, lastError: null };
    const flow = { ...grant, ...DEFAULT_GOOGLE_FEATURES, codeVerifier: "verifier",
      redirectUri: "https://box.example.com/api/google/callback", prior };
    const blob = sealGoogleFlow("user-a", flow);
    expect(openGoogleFlow("user-a", blob).prior).toEqual(prior);
    expect(() => openGoogleFlow("user-b", blob)).toThrow();
    const invalid = sealGoogleFlow("user-a", { ...flow, prior: { ...prior, connectedAt: "invalid date" } });
    expect(() => openGoogleFlow("user-a", invalid)).toThrow();
  });
});
