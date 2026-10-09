import { describe, expect, it, vi } from "vitest";
import { McpBridgeError, McpBridgeOAuthClient } from "./mcp-bridge.client.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const make = (fetchImpl: typeof fetch, serviceToken = "t") => new McpBridgeOAuthClient({ baseUrl: "http://bridge.invalid", serviceToken, fetchImpl });
const sent = (f: ReturnType<typeof vi.fn>) => JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);

describe("McpBridgeOAuthClient (WARP-2401 contract)", () => {
  it("sends discover as exactly { mcpUrl }: no host list from the box", async () => {
    const f = vi.fn(async () => json(200, { resource: "r", issuer: "i", authorizationEndpoint: "a", tokenEndpoint: "t" }));
    const d = await make(f as unknown as typeof fetch).discover("https://mcp.example/x");
    expect(sent(f)).toEqual({ mcpUrl: "https://mcp.example/x" });
    expect((f.mock.calls[0] as unknown[])[0]).toBe("http://bridge.invalid/oauth/discover");
    expect(d.issParameterSupported).toBe(false);
  });

  it("maps a 422 HOST_NOT_ALLOWED to a typed refusal and does not retry", async () => {
    const f = vi.fn(async () => json(422, { reason: "HOST_NOT_ALLOWED" }));
    await expect(make(f as unknown as typeof fetch).discover("https://mcp.example/x")).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED", httpStatus: 422 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("passes the PKCE refusal code through", async () => {
    const f = vi.fn(async () => json(400, { error: { code: "PKCE_UNSUPPORTED", message: "x" } }));
    await expect(make(f as unknown as typeof fetch).discover("u")).rejects.toMatchObject({ code: "PKCE_UNSUPPORTED" });
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

  it("refuses a token answer with no access token, and never dials without a bearer", async () => {
    const f = vi.fn(async () => json(200, {}));
    await expect(make(f as unknown as typeof fetch).refresh({ tokenEndpoint: "te", clientId: "c", refreshToken: "r", resource: "x" })).rejects.toBeInstanceOf(McpBridgeError);
    const g = vi.fn();
    await expect(make(g as unknown as typeof fetch, "").discover("u")).rejects.toMatchObject({ code: "AUTH_NOT_CONFIGURED" });
    expect(g).not.toHaveBeenCalled();
  });
});
