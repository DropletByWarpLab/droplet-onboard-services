/**
 * WARP-2401 — the OAuth client: discovery, PKCE, registration, token exchange,
 * refresh and revocation, and the `/oauth/*` routes.
 *
 * NOTHING HERE OPENS A SOCKET. Every request runs through the REAL
 * `createGuardedFetch` with its `resolve` and `send` seams replaced, so the
 * address check is the shipped one and a refused destination never reaches
 * `send` (asserted by `calls.length`). Hosts are RFC 2606 reserved names, except
 * the Atlassian ones, which are the curated set under test. Secrets are
 * obviously fake.
 */
import { describe, it, expect } from "vitest";
import { ATLASSIAN_ALLOWED_OAUTH_HOSTS } from "../src/atlassian.js";
import { BridgeSessionStore, handleBridgeRequest, type BridgeRequest } from "../src/http-api.js";
import { discover } from "../src/oauth/discovery.js";
import { isAllowedRedirectUri, registerClient } from "../src/oauth/dcr.js";
import { OAuthRefusedError, OAuthTokenError, PkceUnsupportedError } from "../src/oauth/errors.js";
import type { OAuthDeps } from "../src/oauth/http.js";
import { challengeOf, isValidVerifier, newVerifier } from "../src/oauth/pkce.js";
import { exchangeCode, refreshToken, revokeToken } from "../src/oauth/token.js";
import type { PinnedDestination } from "../src/pinned-fetch.js";
import { UnsafeMcpUrlError } from "../src/safe-url.js";

const MCP = "https://mcp.example.test/v1/mcp";
const ISSUER = "https://as.example.test/tenant1";
const HOSTS = new Set(["mcp.example.test", "as.example.test"]);
const PRM_URL = "https://mcp.example.test/.well-known/oauth-protected-resource/v1/mcp";
const PRM_ROOT = "https://mcp.example.test/.well-known/oauth-protected-resource";
const AS_URL = "https://as.example.test/.well-known/oauth-authorization-server/tenant1";
const TOKEN_URL = "https://as.example.test/token";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const FAKE_CODE = "FAKE-AUTH-CODE-0000";
const FAKE_REFRESH = "FAKE-REFRESH-0000";

type Reply = { status?: number; body?: unknown; raw?: string };
interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** A guarded-fetch harness: `routes` is keyed by the exact URL dialed. */
function net(routes: Record<string, Reply>, ips: Record<string, string> = {}) {
  const calls: Call[] = [];
  const deps: OAuthDeps = {
    resolve: async (host) => [{ address: ips[host] ?? "8.8.8.8", family: 4 }],
    local: () => ({ addresses: [], cidrs: [] }),
    send: async (dest: PinnedDestination, init: RequestInit) => {
      calls.push({
        url: dest.url.href,
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? init.body : "",
      });
      const r = routes[dest.url.href];
      if (!r) return new Response("{}", { status: 404 });
      return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    },
  };
  return { deps, calls };
}

const form = (c: Call) => new URLSearchParams(c.body);

function asMeta(over: Record<string, unknown> = {}): Reply {
  return {
    body: {
      issuer: ISSUER,
      authorization_endpoint: "https://as.example.test/authorize",
      token_endpoint: TOKEN_URL,
      registration_endpoint: "https://as.example.test/register",
      revocation_endpoint: "https://as.example.test/revoke",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      ...over,
    },
  };
}

const prm = (over: Record<string, unknown> = {}): Reply => ({
  body: { resource: MCP, authorization_servers: [ISSUER], ...over },
});

