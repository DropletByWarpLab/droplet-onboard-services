/**
 * ADR-013 (PR #378) — external-IdP OIDC SSO route.
 *
 *   POST /api/sso/oidc/authorize  → 302 to the IdP authorize URL; mints +
 *     persists single-use state/nonce/PKCE; sets a CSRF cookie bound to state.
 *   GET  /api/sso/oidc/callback   → verifies state (cookie + server-side
 *     single-use), exchanges the code, validates the ID token (delegated to
 *     the service / openid-client), ensures/links a local User by NORMALIZED
 *     email, issues the SAME session cookies as /auth/login, redirects.
 *
 * Strategy mirrors auth.directory-login.test.ts: drive the real router via
 * supertest, mock the two SSO services (the openid-client + DB boundaries),
 * use an in-memory Prisma mock. NO real IdP / JWKS is contacted — the
 * provider boundary (sso-oidc.service) is mocked.
 *
 * Coverage:
 *   - authorize: happy 302 + state persisted + CSRF cookie set
 *   - authorize: unknown provider → 400; unconfigured provider → 400
 *   - callback: state cookie mismatch → 401 (CSRF), no session issued
 *   - callback: consumed/expired/unknown server-side state → 401 (replay)
 *   - callback link-EXISTING: email matches a local User → links, signs in,
 *     PRESERVES that User.id (no new user, no second row)
 *   - callback CREATE-new: no local User for the email → creates one (family,
 *     SSO-only, no passwordHash) + links
 *   - callback by-SUB: an existing SsoIdentity short-circuits email lookup
 *   - callback normalizes the email (trim + lowercase) at the lookup boundary
 *   - callback no-email ID token → 401, NO login-unable row created
 *   - callback ID-token validation failure → 401, no session
 *   - never logs tokens/codes/secrets (no token in response body)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.mock("../config.js", () => ({
  config: {
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    REDIS_URL: "redis://localhost:6379",
    // PR #486 finding 2: the callback now reconstructs currentUrl via the
    // shared trusted-origin resolver. With no canonical-origin env vars set,
    // the host falls back to the box's trusted origin (corsAllowedOrigins[0])
    // in this unit test.
    ROUTING_MODE: "disabled",
    WIREGUARD_ENDPOINT_HOST: "",
    corsAllowedOrigins: ["https://droplet-ai.local"],
  },
}));

// The openid-client + discovery boundary. Mocked so no IdP/JWKS is hit.
const buildAuthorizeRequest = vi.fn();
const exchangeCodeAndValidate = vi.fn();
const getOidcProviderConfig = vi.fn();
// WARP-629: the public discovery route reads which providers are configured
// from this service function. Mocked here so the test drives the env-derived
// answer directly (the env→config plumbing is the service's own unit concern).
const enabledSsoProviders = vi.fn();
vi.mock("../services/sso-oidc.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/sso-oidc.service.js")>(
    "../services/sso-oidc.service.js",
  );
  return {
    ...actual, // keep real isSsoProvider / SSO_PROVIDERS
    buildAuthorizeRequest: (...a: unknown[]) => buildAuthorizeRequest(...a),
    exchangeCodeAndValidate: (...a: unknown[]) => exchangeCodeAndValidate(...a),
    getOidcProviderConfig: (...a: unknown[]) => getOidcProviderConfig(...a),
    enabledSsoProviders: (...a: unknown[]) => enabledSsoProviders(...a),
  };
});

const createLoginState = vi.fn();
const consumeLoginState = vi.fn();
vi.mock("../services/sso-login-state.service.js", () => ({
  SSO_LOGIN_STATE_TTL_SECONDS: 600,
  createLoginState: (...a: unknown[]) => createLoginState(...a),
  consumeLoginState: (...a: unknown[]) => consumeLoginState(...a),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

import { createSsoRouter, safeReturnTo } from "./sso.js";
import { verifyAccessToken } from "../services/jwt.service.js";

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  nextcloudUsername: string | null;
  passwordHash: string | null;
  role: string;
  isLocal: boolean;
  // WARP (SCIM): soft-deactivation status. A DEACTIVATED user is denied at
  // the SSO callback too (not just /auth/login) — Okta can SSO a person
  // whose directory account it later deactivates.
  directoryStatus?: "ACTIVE" | "DEACTIVATED";
}
interface IdentityRow {
  id: string;
  userId: string;
  provider: string;
  subject: string;
  email: string | null;
}

function createPrismaMock(users: UserRow[] = [], identities: IdentityRow[] = []) {
  const self: any = {};
  self._users = [...users];
  self._identities = [...identities];
  let seq = self._users.length;
  self.user = {
    findUnique: vi.fn(async ({ where }: { where: any }) => {
      if (where.email !== undefined) return self._users.find((u: UserRow) => u.email === where.email) ?? null;
      if (where.id !== undefined) return self._users.find((u: UserRow) => u.id === where.id) ?? null;
      return null;
    }),
    create: vi.fn(async ({ data }: { data: any }) => {
      const row: UserRow = {
        id: data.id ?? `u-new-${++seq}`,
        username: data.username,
        displayName: data.displayName,
        email: data.email ?? null,
        nextcloudUsername: data.nextcloudUsername ?? null,
        passwordHash: data.passwordHash ?? null,
        role: data.role ?? "family",
        isLocal: data.isLocal ?? true,
        directoryStatus: data.directoryStatus ?? "ACTIVE",
      };
      self._users.push(row);
      return row;
    }),
  };
  self.ssoIdentity = {
    findUnique: vi.fn(async ({ where }: { where: any }) => {
      // where: { provider_subject: { provider, subject } }
      const ps = where.provider_subject;
      const found = self._identities.find(
        (i: IdentityRow) => i.provider === ps.provider && i.subject === ps.subject,
      );
      if (!found) return null;
      if (where.include?.user || true) {
        return { ...found, user: self._users.find((u: UserRow) => u.id === found.userId) ?? null };
      }
      return found;
    }),
    create: vi.fn(async ({ data }: { data: any }) => {
      const row: IdentityRow = {
        id: `i-${self._identities.length + 1}`,
        userId: data.userId,
        provider: data.provider,
        subject: data.subject,
        email: data.email ?? null,
      };
      self._identities.push(row);
      return row;
    }),
  };
  return self;
}

function buildApp(prismaMock: any) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", createSsoRouter(prismaMock));
  return app;
}

function sessionFromRes(res: request.Response): ReturnType<typeof verifyAccessToken> {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const sessionCookie = cookies.find((c) => c?.startsWith("droplet_session="));
  if (!sessionCookie) throw new Error("droplet_session cookie not set");
  const raw = sessionCookie.split(";")[0]!.replace("droplet_session=", "");
  return verifyAccessToken(raw);
}

/**
 * Assert NO session was issued. The callback intentionally emits a
 * `Set-Cookie` to CLEAR the single-use CSRF cookie even on a rejection, so
 * the meaningful check is that neither the session nor the refresh cookie is
 * SET to a real (non-expired) value — not that Set-Cookie is absent entirely.
 */
