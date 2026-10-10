import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request, { type Test } from "supertest";
import { providerDescriptor } from "@droplet/shared-types";
import { __setColumnCryptoKeyForTest } from "../services/column-crypto.service.js";
import { mcpOAuthDependencies, type McpOAuthDependencies } from "../services/mcp-oauth/mcp-oauth.service.js";
import { fakeMcpOAuthDb } from "../services/mcp-oauth/__tests__/fake-db.js";
import { createRequestLogger } from "../middleware/request-logger.js";
import { createMcpOAuthCallbackRouter, createMcpOAuthRouter, createMcpOAuthRouters, MCP_OAUTH_STATE_COOKIE } from "./mcp-oauth.js";

vi.mock("../config.js", () => ({ config: {
  AUTH_ENABLED: true, SERVICE_TOKEN_EMAIL: "email-service-secret", SERVICE_TOKEN_VOICE: "voice-service-secret", DROPLET_LAN_HOSTNAME: "box.customer.com", WIREGUARD_ENDPOINT_HOST: "",
  corsAllowedOrigins: ["https://droplet-ai.local"], agentMaxIter: { defaultIter: 5, capIter: 10 },
  MCP_BRIDGE_URL: "http://bridge.invalid", MCP_BRIDGE_SERVICE_TOKEN: "t",
} }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn(async () => {}) }));

const MCP_URL: string = (providerDescriptor("atlassian") as unknown as { signIn: { mcpUrl: string } }).signIn.mcpUrl;

