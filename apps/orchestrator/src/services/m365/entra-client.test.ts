/**
 * WARP-2704 + WARP-2705 — the MSAL adapter behind the Entra port.
 *
 * MSAL itself is replaced by a recording fake: these tests pin what WE hand
 * it, which is where both tickets' defects lived.
 *
 *   - WARP-2705: every operation must build its client from the CONNECTION'S
 *     app registration — its own client id, on its own tenant's authority.
 *     The shipped adapter read one box-wide `M365_CLIENT_ID` on the
 *     multitenant `/organizations` authority, which a customer-registered
 *     single-tenant app cannot sign in through at all.
 *   - WARP-2704: the authorization-code leg must carry PKCE (S256), the state
 *     and the nonce, and redeem the code against the SAME redirect URI with the
 *     verifier — as a public client, with no secret anywhere.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: { M365_AUTHORITY_HOST: "https://login.microsoftonline.com" },
}));

type Recorded = { config: any; calls: Array<{ method: string; request: any }> };

const { instances, behaviour } = vi.hoisted(() => ({
  instances: [] as Recorded[],
  behaviour: { account: { homeAccountId: "uid.utid" } as unknown },
}));

vi.mock("@azure/msal-node", () => {
  class PublicClientApplication {
    private readonly rec: Recorded;
    constructor(config: unknown) {
      this.rec = { config, calls: [] };
      instances.push(this.rec);
    }

    /** What MSAL does after any token call: hand the plugin a changed cache. */
    private async touchCache(): Promise<void> {
      await this.rec.config.cache.cachePlugin.afterCacheAccess({
        cacheHasChanged: true,
        tokenCache: { serialize: () => "SERIALIZED-CACHE" },
      });
    }

    private result() {
      return {
        accessToken: "access-token",
        scopes: ["Mail.ReadWrite", "offline_access"],
        account: {
          homeAccountId: "uid.utid",
          tenantId: "9a8b7c6d-5e4f-4321-8fed-cba987654321",
          username: "sam@practice.com",
        },
      };
    }

    async getAuthCodeUrl(request: unknown) {
      this.rec.calls.push({ method: "getAuthCodeUrl", request });
      return "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?x=1";
    }

    async acquireTokenByCode(request: unknown) {
      this.rec.calls.push({ method: "acquireTokenByCode", request });
      await this.touchCache();
      return this.result();
    }

    async acquireTokenByDeviceCode(request: any) {
      this.rec.calls.push({ method: "acquireTokenByDeviceCode", request });
      request.deviceCodeCallback({
        userCode: "ABCD",
        verificationUri: "https://microsoft.com/devicelogin",
        expiresIn: 900,
        message: "enter ABCD",
      });
      await this.touchCache();
      return this.result();
    }

    getTokenCache() {
      return { getAccountByHomeId: async () => behaviour.account };
    }

    async acquireTokenSilent(request: unknown) {
      this.rec.calls.push({ method: "acquireTokenSilent", request });
      await this.touchCache();
      return this.result();
    }
  }
  return { PublicClientApplication };
});

import { createEntraClient, M365_SCOPES } from "./entra-client.js";

const APP = {
  clientId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
  tenantId: "9a8b7c6d-5e4f-4321-8fed-cba987654321",
};
const REDIRECT = "https://droplet-ai.local/api/m365/callback";

beforeEach(() => {
  instances.length = 0;
  behaviour.account = { homeAccountId: "uid.utid" };
});

describe("the app every operation signs in through (WARP-2705)", () => {
  it("uses the connection's client id on its own tenant's authority — never /organizations", async () => {
    const entra = createEntraClient();
    await entra.getAuthCodeUrl(APP, {
      redirectUri: REDIRECT,
      state: "s",
      nonce: "n",
      codeChallenge: "c",
    });
    await entra.acquireByAuthorizationCode(APP, {
      code: "code",
      redirectUri: REDIRECT,
      codeVerifier: "v",
      nonce: "n",
    });
    await entra.acquireByDeviceCode(APP, { onCode: () => {} });
    await entra.acquireSilent(APP, "CACHE", "uid.utid");

    expect(instances).toHaveLength(4);
    for (const { config } of instances) {
      expect(config.auth.clientId).toBe(APP.clientId);
      expect(config.auth.authority).toBe(`https://login.microsoftonline.com/${APP.tenantId}`);
      expect(config.auth.authority).not.toContain("organizations");
    }
  });

  it("is a public client — no secret, no certificate, no assertion", async () => {
    await createEntraClient().getAuthCodeUrl(APP, {
      redirectUri: REDIRECT,
      state: "s",
      nonce: "n",
      codeChallenge: "c",
    });
    const auth = instances[0]!.config.auth;
    expect(auth.clientSecret).toBeUndefined();
    expect(auth.clientCertificate).toBeUndefined();
    expect(auth.clientAssertion).toBeUndefined();
  });

  it("builds a separate client per connection, so two tenants never share one", async () => {
    const other = { clientId: "11111111-2222-4333-8444-555555555555", tenantId: "other.onmicrosoft.com" };
    const entra = createEntraClient();
    await entra.acquireSilent(APP, "CACHE", "uid.utid");
    await entra.acquireSilent(other, "CACHE", "uid.utid");

    expect(instances.map((i) => i.config.auth.authority)).toEqual([
      `https://login.microsoftonline.com/${APP.tenantId}`,
      "https://login.microsoftonline.com/other.onmicrosoft.com",
    ]);
    expect(instances[1]!.config.auth.clientId).toBe(other.clientId);
  });
});

describe("the authorization-code leg (WARP-2704)", () => {
  it("asks Microsoft for a code with PKCE S256, the state and the nonce", async () => {
    const url = await createEntraClient().getAuthCodeUrl(APP, {
      redirectUri: REDIRECT,
      state: "state-1",
      nonce: "nonce-1",
      codeChallenge: "challenge-1",
    });

    expect(url).toMatch(/^https:\/\/login\.microsoftonline\.com\//);
    const { request } = instances[0]!.calls[0]!;
    expect(request).toMatchObject({
      redirectUri: REDIRECT,
      state: "state-1",
      nonce: "nonce-1",
      codeChallenge: "challenge-1",
      codeChallengeMethod: "S256",
    });
    expect(request.scopes).toEqual([...M365_SCOPES]);
  });

  it("redeems the code with the verifier, against the same redirect URI and scopes", async () => {
    const result = await createEntraClient().acquireByAuthorizationCode(APP, {
      code: "the-code",
      redirectUri: REDIRECT,
      codeVerifier: "the-verifier",
      nonce: "nonce-1",
    });

    const { method, request } = instances[0]!.calls[0]!;
    expect(method).toBe("acquireTokenByCode");
    expect(request).toMatchObject({
      code: "the-code",
      redirectUri: REDIRECT,
      codeVerifier: "the-verifier",
      nonce: "nonce-1",
    });
    expect(request.scopes).toEqual([...M365_SCOPES]);

    // The serialized cache is what gets sealed onto the row — it must be the
    // one MSAL wrote during this redemption, not the (empty) seed.
    expect(result).toMatchObject({
      homeAccountId: "uid.utid",
      accountUpn: "sam@practice.com",
      serializedCache: "SERIALIZED-CACHE",
    });
  });
});

describe("silent refresh", () => {
  it("shapes a vanished cached account like an interaction error, so it reads as reconnect", async () => {
    behaviour.account = null;
    await expect(createEntraClient().acquireSilent(APP, "CACHE", "gone")).rejects.toMatchObject({
      errorCode: "interaction_required",
    });
  });
});
