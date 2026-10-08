import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request, { type Test } from "supertest";
import { __setColumnCryptoKeyForTest } from "../services/column-crypto.service.js";
import { fakeGoogleDb } from "../services/google/__tests__/fake-db.js";
import { beginGoogleConnect, completeGoogleConnect, googleDependencies, type GoogleDependencies } from "../services/google/google-auth.service.js";
import type { GoogleProvider } from "../services/google/google-client.js";
import { DEFAULT_GOOGLE_FEATURES, scopesForGoogleFeatures } from "../services/google/scopes.js";
import { createGoogleCallbackRouter, createGoogleRouter, GOOGLE_STATE_COOKIE } from "./google.js";
import { config } from "../config.js";

vi.mock("../config.js", () => ({ config: {
  AUTH_ENABLED: true, SERVICE_TOKEN_EMAIL: "email-service-secret", SERVICE_TOKEN_VOICE: "voice-service-secret",
  DROPLET_LAN_HOSTNAME: "box.customer.com", WIREGUARD_ENDPOINT_HOST: "", corsAllowedOrigins: ["https://droplet-ai.local"],
  agentMaxIter: { defaultIter: 5, capIter: 10 },
} }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("../services/email/provision.service.js", () => ({ requestIndexerRefresh: vi.fn(async () => true) }));

const userId = "user-1";
const appRegistration = { clientId: "customer-client.apps.googleusercontent.com", clientSecret: "customer-secret" };
const redirectUri = "https://box.customer.com/api/google/callback";
function setup(overrides: Partial<GoogleDependencies> = {}) {
  const db = fakeGoogleDb();
  const provider: GoogleProvider = {
    getAuthorizationUrl: vi.fn((_app, { state }) => `https://accounts.google.com/authorize?state=${state}`),
    exchangeCode: vi.fn(async (_app, opts) => ({ accessToken: "access-secret", refreshToken: "refresh-secret", grantedScopes: [...opts.scopes ?? scopesForGoogleFeatures(DEFAULT_GOOGLE_FEATURES)] })),
    getAccountAddress: vi.fn(async () => "person@gmail.com"),
    refresh: vi.fn(async (_app, _refresh, scopes) => ({ accessToken: "worker-access-token", grantedScopes: [...scopes ?? scopesForGoogleFeatures(DEFAULT_GOOGLE_FEATURES)] })), revoke: vi.fn(async () => {}),
  };
  const deps = googleDependencies({ provider, getApp: vi.fn(async () => appRegistration), refreshIndexer: vi.fn(async () => true), mailboxAvailable: () => true, ...overrides });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Callback precedes the session middleware, like the production app.
  app.use("/api", createGoogleCallbackRouter(db.prisma, deps));
  app.use((req, _res, next) => {
    const role = req.headers["x-test-role"];
    const id = req.headers["x-test-id"];
    if (typeof role === "string" && typeof id === "string") req.user = {
      id, username: "test", displayName: "Test", role: role as "family",
    };
    next();
  });
  app.use("/api", createGoogleRouter(db.prisma, deps));
  return { app, db, deps, provider };
}
const asUser = (call: Test, role = "family", id = userId) =>
  call.set("x-test-role", role).set("x-test-id", id);
const cookieHeaders = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string")
  : typeof value === "string" ? [value] : [];

describe("Google browser and mail worker routes", () => {
  beforeEach(() => {
    config.DROPLET_LAN_HOSTNAME = "box.customer.com";
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));
  });
  afterEach(() => __setColumnCryptoKeyForTest(null));

  it("lets a person connect without app fields and returns only browser navigation data", async () => {
    const { app, db, provider } = setup();
    const result = await asUser(request(app).post("/api/google/connect")).send({});
    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(["authorizeUrl", "expiresAt"]);
    const cookies = cookieHeaders(result.headers["set-cookie"]);
    expect(cookies[0]).toContain(`${GOOGLE_STATE_COOKIE}=`);
    expect(cookies[0]).toMatch(/HttpOnly/);
    expect(cookies[0]).toMatch(/Secure/);
    expect(cookies[0]).toMatch(/SameSite=Lax/);
    expect(cookies[0]).toMatch(/Path=\/api\/google/);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(provider.getAuthorizationUrl).toHaveBeenCalledWith(appRegistration, expect.objectContaining({ redirectUri }));
    expect(db.connections()[0].userId).toBe(userId);
    expect(result.text).not.toMatch(/customer-secret|refresh-secret|access-secret/);
  });

  it("reports internal-only .lan callbacks as unsupported without starting consent", async () => {
    config.DROPLET_LAN_HOSTNAME = "droplet-ai.lan";
    const { app, provider } = setup();
    const status = await asUser(request(app).get("/api/google/connection"));
    expect(status.body).toMatchObject({
      configured: true,
      callbackSupported: false,
      redirectUri: "https://droplet-ai.lan/api/google/callback",
    });
    const started = await asUser(request(app).post("/api/google/connect")).send({});
    expect(started.status).toBe(400);
    expect(started.body.error).toBe("google_callback_unsupported");
    expect(provider.getAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("does not accept another person's ID or client credentials in a connect body", async () => {
    const { app, db } = setup();
    for (const body of [{ userId: "other-person" }, { clientSecret: "injected" }, { clientId: "injected" }]) {
      const result = await asUser(request(app).post("/api/google/connect")).send(body);
      expect(result.status).toBe(400);
    }
    expect(db.connections()).toHaveLength(0);
  });

  it("connects Calendar alone without requiring the email service and exposes selected features", async () => {
    const { app, db, provider } = setup({ mailboxAvailable: () => false });
    const started = await asUser(request(app).post("/api/google/connect")).send({ mail: false, calendar: true });
    expect(started.status).toBe(200);
    expect(provider.getAuthorizationUrl).toHaveBeenCalledWith(appRegistration, expect.objectContaining({
      scopes: scopesForGoogleFeatures({ mail: false, calendar: true }),
    }));
    const state = new URL(started.body.authorizeUrl).searchParams.get("state");
    const cookie = cookieHeaders(started.headers["set-cookie"])[0].split(";")[0];
    const callback = await request(app).get("/api/google/callback").query({ state, code: "code" }).set("Cookie", cookie);
    expect(callback.headers.location).toBe("/settings?google=connected");
    expect(db.accounts()).toHaveLength(0);
    expect(db.sources()).toHaveLength(1);
    const status = await asUser(request(app).get("/api/google/connection"));
    expect(status.body).toMatchObject({ mailEnabled: false, calendarEnabled: true, mailboxId: null,
      calendar: { state: "WAITING", lastSyncAt: null, lastError: null, eventCount: 0 } });
    expect(status.text).not.toMatch(/access-secret|refresh-secret|customer-secret/);
  });

  it("rejects empty service selection and prevents silently removing a linked archive", async () => {
    const { app, db, deps } = setup();
    expect((await asUser(request(app).post("/api/google/connect")).send({ mail: false, calendar: false })).status).toBe(400);
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps, { mail: true, calendar: true });
    await completeGoogleConnect(db.prisma, { state: started.state, browserState: started.state, code: "code", error: null }, deps);
    for (const body of [{ mail: false, calendar: true }, { mail: true, calendar: false }]) {
      const result = await asUser(request(app).post("/api/google/connect")).send(body);
      expect(result.status).toBe(409);
      expect(result.body.error).toBe("google_disconnect_required");
    }
    expect(db.accounts()).toHaveLength(1);
    expect(db.sources()).toHaveLength(1);
    expect(db.connections()[0].state).toBe("CONNECTED");
  });

  it.each(["guest", "service"])("does not let %s initiate or unlink a person's account", async (role) => {
    const { app, db } = setup();
    expect((await asUser(request(app).post("/api/google/connect"), role).send({})).status).toBe(403);
    expect((await asUser(request(app).delete("/api/google/connection"), role)).status).toBe(403);
    expect(db.connections()).toHaveLength(0);
  });

  it("status is scoped to the requester and projects configuration without client secrets", async () => {
    const { app, db, deps } = setup();
    await beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    const status = await asUser(request(app).get("/api/google/connection"));
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ state: "PENDING_CONSENT", configured: true, redirectUri, callbackSupported: true });
    expect(status.text).not.toMatch(/pendingStateHash|pendingFlowEnc|clientSecret|customer-secret/);
    const other = await asUser(request(app).get("/api/google/connection"), "family", "other-person");
    expect(other.body.state).toBe("DISCONNECTED");
  });

  it("the public callback completes for its initiating browser without a Droplet session", async () => {
    const { app, db, provider } = setup();
    const started = await asUser(request(app).post("/api/google/connect")).send({});
    const state = new URL(started.body.authorizeUrl).searchParams.get("state");
    const cookie = cookieHeaders(started.headers["set-cookie"])[0].split(";")[0];
    const callback = await request(app).get("/api/google/callback").query({ state, code: "code" }).set("Cookie", cookie);
    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe("/settings?google=connected");
    expect(callback.headers["cache-control"]).toBe("no-store");
    expect(provider.exchangeCode).toHaveBeenCalledOnce();
    expect(db.connections()[0].state).toBe("CONNECTED");
    expect(cookieHeaders(callback.headers["set-cookie"])[0]).toContain("Expires=Thu, 01 Jan 1970");
  });

  it.each([
    ...["connected", "cancelled", "expired", "failed"].map((outcome) => ({ returnTo: "/setup?step=accounts", outcome, location: `/setup?step=accounts&google=${outcome}` })),
    ...["connected", "cancelled", "expired", "failed"].map((outcome) => ({ returnTo: "/chat", outcome, location: `/chat?google=${outcome}` })),
  ])("returns $outcome to the stored $returnTo destination", async ({ returnTo, outcome, location }) => {
    const { app, db } = setup();
    const started = await asUser(request(app).post("/api/google/connect")).send({ returnTo });
    expect(started.status).toBe(200);
    const state = new URL(started.body.authorizeUrl).searchParams.get("state");
    const cookie = cookieHeaders(started.headers["set-cookie"])[0].split(";")[0];
    if (outcome === "expired") db.connections()[0].pendingExpiresAt = new Date(0);
    const callback = await request(app).get("/api/google/callback").query({ state,
      ...(outcome === "cancelled" ? { error: "access_denied" } : outcome === "failed" ? { error: "server_error" } : { code: "code" }),
      returnTo: "https://evil.example", error_description: "PROVIDER_SECRET",
    }).set("Cookie", cookie);
    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe(location);
    expect(callback.text).not.toMatch(/evil.example|PROVIDER_SECRET/);
  });

  it.each(["https://evil.example", "//evil.example", "/setup?step=done", "/settings#x", "/chat?x=1", "/chat#x", "/chat/", "/chat/connect-return", "/chat/connect-return?x=1", "/chat/connect-return#x", "/chat/connect-return/", "/other"])("rejects an untrusted Google return destination %s before creating a flow", async (returnTo) => {
    const { app, db } = setup();
    expect((await asUser(request(app).post("/api/google/connect")).send({ returnTo })).status).toBe(400);
    expect(db.connections()).toHaveLength(0);
  });

  it("callback cannot reflect a return URL, missing state cookie or provider error text", async () => {
    const { app, db, provider } = setup();
    const started = await asUser(request(app).post("/api/google/connect")).send({});
    const state = new URL(started.body.authorizeUrl).searchParams.get("state");
    const result = await request(app).get("/api/google/callback").query({
      state, code: "secret-code", returnTo: "https://evil.example", error_description: "REFRESH_TOKEN_SECRET",
    });
    expect(result.status).toBe(303);
    expect(result.headers.location).toBe("/settings?google=failed");
    expect(provider.exchangeCode).not.toHaveBeenCalled();
    expect(db.connections()[0].state).toBe("PENDING_CONSENT");
    expect(result.text).not.toMatch(/evil.example|REFRESH_TOKEN_SECRET|secret-code/);
  });

  it("disconnect purges only the signed-in person's Gmail archive", async () => {
    const { app, db, deps } = setup();
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    await completeGoogleConnect(db.prisma, { state: started.state, browserState: started.state, code: "code", error: null }, deps);
    db.seedAccount({ userId: "other-person", authMode: "GOOGLE_OAUTH", address: "other@gmail.com" });
    const result = await asUser(request(app).delete("/api/google/connection"));
    expect(result.status).toBe(204);
    expect(db.accounts().map((row) => row.address)).toEqual(["other@gmail.com"]);
    expect(db.connections()[0].tokenEnc).toBeNull();
  });

  it("only the exact email service principal with its actual bearer may obtain an access token", async () => {
    const { app, db, deps, provider } = setup();
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    await completeGoogleConnect(db.prisma, { state: started.state, browserState: started.state, code: "code", error: null }, deps);
    const path = `/api/email/${db.accounts()[0].id}/oauth-token`;
    for (const [id, role, bearer] of [
      [userId, "owner", "email-service-secret"],
      ["_service:email", "service", "voice-service-secret"],
      ["_service:voice", "service", "email-service-secret"],
      ["_service:email", "service", ""],
    ]) {
      const denied = await asUser(request(app).get(path), role, id).set("Authorization", `Bearer ${bearer}`);
      expect(denied.status).toBe(403);
      expect(denied.headers["cache-control"]).toBe("no-store");
    }
    const result = await asUser(request(app).get(path), "service", "_service:email").set("Authorization", "Bearer email-service-secret");
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toEqual({ accessToken: "worker-access-token" });
    expect(provider.refresh).toHaveBeenCalledOnce();
    expect(result.text).not.toMatch(/refresh-secret|customer-secret/);
  });

  it("the email service cannot obtain OAuth credentials for an unrelated manual mailbox", async () => {
    const { app, db, provider } = setup();
    db.seedAccount({ userId, authMode: "PASSWORD", address: "manual@example.com" });
    const result = await asUser(request(app).get(`/api/email/${db.accounts()[0].id}/oauth-token`), "service", "_service:email")
      .set("Authorization", "Bearer email-service-secret");
    expect(result.status).toBe(409);
    expect(provider.refresh).not.toHaveBeenCalled();
  });
});