const ISSUER = "https://auth.example/iss";
function setup(logDest?: { write(s: string): void }) {
  const db = fakeMcpOAuthDb();
  const oauth = {
    discover: vi.fn(async (_u: string) => ({
      resource: MCP_URL, issuer: ISSUER, authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token", registrationEndpoint: "https://auth.example/dcr", issParameterSupported: false,
    })),
    register: vi.fn(async (_e: string, _r: readonly string[]) => ({ clientId: "client-1" })),
    exchange: vi.fn(async (_i: unknown) => ({ accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET", expiresIn: 3600 })),
    refresh: vi.fn(async (_i: unknown): Promise<{ accessToken: string }> => ({ accessToken: "x" })),
    revoke: vi.fn(async (_i: unknown): Promise<void> => {}),
  };
  const closeSession = vi.fn(async (_p: string, _c: string): Promise<void> => {});
  const gate: { current: Awaited<ReturnType<McpOAuthDependencies["egress"]>> } = { current: { allowed: true, row: null } };
  const deps: McpOAuthDependencies = mcpOAuthDependencies({ oauth, closeSession, catalogChanged: async () => {}, egress: async () => gate.current });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  if (logDest) app.use(createRequestLogger({ dest: logDest as never, level: "info" }));
  app.use("/api", createMcpOAuthCallbackRouter(db.prisma, deps));
  app.use((req, _res, next) => {
    const role = req.headers["x-test-role"];
    const id = req.headers["x-test-id"];
    if (typeof role === "string" && typeof id === "string") req.user = { id, username: "alice", displayName: "Alice", role: role as "family" };
    next();
  });
  app.use("/api", createMcpOAuthRouter(db.prisma, deps));
  return { app, db, oauth, closeSession, gate };
}
const asUser = (call: Test, role = "family", id = "u1") => call.set("x-test-role", role).set("x-test-id", id);
const start = (app: express.Express, body: object = { provider: "atlassian", scope: "MEMBER" }, role = "family") =>
  asUser(request(app).post("/api/mcp/oauth/start"), role).send(body);
const cookieOf = (res: request.Response): string => {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.find((c) => c.startsWith(`${MCP_OAUTH_STATE_COOKIE}=`)) ?? "";
};

describe("MCP OAuth routes", () => {
  beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64")));
  afterEach(() => __setColumnCryptoKeyForTest(null));

  it("start returns only browser navigation data and sets a state cookie scoped to the flow", async () => {
    const { app } = setup();
    const res = await start(app);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["authorizeUrl", "expiresAt", "redirectUri"]);
    expect(res.body.redirectUri).toBe("https://box.customer.com/api/mcp/oauth/callback");
    const c = cookieOf(res);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Path=\/api\/mcp\/oauth/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).not.toMatch(/ACCESS-SECRET|code_verifier/);
  });

  it("start: a guest gets 403, a Workspace connection needs the acknowledgement, bodies are strict", async () => {
    const { app, db } = setup();
    expect((await start(app, undefined, "guest")).status).toBe(403);
    expect((await start(app, undefined, "service")).status).toBe(403);
    const noAck = await start(app, { provider: "atlassian", scope: "WORKSPACE" }, "admin");
    expect(noAck.status).toBe(400);
    expect(noAck.body.error).toBe("acknowledge_required");
    expect((await start(app, { provider: "atlassian", scope: "MEMBER", memberId: "someone-else" })).status).toBe(400);
    expect((await start(app, { provider: "stripe", scope: "MEMBER" })).status).toBe(404);
    expect((await request(app).post("/api/mcp/oauth/start").send({ provider: "atlassian", scope: "MEMBER" })).status).toBe(403);
    expect(db.rows).toHaveLength(0);
  });

  it("start: a server without PKCE S256 is a 400 pkce_unsupported", async () => {
    const { app, oauth } = setup();
    const { McpBridgeError } = await import("../services/mcp-bridge.client.js");
    oauth.discover.mockRejectedValueOnce(new McpBridgeError("OAUTH_PKCE_UNSUPPORTED", "x", 422));
    const res = await start(app);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("pkce_unsupported");
  });

  it("start answers a fixed 409 code with the channel off, and the bridge is never called", async () => {
    const { app, oauth, gate } = setup();
    gate.current = { allowed: false, reason: "channel_disabled", message: "" };
    const res = await start(app);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("remote_mcp_off");
    expect(res.body.message).toMatch(/switched off by the owner/);
    expect(oauth.discover).not.toHaveBeenCalled();
    expect(oauth.register).not.toHaveBeenCalled();
    gate.current = { allowed: false, reason: "server_not_allowlisted", message: "" };
    expect((await start(app)).body.error).toBe("server_not_allowed");
    gate.current = { allowed: false, reason: "connection_disabled", message: "x" };
    expect((await start(app)).body.error).toBe("connection_disabled");
  });

  it("callback and paste answer blocked and never exchange when remote MCP was switched off meanwhile", async () => {
    const { app, oauth, gate } = setup();
    const s = await start(app);
    const state = new URL(s.body.authorizeUrl).searchParams.get("state")!;
    gate.current = { allowed: false, reason: "channel_disabled", message: "" };
    const cb = await request(app).get("/api/mcp/oauth/callback").query({ state, code: "c" }).set("Cookie", `${MCP_OAUTH_STATE_COOKIE}=${state}`);
    expect(cb.headers.location).toBe("/settings?mcp=atlassian:blocked");
    gate.current = { allowed: true, row: null };
    const s2 = await start(app, { provider: "atlassian", scope: "MEMBER", redirectMode: "loopback" });
    const state2 = new URL(s2.body.authorizeUrl).searchParams.get("state")!;
    gate.current = { allowed: false, reason: "channel_disabled", message: "" };
    const paste = await asUser(request(app).post("/api/mcp/oauth/paste")).send({ redirectUrl: `http://127.0.0.1/api/mcp/oauth/callback?code=c&state=${state2}` });
    expect(paste.status).toBe(409);
    expect(paste.body).toEqual({ error: "sign_in_failed", outcome: "blocked" });
    expect(oauth.exchange).not.toHaveBeenCalled();
  });

  it("the pre-registered client route makes no bridge call with the channel off", async () => {
    const { app, oauth, gate } = setup();
    gate.current = { allowed: false, reason: "channel_disabled", message: "" };
    const res = await asUser(request(app).patch("/api/mcp/oauth/client"), "admin").send({ provider: "atlassian", clientId: "mine" });
    expect(res.status).toBe(409);
    expect(oauth.discover).not.toHaveBeenCalled();
  });

  it("callback completes the flow and redirects to a fixed destination; nothing from the query is reflected", async () => {
    const { app, db } = setup();
    const s = await start(app);
    const state = new URL(s.body.authorizeUrl).searchParams.get("state")!;
    const res = await request(app).get("/api/mcp/oauth/callback")
      .query({ state, code: "c0de", returnTo: "https://evil.example", error_description: "<script>" })
      .set("Cookie", `${MCP_OAUTH_STATE_COOKIE}=${state}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/settings?mcp=atlassian:connected");
    expect(db.rows[0].state).toBe("CONNECTED");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("callback: a Workspace connection returns to the credentials page", async () => {
    const { app } = setup();
    const s = await start(app, { provider: "atlassian", scope: "WORKSPACE", acknowledge: true }, "admin");
    const state = new URL(s.body.authorizeUrl).searchParams.get("state")!;
    const res = await request(app).get("/api/mcp/oauth/callback").query({ state, code: "c" }).set("Cookie", `${MCP_OAUTH_STATE_COOKIE}=${state}`);
    expect(res.headers.location).toBe("/integrations/credentials?mcp=atlassian:connected");
  });

  it("callback: a missing cookie, a forged state and a replay all end at failed", async () => {
    const { app } = setup();
    const s = await start(app);
    const state = new URL(s.body.authorizeUrl).searchParams.get("state")!;
    const noCookie = await request(app).get("/api/mcp/oauth/callback").query({ state, code: "c" });
    expect(noCookie.headers.location).toBe("/settings?mcp=unknown:failed");
    const forged = await request(app).get("/api/mcp/oauth/callback").query({ state: "forged", code: "c" }).set("Cookie", `${MCP_OAUTH_STATE_COOKIE}=forged`);
    expect(forged.headers.location).toBe("/settings?mcp=unknown:failed");
    const ok = await request(app).get("/api/mcp/oauth/callback").query({ state, code: "c" }).set("Cookie", `${MCP_OAUTH_STATE_COOKIE}=${state}`);
    expect(ok.headers.location).toBe("/settings?mcp=atlassian:connected");
    const replay = await request(app).get("/api/mcp/oauth/callback").query({ state, code: "c" }).set("Cookie", `${MCP_OAUTH_STATE_COOKIE}=${state}`);
    expect(replay.headers.location).toBe("/settings?mcp=unknown:failed");
  });

  it("paste: rejects a bare code with 400, accepts the full address, and only for the person who started it", async () => {
    const { app, db } = setup();
    const s = await start(app, { provider: "atlassian", scope: "MEMBER", redirectMode: "loopback" });
    const state = new URL(s.body.authorizeUrl).searchParams.get("state")!;
    const bare = await asUser(request(app).post("/api/mcp/oauth/paste")).send({ redirectUrl: "just-a-code" });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toBe("bare_code_rejected");
    const other = await asUser(request(app).post("/api/mcp/oauth/paste"), "family", "u2")
      .send({ redirectUrl: `http://127.0.0.1/api/mcp/oauth/callback?code=c&state=${state}` });
    expect(other.status).toBe(400);
    expect(db.rows[0].state).not.toBe("CONNECTED");
    const s2 = await start(app, { provider: "atlassian", scope: "MEMBER", redirectMode: "loopback" });
    const state2 = new URL(s2.body.authorizeUrl).searchParams.get("state")!;
    const ok = await asUser(request(app).post("/api/mcp/oauth/paste")).send({ redirectUrl: `http://127.0.0.1/api/mcp/oauth/callback?code=c&state=${state2}` });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ outcome: "connected" });
    expect(db.rows[0].state).toBe("CONNECTED");
  });

  it("lists status field by field, disconnects, and refuses another member's row as not found", async () => {
    const { app, db } = setup();
    const s = await start(app);
    const state = new URL(s.body.authorizeUrl).searchParams.get("state")!;
    await request(app).get("/api/mcp/oauth/callback").query({ state, code: "c" }).set("Cookie", `${MCP_OAUTH_STATE_COOKIE}=${state}`);
    const list = await asUser(request(app).get("/api/mcp/oauth/connections"));
    expect(list.status).toBe(200);
    // The pinned contract the Mac app and the dashboard are coded to.
    expect(Object.keys(list.body)).toEqual(["providers"]);
    expect(list.body.providers[0]).toEqual({
      provider: "atlassian",
      member: { id: db.rows[0].id, state: "CONNECTED", connectedAt: expect.any(String), lastRefreshOkAt: expect.any(String) },
      workspace: null,
      redirectUri: "https://box.customer.com/api/mcp/oauth/callback",
      callbackSupported: true,
      apiToken: false,
    });
    expect(list.text).not.toMatch(/ACCESS-SECRET|tokensEnc|clientSecret|auth\.example/);
    const id = db.rows[0].id;
    expect((await asUser(request(app).delete(`/api/mcp/oauth/connections/${id}`), "family", "u2")).status).toBe(404);
    expect((await asUser(request(app).delete(`/api/mcp/oauth/connections/not-a-uuid`))).status).toBe(404);
    expect((await asUser(request(app).delete(`/api/mcp/oauth/connections/${id}`))).status).toBe(204);
    expect(db.rows[0].state).toBe("DISCONNECTED");
  });

  it("client: only owner/admin can store a pre-registered client", async () => {
    const { app, db } = setup();
    const body = { provider: "atlassian", clientId: "mine" };
    expect((await asUser(request(app).patch("/api/mcp/oauth/client"), "family").send(body)).status).toBe(403);
    const ok = await asUser(request(app).patch("/api/mcp/oauth/client"), "admin").send(body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ stored: true, provider: "atlassian" });
    expect(ok.body.message).toMatch(/already signed in keep the client they signed in with/);
    expect(db.clients).toHaveLength(1); // stored once, per provider and issuer; no connection row was written
    expect(db.rows).toHaveLength(0);
  });

  it("an admin changing the client while someone is signed in is answered and applied to the next start only", async () => {
    const { app, db, oauth } = setup();
    const s = await start(app);
    const state = new URL(s.body.authorizeUrl).searchParams.get("state")!;
    await request(app).get("/api/mcp/oauth/callback").query({ state, code: "c" }).set("Cookie", `${MCP_OAUTH_STATE_COOKIE}=${state}`);
    expect(db.rows[0]).toMatchObject({ state: "CONNECTED", clientId: "client-1" });
    const patch = await asUser(request(app).patch("/api/mcp/oauth/client"), "admin").send({ provider: "atlassian", clientId: "mine" });
    expect(patch.status).toBe(200);
    expect(db.rows[0]).toMatchObject({ state: "CONNECTED", clientId: "client-1" }); // untouched
    const next = await start(app, { provider: "atlassian", scope: "MEMBER" }, "family");
    expect(new URL(next.body.authorizeUrl).searchParams.get("client_id")).toBe("mine");
    expect(oauth.register).toHaveBeenCalledTimes(1);
  });

  it("never writes the code, state or pasted address to the request log", async () => {
    const lines: string[] = [];
    const { app } = setup({ write: (s) => { lines.push(s); } });
    const s = await start(app);
    const state = new URL(s.body.authorizeUrl).searchParams.get("state")!;
    await request(app).get("/api/mcp/oauth/callback").query({ state, code: "LEAKY-CODE", iss: "LEAKY-ISS" }).set("Cookie", `${MCP_OAUTH_STATE_COOKIE}=${state}`);
    await asUser(request(app).post("/api/mcp/oauth/paste")).send({ redirectUrl: `https://box.customer.com/api/mcp/oauth/callback?code=LEAKY-PASTED&state=${state}` });
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    for (const secret of [state, "LEAKY-CODE", "LEAKY-ISS", "LEAKY-PASTED", "ACCESS-SECRET"]) expect(all).not.toContain(secret);
  });
});