describe("discovery", () => {
  it("walks PRM (path-suffixed) then AS metadata and returns the endpoints", async () => {
    const { deps, calls } = net({ [PRM_URL]: prm(), [AS_URL]: asMeta({ authorization_response_iss_parameter_supported: true }) });
    const d = await discover(MCP, HOSTS, deps);
    expect(calls.map((c) => c.url)).toEqual([PRM_URL, AS_URL]);
    expect(d).toMatchObject({
      resource: MCP,
      issuer: ISSUER,
      tokenEndpoint: TOKEN_URL,
      authorizationEndpoint: "https://as.example.test/authorize",
      authorizationResponseIssParameterSupported: true,
    });
  });

  it("falls back to the issuer-relative AS form", async () => {
    const { deps, calls } = net({
      [PRM_URL]: prm(),
      [`${ISSUER}/.well-known/oauth-authorization-server`]: asMeta(),
    });
    await discover(MCP, HOSTS, deps);
    expect(calls.map((c) => c.url)).toEqual([PRM_URL, AS_URL, `${ISSUER}/.well-known/oauth-authorization-server`]);
  });

  it("skips a root PRM whose resource is not the origin (RFC 9728 3.3)", async () => {
    const { deps, calls } = net({ [PRM_ROOT]: prm() }); // resource = the path URL, not the origin
    await expect(discover(MCP, HOSTS, deps)).rejects.toMatchObject({ reason: "DISCOVERY_FAILED" });
    expect(calls.map((c) => c.url)).toEqual([PRM_URL, PRM_ROOT]);
  });

  it("never accepts an origin-level root PRM for a resource that has a path", async () => {
    const { deps } = net({ [PRM_ROOT]: prm({ resource: "https://mcp.example.test" }) });
    await expect(discover(MCP, HOSTS, deps)).rejects.toMatchObject({ reason: "RESOURCE_MISMATCH" });
  });

  it("gives every OAuth request a deadline signal", async () => {
    const { deps, calls } = net({ [PRM_URL]: prm(), [AS_URL]: asMeta() });
    const seen: Array<AbortSignal | null | undefined> = [];
    const send = deps.send!;
    deps.send = async (dest, init) => {
      seen.push(init.signal);
      return send(dest, init);
    };
    await discover(MCP, HOSTS, deps);
    expect(calls.length).toBeGreaterThan(0);
    expect(seen.every((s) => s instanceof AbortSignal && !s.aborted)).toBe(true);
  });

  it("refuses metadata without code_challenge_methods_supported (typed, not a warning)", async () => {
    const meta = asMeta();
    delete (meta.body as Record<string, unknown>).code_challenge_methods_supported;
    const { deps } = net({ [PRM_URL]: prm(), [AS_URL]: meta });
    await expect(discover(MCP, HOSTS, deps)).rejects.toBeInstanceOf(PkceUnsupportedError);
  });

  it("refuses a method list that lacks S256", async () => {
    const { deps } = net({ [PRM_URL]: prm(), [AS_URL]: asMeta({ code_challenge_methods_supported: ["plain"] }) });
    await expect(discover(MCP, HOSTS, deps)).rejects.toBeInstanceOf(PkceUnsupportedError);
  });

  it("refuses an issuer that is not string-equal to the one fetched", async () => {
    const { deps } = net({ [PRM_URL]: prm(), [AS_URL]: asMeta({ issuer: `${ISSUER}/` }) });
    await expect(discover(MCP, HOSTS, deps)).rejects.toMatchObject({ reason: "ISSUER_MISMATCH" });
  });

  it("refuses protected-resource metadata that names another resource", async () => {
    const { deps } = net({ [PRM_URL]: prm({ resource: "https://mcp.example.test/other" }) });
    await expect(discover(MCP, HOSTS, deps)).rejects.toMatchObject({ reason: "RESOURCE_MISMATCH" });
  });

  it("refuses a token endpoint that resolves to a private address, before dialing it", async () => {
    const hosts = new Set([...HOSTS, "tok.example.test"]);
    const { deps, calls } = net(
      { [PRM_URL]: prm(), [AS_URL]: asMeta({ token_endpoint: "https://tok.example.test/token" }) },
      { "tok.example.test": "10.0.0.1" },
    );
    await expect(discover(MCP, hosts, deps)).rejects.toBeInstanceOf(UnsafeMcpUrlError);
    expect(calls.every((c) => !c.url.includes("tok.example.test"))).toBe(true);
  });

  it("refuses an endpoint on a port other than 443", async () => {
    const { deps } = net({ [PRM_URL]: prm(), [AS_URL]: asMeta({ token_endpoint: "https://as.example.test:8443/token" }) });
    await expect(discover(MCP, HOSTS, deps)).rejects.toBeInstanceOf(UnsafeMcpUrlError);
  });

  it("refuses an endpoint on a host outside the allowed set", async () => {
    const { deps } = net({ [PRM_URL]: prm(), [AS_URL]: asMeta({ token_endpoint: "https://other.example.test/token" }) });
    await expect(discover(MCP, HOSTS, deps)).rejects.toMatchObject({ reason: "HOST_NOT_ALLOWED" });
  });

  it("every hop goes through the address guard: a private MCP host is never dialed", async () => {
    const { deps, calls } = net({ [PRM_URL]: prm() }, { "mcp.example.test": "10.0.0.1" });
    await expect(discover(MCP, HOSTS, deps)).rejects.toBeInstanceOf(UnsafeMcpUrlError);
    expect(calls).toHaveLength(0);
  });

  it("curated Atlassian set: a PRM naming another authorization server is refused before any dial", async () => {
    const mcp = "https://mcp.atlassian.com/v1/mcp/authv2";
    const { deps, calls } = net({
      "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v1/mcp/authv2": {
        body: { resource: mcp, authorization_servers: ["https://evil.example/as"] },
      },
    });
    await expect(discover(mcp, ATLASSIAN_ALLOWED_OAUTH_HOSTS, deps)).rejects.toBeInstanceOf(OAuthRefusedError);
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["mcp.atlassian.com"]);
  });

  it("a caller-supplied allowedIssuerHosts is ignored: the curated Atlassian set cannot be widened", async () => {
    const mcp = "https://mcp.atlassian.com/v1/mcp/authv2";
    const { deps, calls } = net({
      "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v1/mcp/authv2": {
        body: { resource: mcp, authorization_servers: ["https://evil.example/as"] },
      },
    });
    const res = await call("/oauth/discover", { mcpUrl: mcp, allowedIssuerHosts: ["evil.example"] }, deps);
    expect(res.status).toBe(422);
    expect(calls.every((c) => !c.url.includes("evil.example"))).toBe(true);
  });
});