function expectNoSessionIssued(res: request.Response): void {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const sessionSet = cookies.find(
    (c) => c.startsWith("droplet_session=") && !c.startsWith("droplet_session=;"),
  );
  const refreshSet = cookies.find(
    (c) => c.startsWith("droplet_refresh=") && !c.startsWith("droplet_refresh=;"),
  );
  expect(sessionSet, "no session cookie should be issued").toBeUndefined();
  expect(refreshSet, "no refresh cookie should be issued").toBeUndefined();
  // The only Set-Cookie permitted on a rejection is the CSRF-cookie clear.
  for (const c of cookies) {
    expect(c.startsWith("droplet_sso_state=")).toBe(true);
  }
}

const stefan: UserRow = {
  id: "u-uuid-stefan-7777",
  username: "stefan",
  displayName: "Stefan Cruceru",
  email: "stefan@warp.test",
  nextcloudUsername: "stefan",
  passwordHash: "$argon2id$mock",
  role: "owner",
  isLocal: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  getOidcProviderConfig.mockReturnValue({
    provider: "google",
    issuer: "https://accounts.google.com",
    clientId: "cid",
    clientSecret: "sec",
    redirectUri: "https://droplet.local/api/sso/oidc/callback",
  });
  buildAuthorizeRequest.mockResolvedValue({
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=st-123",
    state: "st-123",
    nonce: "no-123",
    codeVerifier: "ve-123",
  });
  createLoginState.mockImplementation(async (_p: unknown, input: any) => ({
    id: "sls-1",
    ...input,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 600_000),
    createdAt: new Date(),
  }));
  // WARP-629: discovery defaults to "nothing configured" unless a test sets it.
  enabledSsoProviders.mockReturnValue([]);
});

