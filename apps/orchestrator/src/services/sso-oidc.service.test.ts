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
  // WARP — Okta SSO (same OIDC RP path as Google/Entra). Okta's issuer is
  // the org domain (an `/oauth2/<authServerId>` suffix when a custom
  // authorization server is used); openid-client derives every endpoint +
  // the JWKS from it, so no host is hardcoded here either.
  DROPLET_SSO_OKTA_ISSUER: "https://dev-12345.okta.com/oauth2/default",
  DROPLET_SSO_OKTA_CLIENT_ID: "okta-client-id",
  DROPLET_SSO_OKTA_CLIENT_SECRET: "okta-secret",
  DROPLET_SSO_OKTA_REDIRECT_URI: "https://droplet.local/api/sso/oidc/callback",
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
  enabledSsoProviders,
  SSO_PROVIDERS,
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
  it("accepts google, entra and okta, rejects everything else", () => {
    expect(isSsoProvider("google")).toBe(true);
    expect(isSsoProvider("entra")).toBe(true);
    expect(isSsoProvider("okta")).toBe(true); // shipped in this PR
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

  it("returns the full per-provider config for okta", () => {
    expect(getOidcProviderConfig("okta")).toEqual({
      provider: "okta",
      issuer: "https://dev-12345.okta.com/oauth2/default",
      clientId: "okta-client-id",
      clientSecret: "okta-secret",
      redirectUri: "https://droplet.local/api/sso/oidc/callback",
    });
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
    // Okta fails closed on a blank field too (half-configured = disabled).
    Object.assign(mockConfig, baseConfig);
    mockConfig.DROPLET_SSO_OKTA_CLIENT_SECRET = "";
    expect(getOidcProviderConfig("okta")).toBeNull();
  });
});

describe("enabledSsoProviders — the runtime-discovery source of truth (WARP-629)", () => {
  it("lists every fully-configured provider in the canonical order", () => {
    expect(enabledSsoProviders()).toEqual(["google", "entra", "okta"]);
  });

  it("returns [] when nothing is configured (password-only appliance)", () => {
    for (const k of Object.keys(mockConfig)) delete mockConfig[k];
    expect(enabledSsoProviders()).toEqual([]);
  });

  it("omits a provider whose env is partial — fails closed (missing one var)", () => {
    // Google fully set, Entra missing its secret, Okta missing its redirect.
    mockConfig.DROPLET_SSO_ENTRA_CLIENT_SECRET = "";
    mockConfig.DROPLET_SSO_OKTA_REDIRECT_URI = "";
    expect(enabledSsoProviders()).toEqual(["google"]);
  });

  it("only ever returns values from the closed SsoProvider union", () => {
    for (const p of enabledSsoProviders()) {
      expect(SSO_PROVIDERS).toContain(p);
    }
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
  it("returns normalized {sub, email, emailVerified, name} from the validated ID token", async () => {
    authorizationCodeGrant.mockResolvedValue({
      claims: () => ({
        sub: "google-sub-123",
        email: "Person@Company.com",
        email_verified: true,
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
    expect(result.emailVerified).toBe(true);
    expect(result.name).toBe("A Person");

    // authorizationCodeGrant must receive the expected nonce + pkce verifier
    // + state so the lib enforces signature(JWKS)/iss/aud/exp/nonce/state.
    const checks = authorizationCodeGrant.mock.calls[0]![2] as Record<string, string>;
    expect(checks.expectedNonce).toBe("fixed-nonce");
    expect(checks.pkceCodeVerifier).toBe("fixed-verifier");
    expect(checks.expectedState).toBe("fixed-state");
  });

  // ORCH-01 — email_verified is the trust hinge for account linking; it must
  // normalize to a STRICT boolean so the route's gate can rely on it.
  it.each([
    ["boolean true", true, true],
    ['string "true" (IdP variance)', "true", true],
    ["boolean false", false, false],
    ['string "false"', "false", false],
    ["absent claim", undefined, false],
    ["non-affirmative junk", 1, false],
  ])("normalizes email_verified=%s → %s", async (_label, claimValue, expected) => {
    authorizationCodeGrant.mockResolvedValue({
      claims: () => ({
        sub: "sub-x",
        email: "x@y.com",
        ...(claimValue === undefined ? {} : { email_verified: claimValue }),
      }),
    });
    const result = await exchangeCodeAndValidate(
      "google",
      new URL("https://droplet.local/api/sso/oidc/callback?code=abc"),
      { expectedNonce: "n", codeVerifier: "v", expectedState: "s" },
    );
    expect(result.emailVerified).toBe(expected);
  });

  // ORCH-01 / WARP-639 — the absent/unknown email_verified case is PER-PROVIDER.
  // Entra & Okta routinely OMIT the claim; failing closed there locked out
  // every first-time user (#424). Google stays fail-closed. An explicit denial
  // always blocks, for every provider.
  it.each([
    // [provider, claimValue, expected]
    ["entra", undefined, true], // #424 regression — Entra omits the claim
    ["okta", undefined, true],
    ["google", undefined, false], // Google fails closed
    ["entra", 1, true], // non-affirmative, non-denial junk → per-provider default
    ["entra", false, false], // explicit denial wins even for entra
    ['entra "false"', "false", false],
    ["okta", false, false],
    ["entra", true, true],
    ["okta", "true", true],
  ])(
    "per-provider absent-claim policy: %s email_verified=%s → %s",
    async (label, claimValue, expected) => {
      const provider = String(label).split(" ")[0] as (typeof SSO_PROVIDERS)[number];
      authorizationCodeGrant.mockResolvedValue({
        claims: () => ({
          sub: "sub-x",
          email: "x@y.com",
          ...(claimValue === undefined ? {} : { email_verified: claimValue }),
        }),
      });
      const result = await exchangeCodeAndValidate(
        provider,
        new URL("https://droplet.local/api/sso/oidc/callback?code=abc"),
        { expectedNonce: "n", codeVerifier: "v", expectedState: "s" },
      );
      expect(result.emailVerified).toBe(expected);
    },
  );

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