describe("GET /mcp/oauth/connections visibility", () => {
  beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64")));
  afterEach(() => __setColumnCryptoKeyForTest(null));

  it("shows a member only their own row, and the Workspace row without ackBy unless admin", async () => {
    const { app, db } = setup();
    const s = await asUser(request(app).post("/api/mcp/oauth/start"), "admin", "a1")
      .send({ provider: "atlassian", scope: "WORKSPACE", acknowledge: true });
    const state = new URL(s.body.authorizeUrl).searchParams.get("state")!;
    await request(app).get("/api/mcp/oauth/callback").query({ state, code: "c" }).set("Cookie", `${MCP_OAUTH_STATE_COOKIE}=${state}`);
    await db.seed({ provider: "atlassian", scope: "MEMBER", memberId: "someone-else", issuer: "i", tokenEndpointHost: "h" });

    const asMember = await asUser(request(app).get("/api/mcp/oauth/connections"), "family", "u1");
    expect(asMember.body.providers[0].member).toBeNull(); // never another member's row
    expect(asMember.body.providers[0].workspace).toMatchObject({ state: "CONNECTED", ackBy: null });
    expect(asMember.body.providers[0].workspace.id).toEqual(expect.any(String));

    const asAdmin = await asUser(request(app).get("/api/mcp/oauth/connections"), "admin", "a1");
    expect(asAdmin.body.providers[0].workspace.ackBy).toBe("alice");
  });
});

