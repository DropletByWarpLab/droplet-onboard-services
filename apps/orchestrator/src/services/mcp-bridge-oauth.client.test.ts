import { describe, expect, it, vi } from "vitest";
import { McpBridgeError, McpBridgeOAuthClient } from "./mcp-bridge.client.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const make = (fetchImpl: typeof fetch, serviceToken = "t") => new McpBridgeOAuthClient({ baseUrl: "http://bridge.invalid", serviceToken, fetchImpl });
const sent = (f: ReturnType<typeof vi.fn>) => JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);

describe("McpBridgeOAuthClient (WARP-2401 contract)", () => {
  it("sends discover as exactly { mcpUrl }: no host list from the box", async () => {
    const f = vi.fn(async () => json(200, {
      resource: "r", issuer: "i", authorizationEndpoint: "a", tokenEndpoint: "t", registrationEndpoint: "d",
      tokenEndpointAuthMethods: ["none"], scopesSupported: ["x"], authorizationResponseIssParameterSupported: true,
      clientIdMetadataDocumentSupported: true,
    }));
    const d = await make(f as unknown as typeof fetch).discover("https://mcp.example/x");
    expect(sent(f)).toEqual({ mcpUrl: "https://mcp.example/x" });
    expect((f.mock.calls[0] as unknown[])[0]).toBe("http://bridge.invalid/oauth/discover");
    expect(d).toEqual({ resource: "r", issuer: "i", authorizationEndpoint: "a", tokenEndpoint: "t", registrationEndpoint: "d", issParameterSupported: true });
  });

  it("reads an absent RFC 9207 flag as false, explicitly", async () => {
    const f = vi.fn(async () => json(200, { resource: "r", issuer: "i", authorizationEndpoint: "a", tokenEndpoint: "t" }));
    expect((await make(f as unknown as typeof fetch).discover("u")).issParameterSupported).toBe(false);
  });

  it("surfaces a 422 OAUTH_REFUSED with its reason, and does not retry", async () => {
    const f = vi.fn(async () => json(422, { error: { code: "OAUTH_REFUSED", message: "m" }, reason: "HOST_NOT_ALLOWED" }));
    await expect(make(f as unknown as typeof fetch).discover("https://mcp.example/x")).rejects.toMatchObject({
      code: "OAUTH_REFUSED", reason: "HOST_NOT_ALLOWED", httpStatus: 422,
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("passes the PKCE refusal code through", async () => {
    const f = vi.fn(async () => json(422, { error: { code: "OAUTH_PKCE_UNSUPPORTED", message: "x" } }));
    await expect(make(f as unknown as typeof fetch).discover("u")).rejects.toMatchObject({ code: "OAUTH_PKCE_UNSUPPORTED" });
  });

  it("carries the authorization server's oauth error on a 502 OAUTH_TOKEN_ERROR", async () => {
    const f = vi.fn(async () => json(502, { error: { code: "OAUTH_TOKEN_ERROR", message: "m" }, oauthError: "invalid_grant", httpStatus: 400 }));
    await expect(make(f as unknown as typeof fetch).refresh({ tokenEndpoint: "te", clientId: "c", refreshToken: "r", resource: "x" }))
      .rejects.toMatchObject({ code: "OAUTH_TOKEN_ERROR", reason: "invalid_grant", httpStatus: 502 });
  });

  it("carries resource and the verifier on exchange, resource on refresh, and keeps only four token fields", async () => {
    const f = vi.fn(async () => json(200, { accessToken: "a", refreshToken: "r", expiresIn: 60, scope: "s", id_token: "dropme" }));
    const c = make(f as unknown as typeof fetch);
    const out = await c.exchange({ tokenEndpoint: "te", clientId: "c", code: "k", codeVerifier: "v", redirectUri: "ru", resource: "res" });
    expect(sent(f)).toMatchObject({ resource: "res", codeVerifier: "v", code: "k", redirectUri: "ru" });
    expect(out).toEqual({ accessToken: "a", refreshToken: "r", expiresIn: 60, scope: "s" });
    f.mockClear();
    await c.refresh({ tokenEndpoint: "te", clientId: "c", refreshToken: "r", resource: "res" });
    expect(sent(f)).toMatchObject({ resource: "res", refreshToken: "r" });
  });

  it("sites: sends exactly { accessToken } to /oauth/sites and keeps only well-formed {id,url,name} entries (WARP-3961)", async () => {
    const good = { id: "cloud-1", url: "https://acme.atlassian.net", name: "Acme" };
    const f = vi.fn(async () => json(200, { sites: [good, { id: "x" }, null, { ...good, id: 5 }, { ...good, extra: "dropme", id: "cloud-2" }] }));
    const out = await make(f as unknown as typeof fetch).sites("ACCESS");
    expect(sent(f)).toEqual({ accessToken: "ACCESS" });
    expect((f.mock.calls[0] as unknown[])[0]).toBe("http://bridge.invalid/oauth/sites");
    expect(out).toEqual([good, { id: "cloud-2", url: good.url, name: good.name }]);
  });

  it("sites: an answer with no list is a bridge error, and a 502 SITES_UNAVAILABLE passes through", async () => {
    const none = vi.fn(async () => json(200, {}));
    await expect(make(none as unknown as typeof fetch).sites("a")).rejects.toBeInstanceOf(McpBridgeError);
    const down = vi.fn(async () => json(502, { error: { code: "SITES_UNAVAILABLE", message: "m" } }));
    await expect(make(down as unknown as typeof fetch).sites("a")).rejects.toMatchObject({ code: "SITES_UNAVAILABLE" });
  });

  it("refuses a token answer with no access token, and never dials without a bearer", async () => {
    const f = vi.fn(async () => json(200, {}));
    await expect(make(f as unknown as typeof fetch).refresh({ tokenEndpoint: "te", clientId: "c", refreshToken: "r", resource: "x" })).rejects.toBeInstanceOf(McpBridgeError);
    const g = vi.fn();
    await expect(make(g as unknown as typeof fetch, "").discover("u")).rejects.toMatchObject({ code: "AUTH_NOT_CONFIGURED" });
    expect(g).not.toHaveBeenCalled();
  });
});