describe("POST /api/sso/oidc/authorize", () => {
  it("happy path: 302 to the IdP, state persisted, opaque CSRF cookie set", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma))
      .post("/api/sso/oidc/authorize")
      .send({ provider: "google" });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?state=st-123",
    );
    expect(buildAuthorizeRequest).toHaveBeenCalledWith("google");
    // The server-side single-use state row is persisted with nonce + verifier.
    expect(createLoginState).toHaveBeenCalledTimes(1);
    const arg = createLoginState.mock.calls[0]![1];
    expect(arg.state).toBe("st-123");
    expect(arg.nonce).toBe("no-123");
    expect(arg.codeVerifier).toBe("ve-123");
    // CSRF cookie bound to the state, httpOnly.
    const setCookie = res.headers["set-cookie"] as unknown as string[];
    const csrf = setCookie.find((c) => c.startsWith("droplet_sso_state="));
    expect(csrf).toBeDefined();
    expect(csrf).toContain("st-123");
    expect(csrf!.toLowerCase()).toContain("httponly");
  });

  it("accepts entra too", async () => {
    getOidcProviderConfig.mockReturnValue({ provider: "entra", issuer: "i", clientId: "c", clientSecret: "s", redirectUri: "r" });
    buildAuthorizeRequest.mockResolvedValue({ authorizeUrl: "https://login.microsoftonline.com/x", state: "s2", nonce: "n2", codeVerifier: "v2" });
    const res = await request(buildApp(createPrismaMock()))
      .post("/api/sso/oidc/authorize")
      .send({ provider: "entra" });
    expect(res.status).toBe(302);
    expect(buildAuthorizeRequest).toHaveBeenCalledWith("entra");
  });

  it("starts the OIDC flow for okta via the SAME authorize path (302)", async () => {
    getOidcProviderConfig.mockReturnValue({ provider: "okta", issuer: "i", clientId: "c", clientSecret: "s", redirectUri: "r" });
    buildAuthorizeRequest.mockResolvedValue({ authorizeUrl: "https://dev-12345.okta.com/oauth2/default/v1/authorize?x", state: "s3", nonce: "n3", codeVerifier: "v3" });
    const res = await request(buildApp(createPrismaMock()))
      .post("/api/sso/oidc/authorize")
      .send({ provider: "okta" });
    expect(res.status).toBe(302);
    expect(buildAuthorizeRequest).toHaveBeenCalledWith("okta");
    expect(createLoginState).toHaveBeenCalled();
  });

  it("rejects an unknown provider with 400 (no authorize, no persist)", async () => {
    // `okta` is now a supported provider (shipped in this PR); use a value
    // that is genuinely outside the SsoProvider union to assert the reject.
    const res = await request(buildApp(createPrismaMock()))
      .post("/api/sso/oidc/authorize")
      .send({ provider: "workday" });
    expect(res.status).toBe(400);
    expect(buildAuthorizeRequest).not.toHaveBeenCalled();
    expect(createLoginState).not.toHaveBeenCalled();
  });

  it("rejects an unconfigured provider with 400 (fail closed)", async () => {
    getOidcProviderConfig.mockReturnValue(null);
    const res = await request(buildApp(createPrismaMock()))
      .post("/api/sso/oidc/authorize")
      .send({ provider: "google" });
    expect(res.status).toBe(400);
    expect(buildAuthorizeRequest).not.toHaveBeenCalled();
  });
});