describe("disconnect answers honestly about the vendor-side revoke (F7)", () => {
  beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64")));
  afterEach(() => __setColumnCryptoKeyForTest(null));

  async function connected() {
    const w = setup();
    w.oauth.discover.mockResolvedValue({
      resource: MCP_URL, issuer: ISSUER, authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token", registrationEndpoint: "https://auth.example/dcr",
      revocationEndpoint: "https://auth.example/revoke", issParameterSupported: false,
    } as never);
    const s = await start(w.app);
    const state = new URL(s.body.authorizeUrl).searchParams.get("state")!;
    await request(w.app).get("/api/mcp/oauth/callback").query({ state, code: "c" }).set("Cookie", `${MCP_OAUTH_STATE_COOKIE}=${state}`);
    return { ...w, id: w.db.rows[0].id as string };
  }

  it("a failed vendor revoke is 200 revoked:false, never a 204 that claims success; a clean one is 204", async () => {
    const w = await connected();
    w.oauth.revoke.mockRejectedValueOnce(new Error("vendor down"));
    const failed = await asUser(request(w.app).delete(`/api/mcp/oauth/connections/${w.id}`));
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ disconnected: true, revoked: false });
    expect(w.db.rows[0]).toMatchObject({ state: "DISCONNECTED", tokensEnc: null });

    const again = await connected();
    const ok = await asUser(request(again.app).delete(`/api/mcp/oauth/connections/${again.id}`));
    expect(ok.status).toBe(204);
    expect(again.oauth.revoke).toHaveBeenCalledTimes(1);
  });

  it("an unreadable gate is reported the same way", async () => {
    const w = await connected();
    w.gate.current = { allowed: false, reason: "gate_unavailable", message: "" };
    const res = await asUser(request(w.app).delete(`/api/mcp/oauth/connections/${w.id}`));
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(false);
    expect(w.oauth.revoke).not.toHaveBeenCalled();
  });
});

