/**
 * ADR-013 (SSO OIDC) — provider-config resolution + openid-client wrapper.
 *
 * Two surfaces under test, both LOCAL (openid-client's network calls —
 * discovery + authorizationCodeGrant — are mocked; no real IdP is hit):
 *
 *   1. getOidcProviderConfig(provider) — reads per-provider config from
 *      env (config.ts DROPLET_SSO_*). Returns null when the provider is
 *      not fully configured so the route fails closed (no half-configured
 *      authorize URL). Only "google" / "entra" are recognised.
 *
 *   2. exchangeCodeAndValidate(...) — delegates ID-token validation to
 *      openid-client's authorizationCodeGrant (signature via JWKS, iss,
 *      aud, exp) and additionally pins the expected nonce + state. Returns
 *      the normalized {sub, email, name}. Surfaces the underlying error
 *      (does NOT swallow a failed validation into a success).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// openid-client is the vetted lib; mock its network-touching functions.
const discovery = vi.fn((..._a: unknown[]) => undefined as unknown);
const buildAuthorizationUrl = vi.fn((..._a: unknown[]) => undefined as unknown);
const authorizationCodeGrant = vi.fn((..._a: unknown[]) => undefined as unknown);
const randomState = vi.fn((..._a: unknown[]) => "fixed-state");
const randomNonce = vi.fn((..._a: unknown[]) => "fixed-nonce");
const randomPKCECodeVerifier = vi.fn((..._a: unknown[]) => "fixed-verifier");
const calculatePKCECodeChallenge = vi.fn(async (..._a: unknown[]) => "fixed-challenge");
vi.mock("openid-client", () => ({
  discovery: (...a: unknown[]) => discovery(...a),
  buildAuthorizationUrl: (...a: unknown[]) => buildAuthorizationUrl(...a),
  authorizationCodeGrant: (...a: unknown[]) => authorizationCodeGrant(...a),
  randomState: (...a: unknown[]) => randomState(...a),
  randomNonce: (...a: unknown[]) => randomNonce(...a),
  randomPKCECodeVerifier: (...a: unknown[]) => randomPKCECodeVerifier(...a),
  calculatePKCECodeChallenge: (...a: unknown[]) => calculatePKCECodeChallenge(...a),
}));

const baseConfig = {
  DROPLET_SSO_GOOGLE_ISSUER: "https://accounts.google.com",
  DROPLET_SSO_GOOGLE_CLIENT_ID: "google-client-id",
  DROPLET_SSO_GOOGLE_CLIENT_SECRET: "google-secret",
  DROPLET_SSO_GOOGLE_REDIRECT_URI: "https://droplet.local/api/sso/oidc/callback",
  DROPLET_SSO_ENTRA_ISSUER: "https://login.microsoftonline.com/tenant/v2.0",
  DROPLET_SSO_ENTRA_CLIENT_ID: "entra-client-id",
  DROPLET_SSO_ENTRA_CLIENT_SECRET: "entra-secret",
  DROPLET_SSO_ENTRA_REDIRECT_URI: "https://droplet.local/api/sso/oidc/callback",
};
const mockConfig: Record<string, unknown> = { ...baseConfig };
vi.mock("../config.js", () => ({
  get config() {
    return mockConfig;
  },
}));

import {
  getOidcProviderConfig,
  isSsoProvider,
  buildAuthorizeRequest,
  exchangeCodeAndValidate,
} from "./sso-oidc.service.js";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockConfig)) delete mockConfig[k];
  Object.assign(mockConfig, baseConfig);
  discovery.mockResolvedValue({ serverMetadata: () => ({ issuer: "x" }) });
  buildAuthorizationUrl.mockReturnValue(
    new URL("https://accounts.google.com/o/oauth2/v2/auth?state=fixed-state"),
  );
});

describe("isSsoProvider", () => {
  it("accepts google and entra, rejects everything else", () => {
    expect(isSsoProvider("google")).toBe(true);
    expect(isSsoProvider("entra")).toBe(true);
    expect(isSsoProvider("okta")).toBe(false); // separate PR
    expect(isSsoProvider("microsoft")).toBe(false); // wire label maps to entra upstream
    expect(isSsoProvider("")).toBe(false);
    expect(isSsoProvider("GOOGLE")).toBe(false);
  });
});

describe("getOidcProviderConfig — env-sourced, fail-closed", () => {
  it("returns the full per-provider config for google", () => {
    expect(getOidcProviderConfig("google")).toEqual({
      provider: "google",
      issuer: "https://accounts.google.com",
      clientId: "google-client-id",
      clientSecret: "google-secret",
      redirectUri: "https://droplet.local/api/sso/oidc/callback",
    });
  });

  it("returns the full per-provider config for entra", () => {
    const cfg = getOidcProviderConfig("entra");
    expect(cfg?.issuer).toBe("https://login.microsoftonline.com/tenant/v2.0");
    expect(cfg?.clientId).toBe("entra-client-id");
  });

  it("returns null when ANY required field is blank (half-configured = disabled)", () => {
    mockConfig.DROPLET_SSO_GOOGLE_CLIENT_SECRET = "";
    expect(getOidcProviderConfig("google")).toBeNull();
    Object.assign(mockConfig, baseConfig);
    mockConfig.DROPLET_SSO_GOOGLE_ISSUER = "";
    expect(getOidcProviderConfig("google")).toBeNull();
    Object.assign(mockConfig, baseConfig);
    mockConfig.DROPLET_SSO_ENTRA_REDIRECT_URI = "";
    expect(getOidcProviderConfig("entra")).toBeNull();
  });
});

describe("buildAuthorizeRequest — state/nonce/PKCE minted, no hardcoded host", () => {
  it("mints single-use state + nonce + PKCE verifier and returns the authorize URL", async () => {
    const req = await buildAuthorizeRequest("google");
    expect(req.state).toBe("fixed-state");
    expect(req.nonce).toBe("fixed-nonce");
    expect(req.codeVerifier).toBe("fixed-verifier");
    expect(req.authorizeUrl).toContain("state=fixed-state");

    // discovery() must be called with the configured issuer URL + client id
    // (NOT a hardcoded host).
    expect(discovery).toHaveBeenCalledTimes(1);
    const [issuerUrl, clientId] = discovery.mock.calls[0]!;
    expect(String(issuerUrl)).toBe("https://accounts.google.com/");
    expect(clientId).toBe("google-client-id");

    // The authorize params must carry the nonce + a PKCE challenge + the
    // configured redirect_uri + openid scope.
    const params = buildAuthorizationUrl.mock.calls[0]![1] as Record<string, string>;
    expect(params.nonce).toBe("fixed-nonce");
    expect(params.state).toBe("fixed-state");
    expect(params.code_challenge).toBe("fixed-challenge");
    expect(params.code_challenge_method).toBe("S256");
    expect(params.redirect_uri).toBe("https://droplet.local/api/sso/oidc/callback");
    expect(params.scope).toContain("openid");
  });

  it("throws when the provider is not configured (fail closed, no URL leaked)", async () => {
    mockConfig.DROPLET_SSO_GOOGLE_CLIENT_ID = "";
    await expect(buildAuthorizeRequest("google")).rejects.toThrow(/not configured/i);
    expect(discovery).not.toHaveBeenCalled();
  });
});

describe("exchangeCodeAndValidate — delegates ID-token validation, pins nonce", () => {
  it("returns normalized {sub, email, name} from the validated ID token", async () => {
    authorizationCodeGrant.mockResolvedValue({
      claims: () => ({
        sub: "google-sub-123",
        email: "Person@Company.com",
        name: "A Person",
      }),
    });
    const result = await exchangeCodeAndValidate("google", new URL("https://droplet.local/api/sso/oidc/callback?code=abc&state=fixed-state"), {
      expectedNonce: "fixed-nonce",
      codeVerifier: "fixed-verifier",
      expectedState: "fixed-state",
    });
    expect(result.sub).toBe("google-sub-123");
    expect(result.email).toBe("Person@Company.com"); // raw; route normalizes
    expect(result.name).toBe("A Person");

    // authorizationCodeGrant must receive the expected nonce + pkce verifier
    // + state so the lib enforces signature(JWKS)/iss/aud/exp/nonce/state.
    const checks = authorizationCodeGrant.mock.calls[0]![2] as Record<string, string>;
    expect(checks.expectedNonce).toBe("fixed-nonce");
    expect(checks.pkceCodeVerifier).toBe("fixed-verifier");
    expect(checks.expectedState).toBe("fixed-state");
  });

  it("propagates a validation failure (does NOT swallow into success)", async () => {
    authorizationCodeGrant.mockRejectedValue(new Error("unexpected JWT alg / nonce mismatch"));
    await expect(
      exchangeCodeAndValidate("google", new URL("https://droplet.local/api/sso/oidc/callback?code=abc"), {
        expectedNonce: "fixed-nonce",
        codeVerifier: "fixed-verifier",
        expectedState: "fixed-state",
      }),
    ).rejects.toThrow();
  });

  it("rejects an ID token with no usable subject", async () => {
    authorizationCodeGrant.mockResolvedValue({ claims: () => ({ email: "x@y.com" }) });
    await expect(
      exchangeCodeAndValidate("google", new URL("https://droplet.local/api/sso/oidc/callback?code=abc"), {
        expectedNonce: "fixed-nonce",
        codeVerifier: "fixed-verifier",
        expectedState: "fixed-state",
      }),
    ).rejects.toThrow(/subject|sub/i);
  });
});