describe("GET /api/sso/oidc/providers — runtime discovery (WARP-629)", () => {
  it("returns { providers: [] } when no provider is configured", async () => {
    enabledSsoProviders.mockReturnValue([]);
    const res = await request(buildApp(createPrismaMock())).get("/api/sso/oidc/providers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ providers: [] });
  });

  it("returns only the fully-configured providers (google) ", async () => {
    enabledSsoProviders.mockReturnValue(["google"]);
    const res = await request(buildApp(createPrismaMock())).get("/api/sso/oidc/providers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ providers: ["google"] });
    // entra/okta are NOT advertised when their env is absent.
    expect(res.body.providers).not.toContain("entra");
    expect(res.body.providers).not.toContain("okta");
  });

  it("sets Cache-Control: no-store so an operator's .env edit isn't served stale", async () => {
    enabledSsoProviders.mockReturnValue(["google"]);
    const res = await request(buildApp(createPrismaMock())).get("/api/sso/oidc/providers");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("resolves WITHOUT an auth cookie (public, pre-session)", async () => {
    enabledSsoProviders.mockReturnValue([]);
    // No Cookie header at all — the login page has no session yet.
    const res = await request(buildApp(createPrismaMock())).get("/api/sso/oidc/providers");
    expect(res.status).toBe(200);
  });

  it("answers even when prisma is NOT wired (discovery reads env, not the DB)", async () => {
    enabledSsoProviders.mockReturnValue(["google"]);
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    // createSsoRouter() with no prisma — authorize/callback 500, discovery must not.
    app.use("/api", createSsoRouter());
    const res = await request(app).get("/api/sso/oidc/providers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ providers: ["google"] });
  });

  it("payload carries only provider IDs — never an issuer / client-id / secret / redirect", async () => {
    enabledSsoProviders.mockReturnValue(["google"]);
    const res = await request(buildApp(createPrismaMock())).get("/api/sso/oidc/providers");
    const body = JSON.stringify(res.body);
    // The shape is exactly { providers: string[] } — no config object leaks.
    expect(Object.keys(res.body)).toEqual(["providers"]);
    for (const p of res.body.providers) {
      expect(typeof p).toBe("string");
    }
    // Defensive substring sweep against the default mock-config secret material.
    expect(body).not.toContain("client_secret");
    expect(body).not.toContain("clientSecret");
    expect(body).not.toContain("issuer");
    expect(body).not.toContain("accounts.google.com");
    expect(body).not.toContain("redirect");
  });
});

describe("GET /api/sso/oidc/callback — CSRF + single-use state", () => {
  it("rejects when the state cookie does not match the query state (CSRF)", async () => {
    const prisma = createPrismaMock([stefan]);
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=evil")
      .set("Cookie", "droplet_sso_state=st-123");
    expect(res.status).toBe(401);
    // Never even consume / exchange when CSRF fails.
    expect(consumeLoginState).not.toHaveBeenCalled();
    expect(exchangeCodeAndValidate).not.toHaveBeenCalled();
    expectNoSessionIssued(res);
  });

  it("rejects a consumed / expired / unknown server-side state (replay) with 401", async () => {
    consumeLoginState.mockResolvedValue(null); // claim failed
    const prisma = createPrismaMock([stefan]);
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");
    expect(res.status).toBe(401);
    expect(exchangeCodeAndValidate).not.toHaveBeenCalled();
    expectNoSessionIssued(res);
  });

  it("rejects a missing code with 400", async () => {
    consumeLoginState.mockResolvedValue({ provider: "google", nonce: "no-123", codeVerifier: "ve-123", returnTo: "/" });
    const prisma = createPrismaMock([stefan]);
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sso/oidc/callback — account linking", () => {
  function primeValidState(provider = "google") {
    consumeLoginState.mockResolvedValue({
      id: "sls-1",
      provider,
      nonce: "no-123",
      codeVerifier: "ve-123",
      returnTo: "/",
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    });
  }

  it("links an EXISTING local user by email, preserves User.id, issues session", async () => {
    primeValidState();
    exchangeCodeAndValidate.mockResolvedValue({
      sub: "google-sub-1",
      email: "stefan@warp.test",
      emailVerified: true,
      name: "Stefan Cruceru",
    });
    const prisma = createPrismaMock([stefan]);
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");

    expect(res.status).toBe(302);
    // No NEW user — linked to the existing row, UUID preserved.
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma._users).toHaveLength(1);
    const session = sessionFromRes(res);
    expect(session?.sub).toBe("u-uuid-stefan-7777");
    expect(session?.role).toBe("owner");
    // SsoIdentity link row created pointing at the existing user.
    expect(prisma.ssoIdentity.create).toHaveBeenCalledTimes(1);
    const linkData = prisma.ssoIdentity.create.mock.calls[0]![0].data;
    expect(linkData.userId).toBe("u-uuid-stefan-7777");
    expect(linkData.provider).toBe("google");
    expect(linkData.subject).toBe("google-sub-1");
  });

  it("CREATES a new local user when no email match (family, SSO-only, no passwordHash) + links", async () => {
    primeValidState();
    exchangeCodeAndValidate.mockResolvedValue({
      sub: "google-sub-new",
      email: "newhire@warp.test",
      emailVerified: true,
      name: "New Hire",
    });
    const prisma = createPrismaMock([stefan]); // stefan exists, different email
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");

    expect(res.status).toBe(302);
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    const created = prisma.user.create.mock.calls[0]![0].data;
    expect(created.email).toBe("newhire@warp.test");
    expect(created.role).toBe("family"); // least privilege
    expect(created.passwordHash ?? null).toBeNull(); // SSO-only, can't password-login
    expect(created.isLocal).toBe(true);
    // Linked.
    expect(prisma.ssoIdentity.create).toHaveBeenCalledTimes(1);
    const session = sessionFromRes(res);
    expect(session?.role).toBe("family");
  });

  it("short-circuits via an existing SsoIdentity (by sub) without an email lookup", async () => {
    primeValidState();
    exchangeCodeAndValidate.mockResolvedValue({ sub: "google-sub-1", email: "whatever@x.com", name: "X" });
    const prisma = createPrismaMock(
      [stefan],
      [{ id: "i-1", userId: "u-uuid-stefan-7777", provider: "google", subject: "google-sub-1", email: "stefan@warp.test" }],
    );
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");

    expect(res.status).toBe(302);
    // Resolved by sub → no email lookup, no new identity, no new user.
    expect(prisma.user.findUnique).not.toHaveBeenCalledWith({ where: { email: "whatever@x.com" } });
    expect(prisma.ssoIdentity.create).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    const session = sessionFromRes(res);
    expect(session?.sub).toBe("u-uuid-stefan-7777");
  });

  it("links an okta identity by email and signs in via the SAME callback path", async () => {
    // Okta SSO is plain OIDC — the callback is provider-agnostic. Prove the
    // okta provider flows through link-by-email + session issuance identically.
    primeValidState("okta");
    exchangeCodeAndValidate.mockResolvedValue({
      sub: "okta-sub-42",
      email: "stefan@warp.test",
      emailVerified: true,
      name: "Stefan Cruceru",
    });
    const prisma = createPrismaMock([stefan]);
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");

    expect(res.status).toBe(302);
    expect(prisma.user.create).not.toHaveBeenCalled(); // linked, UUID preserved
    const linkData = prisma.ssoIdentity.create.mock.calls[0]![0].data;
    expect(linkData.provider).toBe("okta");
    expect(linkData.subject).toBe("okta-sub-42");
    expect(linkData.userId).toBe("u-uuid-stefan-7777");
    const session = sessionFromRes(res);
    expect(session?.sub).toBe("u-uuid-stefan-7777");
  });

  it("ORCH-01: REFUSES to link an UNVERIFIED email to an existing account (401, no link, no session)", async () => {
    // Attack: register at the federated IdP with the owner's email and an
    // UNVERIFIED profile (email_verified:false). Without the gate the
    // callback would mint an SsoIdentity binding the attacker's sub to the
    // existing owner row and issue owner cookies — full takeover. The gate
    // must refuse: no link, no session.
    primeValidState();
    exchangeCodeAndValidate.mockResolvedValue({
      sub: "attacker-sub-1",
      email: "stefan@warp.test", // the existing owner's email
      emailVerified: false,
      name: "Definitely Stefan",
    });
    const prisma = createPrismaMock([stefan]);
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SSO_EMAIL_UNVERIFIED");
    // Critically: the attacker's sub was NOT linked to the owner row.
    expect(prisma.ssoIdentity.create).not.toHaveBeenCalled();
    // And no account was minted from the unverified email either.
    expect(prisma.user.create).not.toHaveBeenCalled();
    expectNoSessionIssued(res);
  });

  it("ORCH-01: REFUSES to CREATE an account from an UNVERIFIED email (401, no create)", async () => {
    primeValidState();
    exchangeCodeAndValidate.mockResolvedValue({
      sub: "stranger-sub",
      email: "stranger@warp.test", // no local user with this email
      emailVerified: false,
      name: "Stranger",
    });
    const prisma = createPrismaMock([stefan]);
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SSO_EMAIL_UNVERIFIED");
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.ssoIdentity.create).not.toHaveBeenCalled();
    expectNoSessionIssued(res);
  });

  it("ORCH-01: an ALREADY-LINKED (provider, sub) signs in even without email_verified (gate is link/create-only)", async () => {
    // Branch 1 keys on the vetted sub, not email, so a missing/false
    // email_verified must NOT regress an existing user's sign-in.
    primeValidState();
    exchangeCodeAndValidate.mockResolvedValue({
      sub: "google-sub-1",
      email: "stefan@warp.test",
      emailVerified: false,
      name: "Stefan",
    });
    const prisma = createPrismaMock(
      [stefan],
      [{ id: "i-1", userId: "u-uuid-stefan-7777", provider: "google", subject: "google-sub-1", email: "stefan@warp.test" }],
    );
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");

    expect(res.status).toBe(302);
    expect(prisma.ssoIdentity.create).not.toHaveBeenCalled(); // already linked
    const session = sessionFromRes(res);
    expect(session?.sub).toBe("u-uuid-stefan-7777");
  });

  it("DENIES a DEACTIVATED user at the SSO callback even when linked by sub (401, no session)", async () => {
    // WARP (SCIM): Okta SSO'd this person, then deactivated their directory
    // account (active:false). The SsoIdentity link still resolves, but the
    // callback must fail closed — a deactivated user can't sign in by any
    // path (parity with the /auth/login DEACTIVATED gate).
    primeValidState();
    exchangeCodeAndValidate.mockResolvedValue({ sub: "google-sub-1", email: "x@y.com", name: "X" });
    const deactivated: UserRow = { ...stefan, directoryStatus: "DEACTIVATED" };
    const prisma = createPrismaMock(
      [deactivated],
      [{ id: "i-1", userId: "u-uuid-stefan-7777", provider: "google", subject: "google-sub-1", email: "stefan@warp.test" }],
    );
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");

    expect(res.status).toBe(401);
    expectNoSessionIssued(res);
  });

  it("DENIES a DEACTIVATED user resolved by email (401, no session, no link minted)", async () => {
    primeValidState();
    // emailVerified:true so this exercises the DEACTIVATION gate specifically
    // (not the ORCH-01 unverified-email refusal, which is tested separately).
    exchangeCodeAndValidate.mockResolvedValue({ sub: "fresh-sub", email: "stefan@warp.test", emailVerified: true, name: "S" });
    const deactivated: UserRow = { ...stefan, directoryStatus: "DEACTIVATED" };
    const prisma = createPrismaMock([deactivated]);
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");

    expect(res.status).toBe(401);
    // Must not silently re-activate by minting a link to a disabled row.
    expect(prisma.ssoIdentity.create).not.toHaveBeenCalled();
    expectNoSessionIssued(res);
  });

  it("normalizes the IdP email (trim + lowercase) at the lookup boundary (#374)", async () => {
    primeValidState();
    exchangeCodeAndValidate.mockResolvedValue({ sub: "g-sub-x", email: "  Stefan@Warp.TEST  ", emailVerified: true, name: "S" });
    const prisma = createPrismaMock([stefan]);
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");

    expect(res.status).toBe(302);
    // The lookup value must be normalized so it matches the stored row.
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: "stefan@warp.test" } });
    expect(prisma.user.create).not.toHaveBeenCalled();
    const session = sessionFromRes(res);
    expect(session?.sub).toBe("u-uuid-stefan-7777");
  });

  it("rejects an ID token with NO email — never creates a login-unable row", async () => {
    primeValidState();
    exchangeCodeAndValidate.mockResolvedValue({ sub: "g-sub-noemail", name: "No Email" });
    const prisma = createPrismaMock([stefan]);
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");

    expect(res.status).toBe(401);
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.ssoIdentity.create).not.toHaveBeenCalled();
    expectNoSessionIssued(res);
  });

  it("rejects an ID-token validation failure with 401, no session", async () => {
    primeValidState();
    exchangeCodeAndValidate.mockRejectedValue(new Error("nonce mismatch / bad signature"));
    const prisma = createPrismaMock([stefan]);
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=abc&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");

    expect(res.status).toBe(401);
    expect(prisma.user.create).not.toHaveBeenCalled();
    expectNoSessionIssued(res);
  });

  it("does not leak tokens/codes in the response body", async () => {
    primeValidState();
    exchangeCodeAndValidate.mockResolvedValue({ sub: "google-sub-1", email: "stefan@warp.test", emailVerified: true, name: "S" });
    const prisma = createPrismaMock([stefan]);
    const res = await request(buildApp(prisma))
      .get("/api/sso/oidc/callback?code=super-secret-code&state=st-123")
      .set("Cookie", "droplet_sso_state=st-123");
    const body = JSON.stringify(res.body) + (res.text ?? "");
    expect(body).not.toContain("super-secret-code");
    expect(body).not.toContain("ve-123"); // codeVerifier
  });
});

/**
 * safeReturnTo — open-redirect guard for the post-login landing path.
 *
 * The returnTo value reaches the browser via the `Location` response header
 * (res.redirect). The original `startsWith("/") && !startsWith("//")` string
 * guard was defeated several ways, all confirmed below:
 *   1. A backslash authority (`/\evil.com`) passed the `/` / `//` check yet a
 *      browser treats `\` as `/`, turning it into `//evil.com` → off-origin.
 *   2. A leading tab/newline before `//` (`/\t//evil.com`) passed the string
 *      check but the URL parser un-hides the authority → off-origin.
 *   3. `..` resolution can leave the RETURNED path itself authority-leading
 *      (`/x/..//evil.com` → `//evil.com`), which the browser then resolves
 *      against the real appliance origin → off-origin navigation.
 *
 * The hardened guard mirrors the merged Aurora login's safeNext: require a
 * single leading "/" (never "//" or "/\"), resolve against a sentinel origin,
 * require the resolved origin to equal the sentinel, return ONLY the resolved
 * path+search+hash, and reject a resolved path that is itself protocol-relative
 * / authority-leading.
 *
 * Note: query-string values are percent-decoded before they reach the route
 * (URLSearchParams for the dashboard; Express for the JSON body), so these
 * tests probe the DECODED forms — exactly what prod sees.
 */
describe("safeReturnTo — open-redirect hardening", () => {
  it.each([
    ["backslash authority (decoded /%5C)", "/\\evil.com"],
    ["tab then // (decoded /%09//)", "/\t//evil.com"],
    ["tab then single / (decoded /%09/)", "/\t/evil.com"],
    ["newline then // (decoded /%0A//)", "/\n//evil.com"],
    ["protocol-relative //host", "//host"],
    ["scheme-relative https:evil", "https:evil"],
    ["absolute http URL", "http://evil.com/x"],
    ["dotdot to authority", "/..//evil.com"],
    ["nested dotdot to authority", "/x/..//evil.com"],
    ["carriage-return then //", "/\r//evil.com"],
    ["backslash-backslash authority", "\\\\evil.com"],
    ["non-string (object)", { toString: () => "//evil.com" } as unknown],
    ["non-string (number)", 42 as unknown],
    ["empty string", ""],
    ["bare relative (no leading slash)", "evil.com"],
  ])("rejects an off-origin / authority-leading returnTo (%s) → '/'", (_label, input) => {
    const out = safeReturnTo(input);
    // The returned value must itself resolve same-origin against ANY origin —
    // i.e. it can never carry an authority the browser would honour.
    expect(out).toBe("/");
  });

  it.each([
    ["root", "/", "/"],
    ["files", "/files", "/files"],
    ["files with query", "/files?x=1", "/files?x=1"],
    ["setup with query", "/setup?from=x", "/setup?from=x"],
    ["path with hash", "/files#section", "/files#section"],
    ["nested path", "/people/123", "/people/123"],
  ])("passes a legit same-origin path (%s) through unchanged", (_label, input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });

  it("never returns a value that resolves off-origin against the real appliance origin", () => {
    // Belt-and-suspenders: whatever safeReturnTo returns, resolving it against
    // a concrete appliance origin must stay on that origin (no Location-header
    // open redirect). This is the actual security invariant — independent of
    // whether a given input is rejected to "/" or normalized to a safe path.
    const probes = [
      "/\\evil.com",
      "/\t//evil.com",
      "/\n//evil.com",
      "//evil.com",
      "/..//evil.com",
      "/x/..//evil.com",
      "https://evil.com",
    ];
    for (const p of probes) {
      const out = safeReturnTo(p);
      expect(new URL(out, "https://droplet.local").origin).toBe("https://droplet.local");
    }
  });
});