describe("production wiring: the callback and the start route share one set of in-flight sign-ins", () => {
  beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64")));
  afterEach(() => __setColumnCryptoKeyForTest(null));

  it("a real browser redirect completes: start, then callback, built the way app.ts builds them", async () => {
    const db = fakeMcpOAuthDb();
    const oauth = {
      discover: vi.fn(async (_u: string) => ({
        resource: MCP_URL, issuer: ISSUER, authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token", registrationEndpoint: "https://auth.example/dcr", issParameterSupported: false,
      })),
      register: vi.fn(async (_e: string, _r: readonly string[]) => ({ clientId: "client-1" })),
      exchange: vi.fn(async (_i: unknown) => ({ accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET", expiresIn: 3600 })),
      refresh: vi.fn(async (_i: unknown): Promise<{ accessToken: string }> => ({ accessToken: "x" })),
      revoke: vi.fn(async (_i: unknown): Promise<void> => {}),
    };
    // Exactly one call, as in app.ts: no deps object is shared by hand.
    const routers = createMcpOAuthRouters(db.prisma, { oauth, egress: async () => ({ allowed: true, row: null }) });
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", routers.callback); // public, before session auth
    app.use((req, _res, next) => {
      req.user = { id: "u1", username: "alice", displayName: "Alice", role: "family" };
      next();
    });
    app.use("/api", routers.session);

    const started = await request(app).post("/api/mcp/oauth/start").send({ provider: "atlassian", scope: "MEMBER" });
    expect(started.status).toBe(200);
    const state = new URL(started.body.authorizeUrl).searchParams.get("state")!;
    const done = await request(app).get("/api/mcp/oauth/callback").query({ state, code: "c" }).set("Cookie", `${MCP_OAUTH_STATE_COOKIE}=${state}`);
    expect(done.headers.location).toBe("/settings?mcp=atlassian:connected");
    expect(oauth.exchange).toHaveBeenCalledTimes(1);
    expect(db.rows[0].state).toBe("CONNECTED");
  });

  it("the default dependency sets never get separate in-flight maps", () => {
    expect(mcpOAuthDependencies().pending).toBe(mcpOAuthDependencies().pending);
  });
});