describe("pkce", () => {
  it("S256 matches the RFC 7636 appendix B vector", () => {
    expect(challengeOf(VERIFIER)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("newVerifier is 43 base64url characters and valid", () => {
    const v = newVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isValidVerifier(v)).toBe(true);
    expect(newVerifier()).not.toBe(v);
  });
  it("isValidVerifier bounds a verifier from the wire", () => {
    expect(isValidVerifier("short")).toBe(false);
    expect(isValidVerifier("a".repeat(129))).toBe(false);
    expect(isValidVerifier(`${"a".repeat(42)}!`)).toBe(false);
    expect(isValidVerifier(undefined)).toBe(false);
  });
});

const TOKENS: Reply = { body: { access_token: "FAKE-ACCESS-0000", token_type: "Bearer", expires_in: 3600, refresh_token: FAKE_REFRESH, scope: "read:me" } };

describe("token exchange, refresh, revoke", () => {
  it("exchange sends resource, code_verifier, grant_type and the redirect, and no scope", async () => {
    const { deps, calls } = net({ [TOKEN_URL]: TOKENS });
    const t = await exchangeCode(
      { tokenEndpoint: TOKEN_URL, clientId: "cid", code: FAKE_CODE, codeVerifier: VERIFIER, redirectUri: "https://box.example.test/api/mcp/oauth/callback", resource: MCP },
      deps,
    );
    const f = form(calls[0]!);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(f)).toEqual({
      grant_type: "authorization_code",
      code: FAKE_CODE,
      redirect_uri: "https://box.example.test/api/mcp/oauth/callback",
      client_id: "cid",
      code_verifier: VERIFIER,
      resource: MCP,
    });
    expect(t).toEqual({ accessToken: "FAKE-ACCESS-0000", refreshToken: FAKE_REFRESH, expiresIn: 3600, scope: "read:me" });
  });

  it("refresh sends resource and grant_type, scope only when named, secret only when given", async () => {
    const { deps, calls } = net({ [TOKEN_URL]: TOKENS });
    await refreshToken({ tokenEndpoint: TOKEN_URL, clientId: "cid", refreshToken: FAKE_REFRESH, resource: MCP }, deps);
    await refreshToken(
      { tokenEndpoint: TOKEN_URL, clientId: "cid", clientSecret: "FAKE-SECRET", refreshToken: FAKE_REFRESH, resource: MCP, scope: "read:me" },
      deps,
    );
    const a = form(calls[0]!);
    expect(a.get("grant_type")).toBe("refresh_token");
    expect(a.get("resource")).toBe(MCP);
    expect(a.has("scope")).toBe(false);
    expect(a.has("client_secret")).toBe(false);
    const b = form(calls[1]!);
    expect(b.get("scope")).toBe("read:me");
    expect(b.get("client_secret")).toBe("FAKE-SECRET");
  });

  it("keeps nothing from the response beyond the four fields", async () => {
    const { deps } = net({ [TOKEN_URL]: { body: { ...(TOKENS.body as object), id_token: "FAKE-ID", extra: { a: 1 } } } });
    const t = await refreshToken({ tokenEndpoint: TOKEN_URL, clientId: "c", refreshToken: FAKE_REFRESH, resource: MCP }, deps);
    expect(Object.keys(t).sort()).toEqual(["accessToken", "expiresIn", "refreshToken", "scope"]);
  });

  it("refuses a non-bearer token type, a missing access_token and a bad expires_in", async () => {
    for (const body of [
      { access_token: "x", token_type: "mac" },
      { token_type: "Bearer" },
      { access_token: "x", token_type: "Bearer", expires_in: -5 },
      { access_token: "x", token_type: "Bearer", expires_in: "3600" },
    ]) {
      const { deps } = net({ [TOKEN_URL]: { body } });
      await expect(
        refreshToken({ tokenEndpoint: TOKEN_URL, clientId: "c", refreshToken: FAKE_REFRESH, resource: MCP }, deps),
      ).rejects.toBeInstanceOf(OAuthRefusedError);
    }
  });

  it("surfaces invalid_grant as a typed error and never relays error_description", async () => {
    const { deps } = net({
      [TOKEN_URL]: { status: 400, body: { error: "invalid_grant", error_description: `bad ${FAKE_REFRESH}` } },
    });
    const e = await refreshToken({ tokenEndpoint: TOKEN_URL, clientId: "c", refreshToken: FAKE_REFRESH, resource: MCP }, deps).catch((x) => x);
    expect(e).toBeInstanceOf(OAuthTokenError);
    expect(e.oauthError).toBe("invalid_grant");
    expect(e.message).not.toContain(FAKE_REFRESH);
  });

  it("refuses an oversized response body", async () => {
    const { deps } = net({ [TOKEN_URL]: { raw: "x".repeat(300 * 1024) } });
    await expect(
      refreshToken({ tokenEndpoint: TOKEN_URL, clientId: "c", refreshToken: FAKE_REFRESH, resource: MCP }, deps),
    ).rejects.toMatchObject({ reason: "RESPONSE_TOO_LARGE" });
  });

  it("exchange never reaches a token endpoint that resolves privately", async () => {
    const { deps, calls } = net({ [TOKEN_URL]: TOKENS }, { "as.example.test": "192.168.1.5" });
    await expect(
      exchangeCode(
        { tokenEndpoint: TOKEN_URL, clientId: "c", code: FAKE_CODE, codeVerifier: VERIFIER, redirectUri: "https://box.example.test/api/mcp/oauth/callback", resource: MCP },
        deps,
      ),
    ).rejects.toBeInstanceOf(UnsafeMcpUrlError);
    expect(calls).toHaveLength(0);
  });

  it("revoke posts the token and client id", async () => {
    const { deps, calls } = net({ "https://as.example.test/revoke": { raw: "" } });
    await revokeToken({ revocationEndpoint: "https://as.example.test/revoke", clientId: "c", token: FAKE_REFRESH, tokenTypeHint: "refresh_token" }, deps);
    expect(Object.fromEntries(form(calls[0]!))).toEqual({ token: FAKE_REFRESH, client_id: "c", token_type_hint: "refresh_token" });
  });
});

describe("dynamic client registration (deprecated fallback)", () => {
  it("sends application_type web and token_endpoint_auth_method none", async () => {
    const { deps, calls } = net({ "https://as.example.test/register": { status: 201, body: { client_id: "new-client", extra: 1 } } });
    const r = await registerClient("https://as.example.test/register", { redirectUris: ["https://box.example.test/api/mcp/oauth/callback", "http://127.0.0.1:8080/api/mcp/oauth/callback"] }, deps);
    expect(r).toEqual({ clientId: "new-client" });
    expect(JSON.parse(calls[0]!.body)).toEqual({
      redirect_uris: ["https://box.example.test/api/mcp/oauth/callback", "http://127.0.0.1:8080/api/mcp/oauth/callback"],
      client_name: "Droplet",
      application_type: "web",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  it("refuses any redirect that is not the box callback path (https or loopback), before sending", async () => {
    for (const bad of [
      "https://evil.example/cb",
      "https://box.example.test/api/mcp/oauth/callback?x=1",
      "https://box.example.test/api/mcp/oauth/callback#f",
      "https://box.example.test/api/mcp/oauth/callback/extra",
      "http://box.example.test/api/mcp/oauth/callback",
    ]) {
      const { deps, calls } = net({});
      await expect(registerClient("https://as.example.test/register", { redirectUris: [bad] }, deps)).rejects.toBeInstanceOf(OAuthRefusedError);
      expect(calls).toHaveLength(0);
    }
    expect(isAllowedRedirectUri("http://localhost/api/mcp/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:3000/api/mcp/oauth/callback")).toBe(true);
  });

  it("refuses a plain-http, non-loopback redirect URI before sending", async () => {
    const { deps, calls } = net({});
    await expect(registerClient("https://as.example.test/register", { redirectUris: ["http://evil.example.test/cb"] }, deps)).rejects.toBeInstanceOf(OAuthRefusedError);
    expect(calls).toHaveLength(0);
  });
});

const TOKEN = "bridge-token-FAKE-0000000000000000";

async function call(path: string, body: unknown, oauthDeps: OAuthDeps, over: Partial<BridgeRequest> = {}) {
  const logLines: Record<string, unknown>[] = [];
  const res = await handleBridgeRequest(
    { method: "POST", path, authorization: `Bearer ${TOKEN}`, body, ...over },
    { serviceToken: TOKEN, store: new BridgeSessionStore(), oauthDeps, log: (l) => logLines.push(l) },
  );
  return Object.assign(res, { logLines });
}

// The routes serve the curated Atlassian hosts only (the egress registry is closed per vendor).
const A_MCP = "https://mcp.atlassian.com/v1/mcp/authv2";
const A_ISSUER = "https://auth.atlassian.com/tenant1";
const A_PRM = "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v1/mcp/authv2";
const A_AS = "https://auth.atlassian.com/.well-known/oauth-authorization-server/tenant1";
const A_TOKEN = "https://auth.atlassian.com/oauth/token";
const A_REGISTER = "https://auth.atlassian.com/tenant1/dcr/register";
const A_REVOKE = "https://auth.atlassian.com/oauth/revoke";

describe("/oauth/* routes", () => {
  const exchangeBody = {
    tokenEndpoint: A_TOKEN,
    clientId: "cid",
    code: FAKE_CODE,
    codeVerifier: VERIFIER,
    redirectUri: "https://box.example.test/api/mcp/oauth/callback",
    resource: A_MCP,
  };

  it("is bearer-gated", async () => {
    const { deps, calls } = net({ [A_TOKEN]: TOKENS });
    const res = await call("/oauth/exchange", exchangeBody, deps, { authorization: null });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("answers 405 for GET and 404 for an unknown action", async () => {
    const { deps } = net({});
    expect((await call("/oauth/exchange", undefined, deps, { method: "GET" })).status).toBe(405);
    expect((await call("/oauth/nope", {}, deps)).status).toBe(404);
  });

  it("refuses a bare code (no verifier) without dialing, naming the field", async () => {
    const { deps, calls } = net({ [A_TOKEN]: TOKENS });
    const { codeVerifier: _drop, ...bare } = exchangeBody;
    const res = await call("/oauth/exchange", bare, deps);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("codeVerifier");
    expect(calls).toHaveLength(0);
  });

  it("exchanges, and neither the log nor an error body carries the code, verifier or tokens", async () => {
    const ok = net({ [A_TOKEN]: TOKENS });
    const res = await call("/oauth/exchange", exchangeBody, ok.deps);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accessToken: "FAKE-ACCESS-0000", refreshToken: FAKE_REFRESH });
    expect(res.logLines).toEqual([{ method: "POST", path: "/oauth/exchange", status: 200 }]);

    const bad = net({ [A_TOKEN]: { status: 400, body: { error: "invalid_grant", error_description: FAKE_CODE } } });
    const res2 = await call("/oauth/exchange", exchangeBody, bad.deps);
    expect(res2.status).toBe(502);
    expect(res2.body).toMatchObject({ error: { code: "OAUTH_TOKEN_ERROR" }, oauthError: "invalid_grant" });
    const wire = JSON.stringify([res2.body, res2.logLines]);
    for (const secret of [FAKE_CODE, VERIFIER]) expect(wire).not.toContain(secret);
  });

  it("every route refuses a non-curated host, even when the body names it as allowed, and never dials", async () => {
    const evil = "https://evil.example/x";
    const named = { allowedHosts: ["evil.example"], allowedIssuerHosts: ["evil.example"] };
    const bodies: Array<[string, Record<string, unknown>]> = [
      ["/oauth/discover", { mcpUrl: evil }],
      ["/oauth/register", { registrationEndpoint: evil, redirectUris: ["https://box.example.test/api/mcp/oauth/callback"] }],
      ["/oauth/exchange", { ...exchangeBody, tokenEndpoint: evil }],
      ["/oauth/refresh", { tokenEndpoint: evil, clientId: "c", refreshToken: FAKE_REFRESH, resource: A_MCP }],
      ["/oauth/revoke", { revocationEndpoint: evil, clientId: "c", token: FAKE_REFRESH }],
    ];
    for (const [path, body] of bodies) {
      const { deps, calls } = net({ [evil]: TOKENS });
      const res = await call(path, { ...body, ...named }, deps);
      expect(res.status, path).toBe(422);
      expect(res.body, path).toMatchObject({ reason: "HOST_NOT_ALLOWED" });
      expect(calls, path).toHaveLength(0);
    }
  });

  it("maps a PKCE refusal to 422 OAUTH_PKCE_UNSUPPORTED", async () => {
    const meta = asMeta({ issuer: A_ISSUER });
    delete (meta.body as Record<string, unknown>).code_challenge_methods_supported;
    const { deps } = net({
      [A_PRM]: { body: { resource: A_MCP, authorization_servers: [A_ISSUER] } },
      [A_AS]: meta,
    });
    const res = await call("/oauth/discover", { mcpUrl: A_MCP }, deps);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: "OAUTH_PKCE_UNSUPPORTED" } });
  });

  it("refuses a resource other than the curated one on exchange and refresh, and never dials", async () => {
    for (const [path, body] of [
      ["/oauth/exchange", { ...exchangeBody, resource: "https://evil.example/" }],
      ["/oauth/refresh", { tokenEndpoint: A_TOKEN, clientId: "c", refreshToken: FAKE_REFRESH, resource: "https://mcp.atlassian.com/v1/mcp" }],
    ] as const) {
      const { deps, calls } = net({ [A_TOKEN]: TOKENS });
      const res = await call(path, body, deps);
      expect(res.status, path).toBe(422);
      expect(res.body, path).toMatchObject({ reason: "RESOURCE_NOT_ALLOWED" });
      expect(calls, path).toHaveLength(0);
    }
  });

  it("revoke sends client_secret when the client has one", async () => {
    const { deps, calls } = net({ [A_REVOKE]: { raw: "" } });
    const res = await call("/oauth/revoke", { revocationEndpoint: A_REVOKE, clientId: "c", clientSecret: "FAKE-SECRET", token: FAKE_REFRESH }, deps);
    expect(res.status).toBe(200);
    expect(form(calls[0]!).get("client_secret")).toBe("FAKE-SECRET");
  });

  it("registers, refreshes and revokes through the same guard", async () => {
    const { deps, calls } = net({
      [A_REGISTER]: { status: 201, body: { client_id: "new-client" } },
      [A_TOKEN]: TOKENS,
      [A_REVOKE]: { raw: "" },
    });
    const reg = await call("/oauth/register", { registrationEndpoint: A_REGISTER, redirectUris: ["https://box.example.test/api/mcp/oauth/callback"] }, deps);
    expect(reg).toMatchObject({ status: 200, body: { clientId: "new-client" } });
    const ref = await call("/oauth/refresh", { tokenEndpoint: A_TOKEN, clientId: "c", refreshToken: FAKE_REFRESH, resource: A_MCP }, deps);
    expect(ref.status).toBe(200);
    const rev = await call("/oauth/revoke", { revocationEndpoint: A_REVOKE, clientId: "c", token: FAKE_REFRESH }, deps);
    expect(rev).toMatchObject({ status: 200, body: { revoked: true } });
    expect(calls).toHaveLength(3);
  });
});
