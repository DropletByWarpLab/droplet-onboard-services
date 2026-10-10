/**
 * WARP-2405 / WARP-2401 — the sign-in flow's binding rules, each with a test
 * that goes red if its check is removed.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerDescriptor } from "@droplet/shared-types";
import { __setColumnCryptoKeyForTest, decryptColumn, deriveMcpOAuthTokenKey, mcpOAuthClientAad } from "../column-crypto.service.js";
import { createMcpOAuthRefresher } from "./mcp-oauth-refresh.service.js";
import { McpBridgeError } from "../mcp-bridge.client.js";
import {
  beginMcpSignIn, claimMcpHandoff, completeMcpSignIn, createMcpHandoff, disconnectMcpOAuth, readMcpHandoff,
  MCP_OAUTH_FLOW_TTL_MS, MCP_OAUTH_HANDOFF_TTL_MS, MCP_OAUTH_LOOPBACK_REDIRECTS,
  mcpOAuthDependencies, openTokens, parsePastedRedirect, storeMcpOAuthClient, McpOAuthError,
  type BeginInput, type McpOAuthDependencies,
} from "./mcp-oauth.service.js";
import { fakeMcpOAuthDb } from "./__tests__/fake-db.js";
import { recordActivity } from "../activity.singleton.js";

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock("../../lib/logger.js", () => {
  const sink = (...a: unknown[]) => { logged.push(a); };
  return { createLogger: () => ({ info: sink, warn: sink, error: sink, debug: sink }) };
});
vi.mock("../activity.singleton.js", () => ({ recordActivity: vi.fn(async (_p: Record<string, unknown>) => {}) }));
vi.mock("../../config.js", () => ({ config: { MCP_BRIDGE_URL: "http://bridge.invalid", MCP_BRIDGE_SERVICE_TOKEN: "t" } }));

const PROVIDER = "atlassian";
const signIn = providerDescriptor(PROVIDER)!.track === "mcp" ? (providerDescriptor(PROVIDER) as any).signIn : null;
const MCP_URL: string = signIn.mcpUrl;
const ISSUER = "https://auth.example/iss";
const ORIGIN_CB = "https://box.example/api/mcp/oauth/callback";
const DISC = {
  resource: MCP_URL, issuer: ISSUER, authorizationEndpoint: "https://auth.example/authorize",
  tokenEndpoint: "https://auth.example/oauth/token", registrationEndpoint: "https://auth.example/dcr",
  issParameterSupported: false,
};
const TOKENS = { accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET", expiresIn: 3600, scope: "read:me" };
const SITE = { id: "00000000-0000-4000-8000-00000000aaaa", url: "https://acme.atlassian.net", name: "Acme" };

type Egress = Awaited<ReturnType<McpOAuthDependencies["egress"]>>;
const ALLOWED: Egress = { allowed: true, row: null };

function setup(over: { discover?: any; disc?: Partial<typeof DISC> & { revocationEndpoint?: string }; egress?: Egress } = {}) {
  const db = fakeMcpOAuthDb();
  const oauth = {
    discover: vi.fn((over.discover ?? (async (_url: string) => ({ ...DISC, ...over.disc }))) as (url: string) => Promise<any>),
    register: vi.fn(async (_endpoint: string, _redirects: readonly string[]): Promise<{ clientId: string; clientSecret?: string }> => ({ clientId: "dcr-client" })),
    exchange: vi.fn(async (_input: unknown): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }> => ({ ...TOKENS })),
    refresh: vi.fn(async (_input: unknown): Promise<{ accessToken: string }> => ({ accessToken: "x" })),
    revoke: vi.fn(async (_input: unknown): Promise<void> => {}),
    sites: vi.fn(async (_accessToken: string): Promise<{ id: string; url: string; name: string }[]> => [{ ...SITE }]),
  };
  let now = new Date("2026-10-09T12:00:00Z");
  // The egress verdict is switchable mid-test: `gate.current = { allowed: false, ... }`.
  const gate = { current: over.egress ?? ALLOWED };
  const deps: McpOAuthDependencies = mcpOAuthDependencies({ oauth, now: () => now, pending: new Map(), egress: async () => gate.current });
  const begin = (o: Partial<BeginInput> = {}) => beginMcpSignIn(db.prisma, {
    provider: PROVIDER, scope: "MEMBER", userId: "u1", username: "alice", role: "family", originCallback: ORIGIN_CB, ...o,
  }, deps);
  const complete = (state: string | null, o: Record<string, unknown> = {}) => completeMcpSignIn(db.prisma, {
    state, code: "the-code", error: null, iss: null, browserState: state, caller: null, ...o,
  } as any, deps);
  return { db, oauth, deps, gate, begin, complete, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
const qs = (url: string) => new URL(url).searchParams;

beforeEach(() => {
  logged.length = 0;
  __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));
});

describe("beginMcpSignIn", () => {
  it("builds an S256 authorize URL with the resource, the exact descriptor scopes and an unguessable state", async () => {
    const { begin, oauth } = setup();
    const r = await begin();
    const p = qs(r.authorizeUrl);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("resource")).toBe(MCP_URL);
    expect(p.get("scope")).toBe(signIn.scopes.join(" ")); // never widened
    expect(p.get("state")).toBe(r.state);
    expect(r.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("redirect_uri")).toBe(ORIGIN_CB);
    expect(oauth.discover).toHaveBeenCalledWith(MCP_URL);
  });

  it("walks the identity ladder in order: a held client beats dynamic registration; DCR only when none is held", async () => {
    const held = setup();
    await held.db.prisma.mcpOAuthClient.create({ data: { provider: PROVIDER, issuer: ISSUER, clientId: "held-client", source: "PASTED" } });
    const a = await held.begin();
    expect(qs(a.authorizeUrl).get("client_id")).toBe("held-client");
    expect(held.oauth.register).not.toHaveBeenCalled();

    const none = setup();
    const b = await none.begin();
    expect(none.oauth.register).toHaveBeenCalledTimes(1);
    expect(none.oauth.register).toHaveBeenCalledWith(DISC.registrationEndpoint, [ORIGIN_CB, ...MCP_OAUTH_LOOPBACK_REDIRECTS]);
    expect(qs(b.authorizeUrl).get("client_id")).toBe("dcr-client");
    expect(JSON.stringify(logged)).toContain("cimd_unsupported_v1");

    // A client for a DIFFERENT issuer is never reused across servers.
    const other = setup();
    await other.db.prisma.mcpOAuthClient.create({ data: { provider: PROVIDER, issuer: "https://elsewhere.example/iss", clientId: "other-issuer", source: "PASTED" } });
    await other.begin();
    expect(other.oauth.register).toHaveBeenCalledTimes(1);
  });

  it("uses a client an admin stored, and asks for one when the server offers no registration", async () => {
    const s = setup();
    await storeMcpOAuthClient(s.db.prisma, { provider: PROVIDER, clientId: "pasted", clientSecret: "pasted-secret", userId: "admin1" }, s.deps);
    const r = await s.begin();
    expect(qs(r.authorizeUrl).get("client_id")).toBe("pasted");
    expect(s.oauth.register).not.toHaveBeenCalled();
    expect(s.db.clients[0].clientSecretEnc).toMatch(/^dcv1:/);
    expect(s.db.clients[0]).toMatchObject({ source: "PASTED", updatedBy: "admin1" });

    const noReg = setup({ disc: { registrationEndpoint: undefined } });
    await expect(noReg.begin()).rejects.toMatchObject({ code: "client_required" });
  });

  it("refuses a server without PKCE S256 and writes nothing", async () => {
    const s = setup({ discover: async () => { throw new McpBridgeError("OAUTH_PKCE_UNSUPPORTED", "no S256", 422); } });
    await expect(s.begin()).rejects.toMatchObject({ code: "pkce_unsupported", status: 400 });
    expect(s.db.rows).toHaveLength(0);
    expect(s.oauth.register).not.toHaveBeenCalled();
  });

  it("refuses discovery that names another resource or a non-https endpoint", async () => {
    await expect(setup({ disc: { resource: "https://other.example/mcp" } }).begin()).rejects.toMatchObject({ code: "sign_in_unavailable" });
    await expect(setup({ disc: { tokenEndpoint: "http://auth.example/token" } }).begin()).rejects.toMatchObject({ code: "sign_in_unavailable" });
  });

  it("requires the acknowledgement and an admin for a Workspace connection; guests and services never sign in", async () => {
    const s = setup();
    await expect(s.begin({ scope: "WORKSPACE", role: "admin" })).rejects.toMatchObject({ code: "acknowledge_required", status: 400 });
    await expect(s.begin({ scope: "WORKSPACE", role: "family", acknowledge: true })).rejects.toMatchObject({ code: "forbidden", status: 403 });
    for (const role of ["guest", "service", undefined]) {
      await expect(s.begin({ role })).rejects.toMatchObject({ code: "forbidden", status: 403 });
    }
    expect(s.db.rows).toHaveLength(0);
    await s.begin({ scope: "WORKSPACE", role: "admin", acknowledge: true, username: "boss" });
    expect(s.db.rows[0]).toMatchObject({ scope: "WORKSPACE", memberId: null, workspaceAckBy: "boss", state: "PENDING_CONSENT" });
  });

  it("rejects a provider that has no web sign-in", async () => {
    await expect(setup().begin({ provider: "stripe" })).rejects.toMatchObject({ code: "unknown_provider" });
  });
});

describe("completeMcpSignIn", () => {
  it("exchanges with the resource, the PKCE verifier that matches the challenge and the redirect, then seals the tokens", async () => {
    const s = setup();
    const r = await s.begin();
    const challenge = qs(r.authorizeUrl).get("code_challenge");
    const out = await s.complete(r.state);
    expect(out).toMatchObject({ outcome: "connected", provider: PROVIDER, scope: "MEMBER" });
    const call = s.oauth.exchange.mock.calls[0][0] as any;
    expect(call).toMatchObject({ code: "the-code", resource: MCP_URL, redirectUri: ORIGIN_CB, tokenEndpoint: DISC.tokenEndpoint, clientId: "dcr-client" });
    expect(createHash("sha256").update(call.codeVerifier).digest("base64url")).toBe(challenge);
    const row = s.db.rows[0];
    expect(row.state).toBe("CONNECTED");
    expect(row.tokenExpiresAt).toEqual(new Date("2026-10-09T13:00:00Z"));
    expect(row.tokensEnc).toMatch(/^dcv1:/);
    expect(row.tokensEnc).not.toContain("ACCESS-SECRET");
    expect(openTokens(row)).toMatchObject({ accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET", resource: MCP_URL, mcpUrl: MCP_URL });
  });

  describe("the site comes from the token (WARP-3961)", () => {
    const SITE_B = { id: "00000000-0000-4000-8000-00000000bbbb", url: "https://beta.atlassian.net", name: "Beta" };
    const SITE_C = { id: "00000000-0000-4000-8000-00000000cccc", url: "https://gamma.atlassian.net", name: "Gamma" };

    it("one site: asks with the fresh access token, stores and pins it", async () => {
      const s = setup();
      const r = await s.begin();
      expect((await s.complete(r.state)).outcome).toBe("connected");
      expect(s.oauth.sites).toHaveBeenCalledWith("ACCESS-SECRET");
      expect(s.db.rows[0]).toMatchObject({
        state: "CONNECTED", siteId: SITE.id, siteUrl: SITE.url, siteName: SITE.name, sites: [SITE],
      });
    });

    it("several sites: pins the first, keeps all of them, and warns", async () => {
      const s = setup();
      s.oauth.sites.mockResolvedValueOnce([SITE, SITE_B, SITE_C]);
      const r = await s.begin();
      expect((await s.complete(r.state)).outcome).toBe("connected");
      expect(s.db.rows[0]).toMatchObject({ state: "CONNECTED", siteId: SITE.id, siteName: SITE.name });
      expect(s.db.rows[0].sites).toEqual([SITE, SITE_B, SITE_C]);
      expect(JSON.stringify(logged)).toContain("mcp_oauth_multiple_sites_pinned_first");
    });

    it("zero sites: the sign-in fails, no tokens are stored, the grant is revoked and the row ends in ERROR", async () => {
      const s = setup({ disc: { revocationEndpoint: "https://auth.example/oauth/revoke" } });
      s.oauth.sites.mockResolvedValueOnce([]);
      const r = await s.begin();
      expect((await s.complete(r.state)).outcome).toBe("failed");
      expect(s.db.rows[0]).toMatchObject({ state: "ERROR", lastError: "no_site", tokensEnc: null, siteId: null });
      expect(s.oauth.revoke).toHaveBeenCalledTimes(1);
      expect(s.oauth.revoke.mock.calls[0]![0]).toMatchObject({ revocationEndpoint: "https://auth.example/oauth/revoke", token: "REFRESH-SECRET" });
    });

    it("zero sites on a re-consent keeps the working sign-in (tokens and site) and records the error", async () => {
      const s = setup();
      const first = await s.begin();
      await s.complete(first.state);
      s.oauth.sites.mockResolvedValueOnce([]);
      const again = await s.begin();
      expect((await s.complete(again.state)).outcome).toBe("failed");
      expect(s.db.rows[0]).toMatchObject({ state: "CONNECTED", lastError: "no_site", siteId: SITE.id });
      expect(openTokens(s.db.rows[0]).accessToken).toBe("ACCESS-SECRET");
    });

    it("a failed site lookup fails the sign-in, restores the prior state and stores nothing", async () => {
      const s = setup();
      s.oauth.sites.mockRejectedValueOnce(new Error("SITES-LEAK"));
      const r = await s.begin();
      expect((await s.complete(r.state)).outcome).toBe("failed");
      expect(s.db.rows[0]).toMatchObject({ state: "DISCONNECTED", lastError: "site_lookup_failed", tokensEnc: null, siteId: null });
      expect(JSON.stringify(logged)).not.toContain("SITES-LEAK");
    });

    it("disconnect clears the pinned site", async () => {
      const s = setup();
      const r = await s.begin();
      await s.complete(r.state);
      await disconnectMcpOAuth(s.db.prisma, s.db.rows[0].id, { id: "u1", role: "family" });
      expect(s.db.rows[0]).toMatchObject({ state: "DISCONNECTED", siteId: null, siteUrl: null, siteName: null });
    });
  });

  it("stores a scope the server granted beyond the request as granted, and never asks for more", async () => {
    const s = setup();
    s.oauth.exchange.mockResolvedValueOnce({ ...TOKENS, scope: "read:me write:extra" });
    const r = await s.begin();
    await s.complete(r.state);
    expect(openTokens(s.db.rows[0]).scope).toBe("read:me write:extra");
    expect(qs(r.authorizeUrl).get("scope")).toBe(signIn.scopes.join(" "));
  });

  it("rejects a callback whose state does not match the browser's cookie, without consuming the flow", async () => {
    const s = setup();
    const r = await s.begin();
    expect((await s.complete(r.state, { browserState: "attacker-state" })).outcome).toBe("failed");
    expect((await s.complete(r.state, { browserState: null })).outcome).toBe("failed");
    expect(s.oauth.exchange).not.toHaveBeenCalled();
    expect((await s.complete(r.state)).outcome).toBe("connected");
  });

  it("rejects a state the box never issued", async () => {
    const s = setup();
    await s.begin();
    expect((await s.complete("forged-state")).outcome).toBe("failed");
    expect(s.oauth.exchange).not.toHaveBeenCalled();
  });

  it("makes state single-use: a replayed valid callback is rejected", async () => {
    const s = setup();
    const r = await s.begin();
    expect((await s.complete(r.state)).outcome).toBe("connected");
    expect((await s.complete(r.state)).outcome).toBe("failed");
    expect(s.oauth.exchange).toHaveBeenCalledTimes(1);
  });

  it("rejects an issuer that differs from the discovered one (RFC 9207), in its own test", async () => {
    const s = setup();
    const r = await s.begin();
    expect((await s.complete(r.state, { iss: "https://evil.example/iss" })).outcome).toBe("failed");
    expect(s.oauth.exchange).not.toHaveBeenCalled();
    expect(s.db.rows[0].state).toBe("DISCONNECTED"); // prior state restored
    const ok = await s.begin();
    expect((await s.complete(ok.state, { iss: ISSUER })).outcome).toBe("connected");
  });

  it("requires iss when the authorization server advertised it, and refuses without", async () => {
    const s = setup({ disc: { issParameterSupported: true } });
    const r = await s.begin();
    expect((await s.complete(r.state, { iss: null })).outcome).toBe("failed");
    expect(s.oauth.exchange).not.toHaveBeenCalled();
  });

  it("treats access_denied as cancelled and an expired flow as expired, restoring the prior state", async () => {
    const s = setup();
    const a = await s.begin();
    expect((await s.complete(a.state, { code: null, error: "access_denied" })).outcome).toBe("cancelled");
    expect(s.db.rows[0].state).toBe("DISCONNECTED");
    const b = await s.begin();
    s.advance(MCP_OAUTH_FLOW_TTL_MS + 1);
    expect((await s.complete(b.state)).outcome).toBe("expired");
    expect(s.oauth.exchange).not.toHaveBeenCalled();
  });

  it("keeps a connected member's tokens when a re-consent fails", async () => {
    const s = setup();
    const first = await s.begin();
    await s.complete(first.state);
    const again = await s.begin();
    expect(s.db.rows[0].state).toBe("PENDING_CONSENT");
    await s.complete(again.state, { code: null, error: "access_denied" });
    expect(s.db.rows[0].state).toBe("CONNECTED");
    expect(openTokens(s.db.rows[0]).accessToken).toBe("ACCESS-SECRET");
  });

  it("fails and restores the state when the exchange fails, with no secret in the stored error", async () => {
    const s = setup();
    s.oauth.exchange.mockRejectedValueOnce(new Error("invalid_grant the-code"));
    const r = await s.begin();
    expect((await s.complete(r.state)).outcome).toBe("failed");
    expect(s.db.rows[0]).toMatchObject({ state: "DISCONNECTED", lastError: "sign_in_failed", tokensEnc: null });
  });

  it("paste: only the person who started it completes it; a Workspace sign-in only while still an admin", async () => {
    const s = setup();
    const r = await s.begin();
    expect((await s.complete(r.state, { browserState: null, caller: { id: "someone-else", role: "family" } })).outcome).toBe("failed");
    const r2 = await s.begin();
    expect((await s.complete(r2.state, { browserState: null, caller: { id: "u1", role: "family" } })).outcome).toBe("connected");

    const w = setup();
    const ws = await w.begin({ scope: "WORKSPACE", role: "admin", acknowledge: true });
    expect((await w.complete(ws.state, { browserState: null, caller: { id: "u1", role: "family" } })).outcome).toBe("failed");
  });

  it("uses the loopback redirect when the box origin is not https, and the exchange carries that same redirect", async () => {
    const s = setup();
    const r = await s.begin({ originCallback: "http://192.168.1.5/api/mcp/oauth/callback" });
    expect(r.redirectUri).toBe("http://127.0.0.1/api/mcp/oauth/callback");
    await s.complete(r.state);
    expect((s.oauth.exchange.mock.calls[0][0] as any).redirectUri).toBe(r.redirectUri);
  });

  it("never logs a code, a state, a verifier or a token", async () => {
    const s = setup();
    const a = await s.begin();
    await s.complete(a.state, { iss: "https://evil.example/iss", code: "LEAKY-CODE-1" });
    s.oauth.exchange.mockRejectedValueOnce(new Error("LEAKY-ERR"));
    const b = await s.begin();
    await s.complete(b.state, { code: "LEAKY-CODE-2" });
    const c = await s.begin();
    await s.complete(c.state, { code: "LEAKY-CODE-3" });
    const flat = JSON.stringify(logged);
    for (const secret of [a.state, b.state, c.state, "LEAKY-CODE-1", "LEAKY-CODE-2", "LEAKY-CODE-3", "ACCESS-SECRET", "REFRESH-SECRET", "LEAKY-ERR"]) {
      expect(flat).not.toContain(secret);
    }
  });
});

describe("the same egress rule as every remote MCP call, before every hop (WARP-3960: only the per-server off)", () => {
  const REFUSALS: [string, Egress, string][] = [
    ["an admin turned the connection off", { allowed: false, reason: "connection_disabled", message: "off" }, "connection_disabled"],
  ];
  const bridgeCalls = (s: ReturnType<typeof setup>) =>
    s.oauth.discover.mock.calls.length + s.oauth.register.mock.calls.length + s.oauth.exchange.mock.calls.length;

  it.each(REFUSALS)("start makes ZERO bridge calls when %s, and answers a fixed 409 code", async (_n, egress, code) => {
    const s = setup({ egress });
    await expect(s.begin()).rejects.toMatchObject({ code, status: 409 });
    expect(bridgeCalls(s)).toBe(0);
    expect(s.db.rows).toHaveLength(0);
  });

  it.each(REFUSALS)("the pre-registered client setup makes ZERO bridge calls when %s", async (_n, egress, code) => {
    const s = setup({ egress });
    await expect(storeMcpOAuthClient(s.db.prisma, { provider: PROVIDER, clientId: "c", userId: "a1" }, s.deps)).rejects.toMatchObject({ code });
    expect(bridgeCalls(s)).toBe(0);
  });

  it.each(REFUSALS)("callback and paste make ZERO exchange calls when %s, burn the state and answer blocked", async (_n, egress) => {
    const s = setup();
    const a = await s.begin();
    s.gate.current = egress; // switched off between start and callback
    expect(await s.complete(a.state)).toMatchObject({ outcome: "blocked", provider: PROVIDER });
    expect(s.oauth.exchange).not.toHaveBeenCalled();
    expect(s.db.rows[0].state).toBe("DISCONNECTED"); // prior state restored, tokens untouched
    s.gate.current = ALLOWED;
    expect((await s.complete(a.state)).outcome).toBe("failed"); // burned: cannot be retried

    s.gate.current = ALLOWED;
    const b = await s.begin();
    s.gate.current = egress;
    expect((await s.complete(b.state, { browserState: null, caller: { id: "u1", role: "family" } })).outcome).toBe("blocked");
    expect(s.oauth.exchange).not.toHaveBeenCalled();
  });

  it("an unreadable gate is a generic 503 sign_in_unavailable, never a switch-shaped code", async () => {
    const s = setup({ egress: { allowed: false, reason: "gate_unavailable", message: "" } });
    await expect(s.begin()).rejects.toMatchObject({ code: "sign_in_unavailable", status: 503 });
    expect(bridgeCalls(s)).toBe(0);
  });

  it("a read failure of the rules refuses too", async () => {
    const s = setup();
    const a = await s.begin();
    s.deps.egress = async () => { throw new Error("db down"); };
    expect((await s.complete(a.state)).outcome).toBe("blocked");
    expect(s.oauth.exchange).not.toHaveBeenCalled();
  });
});

describe("review fixes: abandoned consent, the starter's current standing, client changes", () => {
  it("an abandoned re-consent is settled when its flow expires, never stranded in PENDING_CONSENT", async () => {
    const s = await (async () => {
      const x = setup();
      const first = await x.begin();
      await x.complete(first.state); // u1 is CONNECTED
      return x;
    })();
    await s.begin(); // re-consent begins: the row is PENDING_CONSENT and the person walks away
    expect(s.db.rows[0].state).toBe("PENDING_CONSENT");
    s.advance(MCP_OAUTH_FLOW_TTL_MS + 1);
    await s.begin({ userId: "u2" }); // any later start prunes the expired flow
    expect(s.db.rows.find((r) => r.memberId === "u1")!.state).toBe("CONNECTED"); // back to what it was, tokens intact
    expect(openTokens(s.db.rows.find((r) => r.memberId === "u1")!).accessToken).toBe("ACCESS-SECRET");
  });

  it("a Workspace flow started by an admin who was demoted mid-flow is refused, on callback and on paste", async () => {
    const s = setup();
    s.db.setUser({ id: "a1", role: "admin" });
    const a = await s.begin({ scope: "WORKSPACE", role: "admin", acknowledge: true, userId: "a1" });
    s.db.setUser({ id: "a1", role: "family" });
    expect((await s.complete(a.state)).outcome).toBe("failed");
    expect(s.oauth.exchange).not.toHaveBeenCalled();
    expect(s.db.rows.find((r) => r.scope === "WORKSPACE")!.state).not.toBe("CONNECTED");

    s.db.setUser({ id: "a1", role: "admin" });
    const b = await s.begin({ scope: "WORKSPACE", role: "admin", acknowledge: true, userId: "a1" });
    s.db.setUser({ id: "a1", role: "family" });
    // the paste caller's session still says admin; the database is what counts
    expect((await s.complete(b.state, { browserState: null, caller: { id: "a1", role: "admin" } })).outcome).toBe("failed");
    expect(s.oauth.exchange).not.toHaveBeenCalled();
  });

  it("a starter who was deactivated, or is being deleted, is refused before the exchange", async () => {
    for (const patch of [{ directoryStatus: "DEACTIVATED" }, { deletionStatus: "PENDING" }]) {
      const s = setup();
      const a = await s.begin();
      s.db.setUser({ id: "u1", role: "family", ...patch });
      expect((await s.complete(a.state)).outcome, JSON.stringify(patch)).toBe("failed");
      expect(s.oauth.exchange).not.toHaveBeenCalled();
    }
  });

  it("an admin changes the client while members are signed in: it is stored once, the next start uses it, signed-in rows are untouched, and re-consent writes it into the row", async () => {
    const s = setup();
    const first = await s.begin();
    await s.complete(first.state); // u1 holds tokens, issued to the registered "dcr-client"
    vi.mocked(recordActivity).mockClear();
    await storeMcpOAuthClient(s.db.prisma, { provider: PROVIDER, clientId: "new-client", clientSecret: "SECRET-X", userId: "admin1" }, s.deps);

    expect(s.db.clients).toHaveLength(1);
    expect(s.db.clients[0]).toMatchObject({ clientId: "new-client", source: "PASTED" }); // PASTED replaced the DCR record
    const u1 = s.db.rows.find((r) => r.memberId === "u1")!;
    expect(u1).toMatchObject({ clientId: "dcr-client", state: "CONNECTED" }); // untouched: its refresh still works
    const audit = vi.mocked(recordActivity).mock.calls.map((c) => c[0]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: "auth", refs: expect.objectContaining({ connector: PROVIDER, change: "client" }) });
    expect(JSON.stringify(audit)).not.toMatch(/SECRET-X|new-client/);

    // The NEXT start uses the new client (not the oldest row's)...
    const second = await s.begin({ userId: "u2" });
    expect(qs(second.authorizeUrl).get("client_id")).toBe("new-client");
    await s.complete(second.state);
    expect((s.oauth.exchange.mock.calls[1]![0] as { clientId: string; clientSecret?: string })).toMatchObject({ clientId: "new-client", clientSecret: "SECRET-X" });
    expect(s.db.rows.find((r) => r.memberId === "u2")).toMatchObject({ clientId: "new-client" });

    // ...and a re-consent writes the client it used into the row with the new tokens.
    const again = await s.begin();
    expect(s.db.rows.find((r) => r.memberId === "u1")!.clientId).toBe("dcr-client"); // not yet: the old tokens are still held
    await s.complete(again.state);
    expect(s.db.rows.find((r) => r.memberId === "u1")!.clientId).toBe("new-client");
  });

  it("a signed-in row's refresh uses ITS OWN client, whatever the provider's client is now", async () => {
    const s = setup();
    const first = await s.begin();
    await s.complete(first.state);
    await storeMcpOAuthClient(s.db.prisma, { provider: PROVIDER, clientId: "new-client", userId: "admin1" }, s.deps);
    const refresh = vi.fn(async (_i: unknown) => ({ accessToken: "renewed", refreshToken: "r2", expiresIn: 3600 }));
    const refresher = createMcpOAuthRefresher({
      prisma: s.db.prisma, oauth: { refresh } as never, egress: async () => ({ allowed: true, row: null }),
    });
    expect(await refresher.refreshNow(s.db.rows[0].id)).toBe("refreshed");
    expect(refresh.mock.calls[0]![0]).toMatchObject({ clientId: "dcr-client" });
  });

  it("a leaver's old CONNECTED row does not decide the client new sign-ins get", async () => {
    const s = setup();
    const first = await s.begin();
    await s.complete(first.state); // u1, registered "dcr-client"
    s.db.setUser({ id: "u1", directoryStatus: "DEACTIVATED" }); // the oldest row now belongs to a leaver and never leaves CONNECTED
    await storeMcpOAuthClient(s.db.prisma, { provider: PROVIDER, clientId: "new-client", userId: "admin1" }, s.deps);
    const next = await s.begin({ userId: "u3" });
    expect(qs(next.authorizeUrl).get("client_id")).toBe("new-client");
  });

  it("a registration is stored once and reused, and never overwrites a pasted client", async () => {
    const s = setup();
    const a = await s.begin();
    const b = await s.begin({ userId: "u2" });
    expect(s.oauth.register).toHaveBeenCalledTimes(1); // the second start reuses the stored registration
    expect(s.db.clients).toHaveLength(1);
    expect(s.db.clients[0]).toMatchObject({ clientId: "dcr-client", source: "DCR", updatedBy: null });
    expect(qs(a.authorizeUrl).get("client_id")).toBe(qs(b.authorizeUrl).get("client_id"));

    await storeMcpOAuthClient(s.db.prisma, { provider: PROVIDER, clientId: "pasted", userId: "admin1" }, s.deps);
    expect(s.db.clients[0]).toMatchObject({ clientId: "pasted", source: "PASTED", updatedBy: "admin1" });
    const c = await s.begin({ userId: "u3" });
    expect(qs(c.authorizeUrl).get("client_id")).toBe("pasted"); // PASTED wins; no new registration
    expect(s.oauth.register).toHaveBeenCalledTimes(1);
  });

  it("the client secret is sealed under its own record: it opens nowhere else", async () => {
    const s = setup();
    await storeMcpOAuthClient(s.db.prisma, { provider: PROVIDER, clientId: "c", clientSecret: "SECRET-Y", userId: "admin1" }, s.deps);
    const rec = s.db.clients[0];
    expect(rec.clientSecretEnc).toMatch(/^dcv1:/);
    expect(rec.clientSecretEnc).not.toContain("SECRET-Y");
    expect(() => decryptColumn(deriveMcpOAuthTokenKey(), rec.clientSecretEnc, mcpOAuthClientAad({ ...rec, id: "another-record" }))).toThrow();
    expect(decryptColumn(deriveMcpOAuthTokenKey(), rec.clientSecretEnc, mcpOAuthClientAad(rec))).toBe("SECRET-Y");
  });
});

describe("parsePastedRedirect", () => {
  it("accepts a full callback address on the box or on loopback", () => {
    expect(parsePastedRedirect("https://box.example/api/mcp/oauth/callback?code=c&state=s&iss=i")).toEqual({ state: "s", code: "c", error: null, iss: "i" });
    expect(parsePastedRedirect("  http://127.0.0.1/api/mcp/oauth/callback?error=access_denied&state=s ")).toMatchObject({ error: "access_denied", code: null });
  });

  it("rejects a bare code", () => {
    expect(() => parsePastedRedirect("abc123")).toThrowError(McpOAuthError);
    try { parsePastedRedirect("abc123"); } catch (e) { expect((e as McpOAuthError).code).toBe("bare_code_rejected"); expect((e as McpOAuthError).status).toBe(400); }
  });

  it.each([
    "https://box.example/somewhere/else?code=c&state=s",
    "https://box.example/api/mcp/oauth/callback?code=c",
    "https://box.example/api/mcp/oauth/callback?state=s",
    "https://box.example/api/mcp/oauth/callback?code=c&code=d&state=s",
    "https://u:p@box.example/api/mcp/oauth/callback?code=c&state=s",
    "javascript:alert(1)",
    `https://box.example/api/mcp/oauth/callback?code=${"a".repeat(5000)}&state=s`,
  ])("rejects %#", (text) => {
    expect(() => parsePastedRedirect(text)).toThrowError(McpOAuthError);
  });
});

describe("token blob binding and disconnect", () => {
  it("opens only under the row and owner it was sealed for", async () => {
    const s = setup();
    const r = await s.begin();
    await s.complete(r.state);
    const row = s.db.rows[0];
    expect(() => openTokens({ ...row, memberId: "u2" })).toThrow();
    expect(() => openTokens({ ...row, id: "another-row" })).toThrow();
  });

  it("lets a member disconnect their own row but not another's; only an admin disconnects a Workspace row", async () => {
    const s = setup();
    const m = await s.begin();
    await s.complete(m.state);
    const id = s.db.rows[0].id;
    expect(await disconnectMcpOAuth(s.db.prisma, id, { id: "u2", role: "family" })).toBe(false);
    expect(s.db.rows[0].state).toBe("CONNECTED");
    expect(await disconnectMcpOAuth(s.db.prisma, id, { id: "u1", role: "family" })).toBe(true);
    expect(s.db.rows[0]).toMatchObject({ state: "DISCONNECTED", tokensEnc: null, tokenExpiresAt: null });

    const w = await s.begin({ scope: "WORKSPACE", role: "admin", acknowledge: true });
    await s.complete(w.state, { browserState: w.state });
    const wid = s.db.rows.find((r) => r.scope === "WORKSPACE")!.id;
    expect(await disconnectMcpOAuth(s.db.prisma, wid, { id: "u1", role: "family" })).toBe(false);
    expect(await disconnectMcpOAuth(s.db.prisma, wid, { id: "a1", role: "admin" })).toBe(true);
  });
});

describe("browser handoff (WARP-3963)", () => {
  const mint = (s: ReturnType<typeof setup>, o: Record<string, unknown> = {}) =>
    createMcpHandoff(s.db.prisma, { provider: PROVIDER, scope: "MEMBER", userId: "u1", role: "family", ...o } as any, s.deps);
  const alice = { id: "u1", role: "family" };

  it("is stored hashed, and expires after five minutes (read and claim both refuse with handoff_invalid)", async () => {
    const s = setup();
    const { id } = await mint(s);
    expect([...s.deps.handoffs.keys()]).toEqual([createHash("sha256").update(id).digest("hex")]);
    s.advance(MCP_OAUTH_HANDOFF_TTL_MS - 1);
    expect(readMcpHandoff(id, alice, s.deps).provider).toBe(PROVIDER);
    s.advance(1);
    expect(() => readMcpHandoff(id, alice, s.deps)).toThrow(expect.objectContaining({ code: "handoff_invalid", status: 404 }));
    expect(() => claimMcpHandoff(id, alice, s.deps)).toThrow(expect.objectContaining({ code: "handoff_invalid" }));
  });

  it("claim is single use; a read never consumes; another member is refused and does not burn it", async () => {
    const s = setup();
    const { id } = await mint(s);
    readMcpHandoff(id, alice, s.deps);
    expect(() => claimMcpHandoff(id, { id: "u2", role: "owner" }, s.deps)).toThrow(expect.objectContaining({ code: "handoff_wrong_member", status: 403 }));
    expect(claimMcpHandoff(id, alice, s.deps)).toEqual({ provider: PROVIDER, scope: "MEMBER", acknowledge: false });
    expect(() => claimMcpHandoff(id, alice, s.deps)).toThrow(expect.objectContaining({ code: "handoff_invalid" }));
  });

  it("a WORKSPACE handoff needs an owner or admin and the acknowledgement at mint time", async () => {
    const s = setup();
    await expect(mint(s, { scope: "WORKSPACE", role: "family", acknowledge: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(mint(s, { scope: "WORKSPACE", role: "admin" })).rejects.toMatchObject({ code: "acknowledge_required" });
    await expect(mint(s, { role: "guest" })).rejects.toMatchObject({ code: "forbidden" });
    const { id } = await mint(s, { scope: "WORKSPACE", role: "admin", acknowledge: true });
    expect(claimMcpHandoff(id, { id: "u1", role: "admin" }, s.deps)).toMatchObject({ scope: "WORKSPACE", acknowledge: true });
  });

  it("minting is refused while the server is turned off, and a returnTo is carried to the callback result", async () => {
    const s = setup({ egress: { allowed: false, reason: "connection_disabled", message: "off" } as any });
    await expect(mint(s)).rejects.toMatchObject({ code: "connection_disabled" });
    s.gate.current = ALLOWED;
    const r = await s.begin({ returnTo: "/connectors/mcp/connected" });
    expect((await s.complete(r.state)).returnTo).toBe("/connectors/mcp/connected");
    const r2 = await s.begin();
    expect((await s.complete(r2.state)).returnTo).toBeNull();
  });
});
