/**
 * Native SSO handoff (RFC 8252 loopback / private-use scheme + PKCE) for the
 * native Windows client, which has no WebView to carry the browser flow's
 * state cookie.
 *
 *   POST /api/sso/oidc/native/begin   → 200 { authorizeUrl } (no cookie, no 302)
 *   GET  /api/sso/oidc/callback       → NATIVE row: no cookie check, no session
 *                                        cookies, NO handoff code: a consent page
 *                                        (RFC 8252 §8.6, ADR-063 S5) carrying a
 *                                        single-use consent value; any failure
 *                                        (an IdP error or cancel included) is
 *                                        relayed to the app's redirect as error=
 *   POST /api/sso/oidc/native/consent → Continue: trades the consent value for a
 *                                        60 s handoff code (audited as approved)
 *                                        and 303s to the app's redirect
 *   POST /api/sso/oidc/native/token   → { user, accessToken, refreshToken,
 *                                        accessTokenExpiresAt, refreshTokenExpiresAt }
 *
 * The box stays the confidential OIDC client and the IdP still redirects to
 * the box's own callback (ADR-016) — the handoff is a second, box-local leg.
 *
 * Unlike sso.test.ts (which stubs the login-state service), this file drives
 * the REAL sso-login-state.service over an in-memory `ssoLoginState` delegate,
 * so the single-use claims, the handoff expiry and the replay refusals run end
 * to end. The IdP boundary (sso-oidc.service) and the Redis-backed session
 * store are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import { createHash, randomBytes } from "node:crypto";

vi.mock("../config.js", () => ({
  config: {
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    REDIS_URL: "redis://localhost:6379",
    ROUTING_MODE: "disabled",
    WIREGUARD_ENDPOINT_HOST: "",
    corsAllowedOrigins: ["https://droplet-ai.local"],
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const buildAuthorizeRequest = vi.fn();
const exchangeCodeAndValidate = vi.fn();
const getOidcProviderConfig = vi.fn();
vi.mock("../services/sso-oidc.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/sso-oidc.service.js")>(
    "../services/sso-oidc.service.js",
  );
  return {
    ...actual,
    buildAuthorizeRequest: (...a: unknown[]) => buildAuthorizeRequest(...a),
    exchangeCodeAndValidate: (...a: unknown[]) => exchangeCodeAndValidate(...a),
    getOidcProviderConfig: (...a: unknown[]) => getOidcProviderConfig(...a),
  };
});

const createSession = vi.fn(async (_u: { id: string; role: string }) => ({
  sid: "sid-native-0001",
  evictedSids: [] as string[],
}));
vi.mock("../services/session.service.js", () => ({
  createSession: (...a: unknown[]) => createSession(...(a as [{ id: string; role: string }])),
}));

const registerRefreshSession = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/jwt.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/jwt.service.js")>(
    "../services/jwt.service.js",
  );
  return {
    ...actual,
    registerRefreshSession: (...a: unknown[]) => registerRefreshSession(...a),
  };
});

// The TOTP gate has its own suite; default: no second factor enrolled.
const checkLoginSecondFactor = vi.fn();
vi.mock("../services/login-second-factor.service.js", () => ({
  checkLoginSecondFactor: (...a: unknown[]) => checkLoginSecondFactor(...a),
}));

const recordActivity = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...a: unknown[]) => recordActivity(...a),
}));

import { createSsoRouter } from "./sso.js";
import { authRateLimit } from "../middleware/rate-limit.js";
import {
  verifyAccessToken,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "../services/jwt.service.js";

// ── In-memory Prisma ────────────────────────────────────────────────────────

type Row = Record<string, any>;

/** Evaluates the `where` shapes the login-state service emits. */
function rowMatches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Row[]).some((c) => rowMatches(row, c))) return false;
    } else if (key === "AND") {
      if (!(cond as Row[]).every((c) => rowMatches(row, c))) return false;
    } else if (cond === null) {
      if (row[key] !== null) return false;
    } else if (typeof cond === "object" && !(cond instanceof Date)) {
      const v = row[key];
      if ("gt" in cond && !(v !== null && v > cond.gt)) return false;
      if ("lt" in cond && !(v !== null && v < cond.lt)) return false;
    } else if (row[key] !== cond) {
      return false;
    }
  }
  return true;
}

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  accessRoleId: string | null;
  mustChangePassword: boolean;
  directoryStatus: "ACTIVE" | "DEACTIVATED";
  passwordHash?: string | null;
}

const stefan: UserRow = {
  id: "u-uuid-stefan-7777",
  username: "stefan",
  displayName: "Stefan Cruceru",
  email: "stefan@warp.test",
  role: "owner",
  accessRoleId: null,
  mustChangePassword: false,
  directoryStatus: "ACTIVE",
};

function createPrismaMock(users: UserRow[] = [{ ...stefan }]) {
  const states: Row[] = [];
  const identities: Row[] = [
    { id: "i-1", userId: stefan.id, provider: "google", subject: "google-sub-1", email: stefan.email },
  ];
  const self: any = { _states: states, _users: users };
  self.ssoLoginState = {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row: Row = {
        id: `sls-${states.length + 1}`,
        returnTo: "/",
        consumedAt: null,
        createdAt: new Date(),
        flowKind: "BROWSER",
        nativeRedirectUri: null,
        nativeCodeChallenge: null,
        nativeConsentHash: null,
        handoffCodeHash: null,
        handoffUserId: null,
        handoffExpiresAt: null,
        handoffConsumedAt: null,
        ...data,
      };
      states.push(row);
      return { ...row };
    }),
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const hit = states.find((r) => {
        if (where.state !== undefined) return r.state === where.state;
        if (where.nativeConsentHash !== undefined) return r.nativeConsentHash === where.nativeConsentHash;
        return r.handoffCodeHash === where.handoffCodeHash;
      });
      return hit ? { ...hit } : null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const r of states) {
        if (!rowMatches(r, where)) continue;
        Object.assign(r, data);
        count++;
      }
      return { count };
    }),
  };
  self.user = {
    findUnique: vi.fn(async ({ where }: { where: Row }) =>
      where.id !== undefined ? (users.find((u) => u.id === where.id) ?? null) : null,
    ),
    findFirst: vi.fn(async () => null),
    create: vi.fn(),
  };
  self.ssoIdentity = {
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const ps = where.provider_subject;
      const found = identities.find((i) => i.provider === ps.provider && i.subject === ps.subject);
      return found ? { ...found, user: users.find((u) => u.id === found.userId) ?? null } : null;
    }),
    create: vi.fn(),
  };
  return self;
}

function buildApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", createSsoRouter(prisma as never));
  return app;
}

// ── PKCE + flow helpers ─────────────────────────────────────────────────────

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const LOOPBACK = "http://127.0.0.1:49152/sso/7f3a9c";

function setCookies(res: request.Response): string[] {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

/** No droplet_session / droplet_refresh is SET (a clear of the CSRF cookie is fine). */
function expectNoSessionCookies(res: request.Response): void {
  for (const c of setCookies(res)) {
    expect(c.startsWith("droplet_session=") || c.startsWith("droplet_refresh=")).toBe(false);
  }
}

async function begin(app: express.Express, over: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/sso/oidc/native/begin")
    .send({
      provider: "google",
      redirectUri: LOOPBACK,
      codeChallenge: pkcePair().challenge,
      codeChallengeMethod: "S256",
      ...over,
    });
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

function consentValue(html: string): string {
  return /<input type="hidden" name="consent" value="([^"]*)">/.exec(html)?.[1] ?? "";
}

const CONSENT_PATH = "/api/sso/oidc/native/consent";

/**
 * begin → IdP (mocked) → callback → the person presses Continue. The callback
 * answers the consent page (`res`, with the single-use `consent` value its
 * Continue and Cancel forms post); Continue POSTs that value and the box answers a 303 (`consentRes`)
 * whose `location` is the app's redirect carrying the handoff `code`.
 */
async function completeNativeCallback(
  app: express.Express,
  redirectUri = LOOPBACK,
): Promise<{
  code: string;
  verifier: string;
  location: string;
  consent: string;
  res: request.Response;
  consentRes: request.Response;
}> {
  const page = await startNativeConsent(app, redirectUri);
  const consentRes = await request(app).post(CONSENT_PATH).type("form").send({ consent: page.consent, decision: "approve" });
  expect(consentRes.status).toBe(303);
  const location = (consentRes.headers.location as string) ?? "";
  const code = new URL(location).searchParams.get("code") ?? "";
  return { ...page, code, location, consentRes };
}

/** begin → IdP (mocked) → callback: stops at the consent page, before Continue. */
async function startNativeConsent(
  app: express.Express,
  redirectUri = LOOPBACK,
): Promise<{ verifier: string; consent: string; res: request.Response }> {
  const { verifier, challenge } = pkcePair();
  const b = await begin(app, { redirectUri, codeChallenge: challenge });
  expect(b.status).toBe(200);
  const res = await request(app).get("/api/sso/oidc/callback?code=idp-code&state=st-nat");
  expect(res.status).toBe(200);
  return { verifier, consent: consentValue(res.text), res };
}

/** begin → a failure at the callback (IdP error, cancel, ...): the redirect the app gets. */
async function nativeCallbackRedirect(
  app: express.Express,
  query: string,
): Promise<{ res: request.Response; url: URL }> {
  const b = await begin(app);
  expect(b.status).toBe(200);
  const res = await request(app).get(`/api/sso/oidc/callback?${query}state=st-nat`);
  expect(res.status).toBe(302);
  return { res, url: new URL(res.headers.location as string) };
}

beforeEach(() => {
  authRateLimit.resetKey("127.0.0.1");
  vi.clearAllMocks();
  checkLoginSecondFactor.mockResolvedValue("not_enrolled");
  getOidcProviderConfig.mockReturnValue({
    provider: "google",
    issuer: "https://accounts.google.com",
    clientId: "cid",
    clientSecret: "sec",
    redirectUri: "https://droplet-ai.local/api/sso/oidc/callback",
  });
  buildAuthorizeRequest.mockResolvedValue({
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=st-nat",
    state: "st-nat",
    nonce: "no-nat",
    codeVerifier: "box-verifier-nat",
  });
  exchangeCodeAndValidate.mockResolvedValue({
    sub: "google-sub-1",
    email: "stefan@warp.test",
    emailVerified: true,
    name: "Stefan Cruceru",
  });
});

// ── begin ───────────────────────────────────────────────────────────────────

describe("POST /api/sso/oidc/native/begin", () => {
  it("returns 200 { authorizeUrl } — no cookie, no redirect — and persists a NATIVE row", async () => {
    const prisma = createPrismaMock();
    const { challenge } = pkcePair();
    const res = await begin(buildApp(prisma), { codeChallenge: challenge });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=st-nat",
    });
    expect(res.headers.location).toBeUndefined();
    expect(setCookies(res)).toEqual([]);
    expect(res.headers["cache-control"]).toBe("no-store");
    // The IdP authorize request is the SAME one the browser flow builds: the
    // IdP-registered redirect URI (the box callback) is untouched (ADR-016).
    expect(buildAuthorizeRequest).toHaveBeenCalledWith("google");

    expect(prisma._states).toHaveLength(1);
    const row = prisma._states[0];
    expect(row.flowKind).toBe("NATIVE");
    expect(row.nativeRedirectUri).toBe(LOOPBACK);
    expect(row.nativeCodeChallenge).toBe(challenge);
    // The box's own IdP-side PKCE verifier + nonce stay server-side.
    expect(row.codeVerifier).toBe("box-verifier-nat");
    expect(row.nonce).toBe("no-nat");
  });

  it.each([
    ["IPv4 loopback, lowest unprivileged port", "http://127.0.0.1:1024/"],
    ["IPv4 loopback, highest port, nested path", "http://127.0.0.1:65535/sso/a/b"],
    ["IPv6 loopback", "http://[::1]:49152/sso/cb"],
    ["private-use scheme", "droplet://sso/callback"],
  ])("accepts %s", async (_label, redirectUri) => {
    const prisma = createPrismaMock();
    const res = await begin(buildApp(prisma), { redirectUri });
    expect(res.status).toBe(200);
    expect(prisma._states[0].nativeRedirectUri).toBe(redirectUri);
  });

  it.each([
    ["the name localhost (RFC 8252 §8.3)", "http://localhost:49152/sso/cb"],
    ["https loopback", "https://127.0.0.1:49152/sso/cb"],
    ["no port", "http://127.0.0.1/sso/cb"],
    ["explicit default port", "http://127.0.0.1:80/sso/cb"],
    ["privileged port", "http://127.0.0.1:1023/sso/cb"],
    ["port out of range", "http://127.0.0.1:65536/sso/cb"],
    ["zero-padded port", "http://127.0.0.1:049152/sso/cb"],
    ["no path", "http://127.0.0.1:49152"],
    ["a query", "http://127.0.0.1:49152/sso/cb?x=1"],
    ["an empty query", "http://127.0.0.1:49152/sso/cb?"],
    ["a fragment", "http://127.0.0.1:49152/sso/cb#f"],
    ["userinfo (user:pass)", "http://user:pw@127.0.0.1:49152/sso/cb"],
    ["userinfo (user)", "http://user@127.0.0.1:49152/sso/cb"],
    ["another loopback address", "http://127.0.0.2:49152/sso/cb"],
    ["shorthand IPv4", "http://127.1:49152/sso/cb"],
    ["non-canonical IPv6", "http://[0:0:0:0:0:0:0:1]:49152/sso/cb"],
    ["IPv6 without a port", "http://[::1]/sso/cb"],
    ["a LAN address", "http://192.168.1.5:49152/sso/cb"],
    ["a public host", "http://evil.example:49152/sso/cb"],
    ["a backslash authority trick", "http://127.0.0.1:49152\\@evil.example/"],
    ["upper-case scheme", "HTTP://127.0.0.1:49152/sso/cb"],
    ["a longer custom-scheme path", "droplet://sso/callback/extra"],
    ["a custom-scheme query", "droplet://sso/callback?x=1"],
    ["another custom-scheme host", "droplet://pair"],
    ["upper-case custom scheme", "DROPLET://sso/callback"],
    ["javascript:", "javascript:alert(1)"],
    ["an empty string", ""],
  ])("rejects a redirect URI with %s → 400 INVALID_REDIRECT_URI", async (_label, redirectUri) => {
    const prisma = createPrismaMock();
    const res = await begin(buildApp(prisma), { redirectUri });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REDIRECT_URI");
    expect(buildAuthorizeRequest).not.toHaveBeenCalled();
    expect(prisma._states).toHaveLength(0);
  });

  it.each([
    ["42 chars", "a".repeat(42)],
    ["44 chars", "a".repeat(44)],
    ["standard-base64 alphabet", `${"a".repeat(42)}+`],
    ["padding", `${"a".repeat(42)}=`],
  ])("rejects a code challenge that is not 43-char base64url (%s)", async (_label, codeChallenge) => {
    const prisma = createPrismaMock();
    const res = await begin(buildApp(prisma), { codeChallenge });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_CODE_CHALLENGE");
    expect(prisma._states).toHaveLength(0);
  });

  it("rejects the plain PKCE method", async () => {
    const res = await begin(buildApp(createPrismaMock()), { codeChallengeMethod: "plain" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_CODE_CHALLENGE");
  });

  it.each([
    ["no body", {}],
    ["a missing redirectUri", { provider: "google", codeChallenge: "a".repeat(43), codeChallengeMethod: "S256" }],
    ["a non-string field", { provider: "google", redirectUri: 49152, codeChallenge: "a".repeat(43), codeChallengeMethod: "S256" }],
  ])("rejects %s → 400 INVALID_REQUEST", async (_label, body) => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma)).post("/api/sso/oidc/native/begin").send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUEST");
    expect(buildAuthorizeRequest).not.toHaveBeenCalled();
    expect(prisma._states).toHaveLength(0);
  });

  it("rejects an unknown provider", async () => {
    const res = await begin(buildApp(createPrismaMock()), { provider: "workday" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SSO_PROVIDER_UNSUPPORTED");
    expect(buildAuthorizeRequest).not.toHaveBeenCalled();
  });

  it("rejects a provider this box has not configured", async () => {
    getOidcProviderConfig.mockReturnValue(null);
    const res = await begin(buildApp(createPrismaMock()));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SSO_PROVIDER_NOT_CONFIGURED");
    expect(buildAuthorizeRequest).not.toHaveBeenCalled();
  });

  it("fails closed with no directory wired", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createSsoRouter());
    const res = await begin(app);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("SSO_NO_PRISMA");
  });
});

// ── callback ────────────────────────────────────────────────────────────────

describe("GET /api/sso/oidc/callback — native leg", () => {
  it("needs no state cookie, sets no session cookie, and parks NO handoff code: the page carries only a single-use consent value", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const { consent, res } = await startNativeConsent(app);

    // A consent page, not a redirect: nothing has left the box's page yet.
    expect(res.headers.location).toBeUndefined();
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("Sign in to Droplet?");
    expect(res.text).toContain("Stefan Cruceru");
    expectNoSessionCookies(res);
    expect(createSession).not.toHaveBeenCalled();

    // ADR-063 S5: the callback stores no code. The page has no code in it and
    // the row has no code hash; only the sha256 of the consent value is parked.
    expect(res.text).not.toContain("code=");
    expect(consent).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = prisma._states[0];
    expect(row.consumedAt).toBeInstanceOf(Date);
    expect(row.handoffCodeHash).toBeNull();
    expect(row.handoffExpiresAt).toBeNull();
    expect(row.nativeConsentHash).toBe(createHash("sha256").update(consent).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(consent);
    expect(row.handoffUserId).toBe(stefan.id);
  });

  it("Continue is a POST that mints the code (sha256 only, 60 s) and 303s to the app's redirect with the app's state", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const before = Date.now();
    const { code, location, consent, consentRes } = await completeNativeCallback(app);

    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe(LOOPBACK);
    expect(url.searchParams.get("state")).toBe("st-nat");
    expect([...url.searchParams.keys()]).toEqual(["code", "state"]);
    // 32 random bytes, base64url.
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(consentRes.headers["cache-control"]).toBe("no-store");
    expect(consentRes.headers["referrer-policy"]).toBe("no-referrer");
    expectNoSessionCookies(consentRes);
    expect(createSession).not.toHaveBeenCalled();

    const row = prisma._states[0];
    expect(row.handoffCodeHash).toBe(createHash("sha256").update(code).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(code);
    // The consent value is spent by the same claim.
    expect(row.nativeConsentHash).toBeNull();
    expect(JSON.stringify(row)).not.toContain(consent);
    const ttlMs = row.handoffExpiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan(55_000);
    expect(ttlMs).toBeLessThanOrEqual(61_000);
    expect(row.handoffConsumedAt).toBeNull();
  });

  it("the 60 s clock starts at Continue, not when the page was shown: a person who took minutes (an IdP MFA prompt) still gets a redeemable code", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const app = buildApp(createPrismaMock());
      const page = await startNativeConsent(app);
      // Five minutes on the page, inside the state row's 10 minutes.
      vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
      const cont = await request(app).post(CONSENT_PATH).type("form").send({ consent: page.consent, decision: "approve" });
      expect(cont.status).toBe(303);
      const code = new URL(cont.headers.location as string).searchParams.get("code");

      const res = await request(app)
        .post("/api/sso/oidc/native/token")
        .send({ code, codeVerifier: page.verifier });
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the page lives no longer than the state row: after its 10 minutes Continue is refused and no code is minted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const prisma = createPrismaMock();
      const app = buildApp(prisma);
      const page = await startNativeConsent(app);
      vi.setSystemTime(new Date(Date.now() + 10 * 60_000 + 1000));

      const cont = await request(app).post(CONSENT_PATH).type("form").send({ consent: page.consent, decision: "approve" });

      expect(cont.status).toBe(400);
      expect(cont.body.code).toBe("SSO_CONSENT_INVALID");
      expect(cont.headers.location).toBeUndefined();
      expect(prisma._states[0].handoffCodeHash).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the consent value is single-use: a second Continue (replay, double click) mints nothing and is not audited again", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const { consent, code } = await completeNativeCallback(app);
    const codeHash = prisma._states[0].handoffCodeHash;

    const again = await request(app).post(CONSENT_PATH).type("form").send({ consent, decision: "approve" });

    expect(again.status).toBe(400);
    expect(again.body.code).toBe("SSO_CONSENT_INVALID");
    expect(again.headers.location).toBeUndefined();
    expect(prisma._states[0].handoffCodeHash).toBe(codeHash);
    expect(code).not.toBe("");
    expect(recordActivity).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no body", {}],
    ["an empty value", { consent: "", decision: "approve" }],
    ["a malformed value", { consent: "not a consent value", decision: "approve" }],
    ["an unknown value", { consent: "A".repeat(43), decision: "approve" }],
    ["an unknown value on Cancel", { consent: "A".repeat(43), decision: "deny" }],
  ])("refuses Continue with %s (400) and mints no code", async (_label, body) => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    await startNativeConsent(app);

    const res = await request(app).post(CONSENT_PATH).type("form").send(body);

    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(prisma._states[0].handoffCodeHash).toBeNull();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("a wrong consent value leaves the real page usable", async () => {
    const app = buildApp(createPrismaMock());
    const first = await startNativeConsent(app);
    const bogus = await request(app).post(CONSENT_PATH).type("form").send({ consent: "B".repeat(43), decision: "approve" });
    expect(bogus.status).toBe(400);
    const cont = await request(app).post(CONSENT_PATH).type("form").send({ consent: first.consent, decision: "approve" });
    expect(cont.status).toBe(303);
  });

  it("audits the approval: one activity row when the person presses Continue, naming the person and provider, never the code or the consent value", async () => {
    const app = buildApp(createPrismaMock());
    const { code, consent, verifier } = await completeNativeCallback(app);

    expect(recordActivity).toHaveBeenCalledTimes(1);
    const row = recordActivity.mock.calls[0]![0];
    expect(row).toMatchObject({
      kind: "auth",
      severity: "ok",
      actor: { type: "user", id: stefan.id },
      refs: { outcome: "consent_approved", method: "sso-native", provider: "google", userId: stefan.id },
    });
    expect(row.what).toContain("approved");
    const logged = JSON.stringify(recordActivity.mock.calls);
    for (const secret of [code, consent, verifier]) expect(logged).not.toContain(secret);
  });

  it("Cancel burns the consent value, audits consent_denied with the person and IP, and 303s to the app with error=access_denied and its state", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const { consent } = await startNativeConsent(app);

    const res = await request(app).post(CONSENT_PATH).type("form").send({ consent, decision: "deny" });

    expect(res.status).toBe(303);
    expect(res.headers["cache-control"]).toBe("no-store");
    const url = new URL(res.headers.location as string);
    expect(`${url.origin}${url.pathname}`).toBe(LOOPBACK);
    expect([...url.searchParams.keys()].sort()).toEqual(["error", "state"]);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("st-nat");
    expect(prisma._states[0].nativeConsentHash).toBeNull();
    expect(prisma._states[0].handoffCodeHash).toBeNull();

    expect(recordActivity).toHaveBeenCalledTimes(1);
    const row = recordActivity.mock.calls[0]![0];
    expect(row).toMatchObject({
      kind: "auth",
      severity: "warn",
      actor: { type: "user", id: stefan.id },
      refs: { outcome: "consent_denied", method: "sso-native", provider: "google", userId: stefan.id },
    });
    expect(row.refs.ip).toEqual(expect.any(String));
    expect(JSON.stringify(recordActivity.mock.calls)).not.toContain(consent);
  });

  it("after Cancel, Continue on the same page mints nothing; after Continue, Cancel does nothing", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const page = await startNativeConsent(app);
    expect(
      (await request(app).post(CONSENT_PATH).type("form").send({ consent: page.consent, decision: "deny" })).status,
    ).toBe(303);
    const cont = await request(app).post(CONSENT_PATH).type("form").send({ consent: page.consent, decision: "approve" });
    expect(cont.status).toBe(400);
    expect(cont.body.code).toBe("SSO_CONSENT_INVALID");
    expect(prisma._states[0].handoffCodeHash).toBeNull();
    expect(recordActivity).toHaveBeenCalledTimes(1);

    const prisma2 = createPrismaMock();
    const app2 = buildApp(prisma2);
    const done = await completeNativeCallback(app2);
    const codeHash = prisma2._states[0].handoffCodeHash;
    recordActivity.mockClear();
    const cancel = await request(app2).post(CONSENT_PATH).type("form").send({ consent: done.consent, decision: "deny" });
    expect(cancel.status).toBe(400);
    expect(cancel.headers.location).toBeUndefined();
    expect(prisma2._states[0].handoffCodeHash).toBe(codeHash);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("refuses Cancel on an expired page (400) and audits nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const prisma = createPrismaMock();
      const app = buildApp(prisma);
      const page = await startNativeConsent(app);
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      const res = await request(app).post(CONSENT_PATH).type("form").send({ consent: page.consent, decision: "deny" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("SSO_CONSENT_INVALID");
      expect(res.headers.location).toBeUndefined();
      expect(recordActivity).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a missing or unknown decision (400): Continue and Cancel are never inferred", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const page = await startNativeConsent(app);
    for (const body of [{ consent: page.consent }, { consent: page.consent, decision: "yes" }]) {
      const res = await request(app).post(CONSENT_PATH).type("form").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_REQUEST");
    }
    expect(prisma._states[0].nativeConsentHash).not.toBeNull();
    expect(prisma._states[0].handoffCodeHash).toBeNull();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("consent page (RFC 8252 §8.6): Continue and Cancel are same-origin POST forms carrying the consent value and an explicit decision, no links; the page cannot be framed, cached or scripted", async () => {
    const app = buildApp(createPrismaMock());
    const { consent, res } = await startNativeConsent(app);

    const forms = [...res.text.matchAll(/<form method="post" action="native\/consent">(.*?)<\/form>/g)].map(
      (m) => m[1]!,
    );
    expect(forms).toHaveLength(2);
    expect(res.text.match(/<form/g)).toHaveLength(2);
    expect(forms[0]).toContain(`name="consent" value="${consent}"`);
    expect(forms[0]).toContain('name="decision" value="approve"');
    expect(forms[0]).toContain(">Continue</button>");
    expect(forms[1]).toContain(`name="consent" value="${consent}"`);
    expect(forms[1]).toContain('name="decision" value="deny"');
    expect(forms[1]).toContain(">Cancel</button>");
    // No GET link to the app's redirect: Cancel must go through the box.
    expect(hrefs(res.text)).toEqual([]);

    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    // The form may post to this box and be redirected to the app, nowhere else.
    expect(csp).toContain("form-action 'self' http://127.0.0.1:49152");
    expect(res.text).not.toMatch(/<script/i);
  });

  it("lets the form redirect to the private-use scheme, and names the Droplet app for it and any local app for a loopback redirect", async () => {
    const scheme = await startNativeConsent(buildApp(createPrismaMock()), "droplet://sso/callback");
    expect(scheme.res.text).toContain("the Droplet app on this computer");
    expect(scheme.res.headers["content-security-policy"]).toContain("form-action 'self' droplet:");
    const loop = await startNativeConsent(buildApp(createPrismaMock()));
    expect(loop.res.text).toContain("an app running on this computer");
  });

  it("an IPv6 loopback redirect gets a valid form-action source (CSP host-source has no IPv6 literal)", async () => {
    const v6 = await startNativeConsent(buildApp(createPrismaMock()), "http://[::1]:49152/callback");
    const csp = v6.res.headers["content-security-policy"] as string;
    expect(csp).toContain("form-action 'self' http:;");
    expect(csp).not.toContain("[::1]");
  });

  it("does not audit a sign-in at the callback (the approval is audited at Continue, the sign-in at redemption)", async () => {
    const app = buildApp(createPrismaMock());
    await startNativeConsent(app);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("hands off to the private-use scheme too", async () => {
    const app = buildApp(createPrismaMock());
    const { location } = await completeNativeCallback(app, "droplet://sso/callback");
    expect(location).toMatch(/^droplet:\/\/sso\/callback\?code=[A-Za-z0-9_-]{43}&state=st-nat$/);
  });

  it("refuses a replayed callback for the same native state", async () => {
    const app = buildApp(createPrismaMock());
    await completeNativeCallback(app);
    const again = await request(app).get("/api/sso/oidc/callback?code=idp-code&state=st-nat");
    expect(again.status).toBe(401);
    expectNoSessionCookies(again);
  });

  it("relays an ID-token validation failure to the app as error=sso_failed and mints no handoff", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    exchangeCodeAndValidate.mockRejectedValue(new Error("bad signature"));
    const { url } = await nativeCallbackRedirect(app, "code=idp-code&");
    expect(`${url.origin}${url.pathname}`).toBe(LOOPBACK);
    expect(url.searchParams.get("error")).toBe("sso_failed");
    expect(url.searchParams.get("state")).toBe("st-nat");
    expect(url.searchParams.has("code")).toBe(false);
    expect(prisma._states[0].handoffCodeHash).toBeNull();
    expect(recordActivity.mock.calls[0]![0].refs).toMatchObject({
      outcome: "validation_failed",
      method: "sso-native",
    });
  });

  it.each([
    ["access_denied", "access_denied", "idp_access_denied"],
    ["temporarily_unavailable", "temporarily_unavailable", "idp_error"],
    ["login_required", "login_required", "idp_error"],
    // Anything off the standard list (IdP-controlled text) collapses.
    ["<script>alert(1)</script>", "server_error", "idp_error"],
  ])("relays the IdP's error=%s to the app as error=%s and audits %s", async (idp, relayed, reason) => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const { res, url } = await nativeCallbackRedirect(
      app,
      `error=${encodeURIComponent(idp)}&error_description=${encodeURIComponent("user said no")}&`,
    );
    expect(`${url.origin}${url.pathname}`).toBe(LOOPBACK);
    expect(url.searchParams.get("error")).toBe(relayed);
    expect(url.searchParams.get("state")).toBe("st-nat");
    // The IdP's free text never reaches the app.
    expect([...url.searchParams.keys()].sort()).toEqual(["error", "state"]);
    expect(res.headers["cache-control"]).toBe("no-store");
    expectNoSessionCookies(res);
    // Single-use: the state is spent, nothing was parked, the IdP was never asked.
    expect(prisma._states[0].consumedAt).toBeInstanceOf(Date);
    expect(prisma._states[0].handoffCodeHash).toBeNull();
    expect(exchangeCodeAndValidate).not.toHaveBeenCalled();
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]![0]).toMatchObject({
      kind: "auth",
      refs: { outcome: reason, method: "sso-native", provider: "google" },
    });
  });

  it("relays a missing IdP code (no error either) as error=invalid_request", async () => {
    const prisma = createPrismaMock();
    const { url, res } = await nativeCallbackRedirect(buildApp(prisma), "");
    expect(url.searchParams.get("error")).toBe("invalid_request");
    expect(prisma._states[0].handoffCodeHash).toBeNull();
    expectNoSessionCookies(res);
  });

  it("relays an unverified IdP email as error=sso_email_unverified", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    exchangeCodeAndValidate.mockResolvedValue({
      sub: "google-sub-new",
      email: "new@warp.test",
      emailVerified: false,
      name: "New",
    });
    const { url } = await nativeCallbackRedirect(app, "code=idp-code&");
    expect(url.searchParams.get("error")).toBe("sso_email_unverified");
    expect(prisma._states[0].handoffCodeHash).toBeNull();
  });

  it("mints no handoff for a DEACTIVATED user and relays error=sso_failed", async () => {
    const prisma = createPrismaMock([{ ...stefan, directoryStatus: "DEACTIVATED" }]);
    const { url, res } = await nativeCallbackRedirect(buildApp(prisma), "code=idp-code&");
    expect(url.searchParams.get("error")).toBe("sso_failed");
    expect(prisma._states[0].handoffCodeHash).toBeNull();
    expect(prisma._states[0].nativeConsentHash).toBeNull();
    expectNoSessionCookies(res);
    expect(recordActivity.mock.calls[0]![0].refs).toMatchObject({ outcome: "no_usable_account" });
  });

  it("honours the TOTP gate #2436 put on the callback: a local-password account with TOTP gets error=totp_required and no handoff", async () => {
    const prisma = createPrismaMock([{ ...stefan, passwordHash: "$argon2id$mock" }]);
    const app = buildApp(prisma);
    checkLoginSecondFactor.mockResolvedValue("failed");
    const { url } = await nativeCallbackRedirect(app, "code=idp-code&");
    expect(url.searchParams.get("error")).toBe("totp_required");
    expect(prisma._states[0].handoffCodeHash).toBeNull();
    // One audit row (the gate's), not two.
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]![0].refs).toMatchObject({ outcome: "totp_required", method: "sso" });
  });

  it("an IdP-provisioned account (no local password) is not gated, as in the browser flow", async () => {
    const app = buildApp(createPrismaMock());
    checkLoginSecondFactor.mockResolvedValue("failed");
    const { code } = await completeNativeCallback(app);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(checkLoginSecondFactor).not.toHaveBeenCalled();
  });
});

describe("GET /api/sso/oidc/callback — browser leg unchanged", () => {
  async function browserAuthorize(app: express.Express) {
    buildAuthorizeRequest.mockResolvedValue({
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=st-web",
      state: "st-web",
      nonce: "no-web",
      codeVerifier: "box-verifier-web",
    });
    const res = await request(app).post("/api/sso/oidc/authorize").send({ provider: "google" });
    expect(res.status).toBe(302);
    return res;
  }

  it("still requires the state cookie: a BROWSER state without it is refused and left unconsumed", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    await browserAuthorize(app);
    expect(prisma._states[0].flowKind).toBe("BROWSER");

    const res = await request(app).get("/api/sso/oidc/callback?code=idp-code&state=st-web");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid SSO state" });
    expect(prisma._states[0].consumedAt).toBeNull();
    expect(prisma._states[0].handoffCodeHash).toBeNull();
    expect(exchangeCodeAndValidate).not.toHaveBeenCalled();
    expectNoSessionCookies(res);
  });

  it("with the cookie, still sets the session cookies and redirects to returnTo (no handoff)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    await browserAuthorize(app);

    const res = await request(app)
      .get("/api/sso/oidc/callback?code=idp-code&state=st-web")
      .set("Cookie", "droplet_sso_state=st-web");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
    const cookies = setCookies(res);
    const session = cookies.find((c) => c.startsWith("droplet_session="));
    expect(session).toBeDefined();
    expect(verifyAccessToken(session!.split(";")[0]!.replace("droplet_session=", ""))?.sub).toBe(
      stefan.id,
    );
    expect(cookies.some((c) => c.startsWith("droplet_refresh="))).toBe(true);
    expect(prisma._states[0].handoffCodeHash).toBeNull();
    // Browser audit row is unchanged (no native method stamp).
    expect(recordActivity.mock.calls[0]![0].refs.method).toBeUndefined();
  });
});

// ── token ───────────────────────────────────────────────────────────────────

describe("POST /api/sso/oidc/native/token", () => {
  it("redeems the handoff once and returns EXACTLY the /auth/login?return=body shape", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const { code, verifier } = await completeNativeCallback(app);

    const before = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post("/api/sso/oidc/native/token")
      .send({ code, codeVerifier: verifier });
    const after = Math.floor(Date.now() / 1000);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ["accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt", "user"].sort(),
    );
    expect(res.body.user).toEqual({
      id: stefan.id,
      username: "stefan",
      displayName: "Stefan Cruceru",
      role: "owner",
      mustChangePassword: false,
    });
    // Epoch SECONDS, same as the login body.
    expect(res.body.accessTokenExpiresAt).toBeGreaterThanOrEqual(before + ACCESS_TOKEN_TTL_SECONDS);
    expect(res.body.accessTokenExpiresAt).toBeLessThanOrEqual(after + ACCESS_TOKEN_TTL_SECONDS);
    expect(res.body.refreshTokenExpiresAt).toBeGreaterThanOrEqual(before + REFRESH_TOKEN_TTL_SECONDS);
    expect(res.body.refreshTokenExpiresAt).toBeLessThanOrEqual(after + REFRESH_TOKEN_TTL_SECONDS);

    const access = verifyAccessToken(res.body.accessToken);
    expect(access?.sub).toBe(stefan.id);
    expect(access?.sid).toBe("sid-native-0001");
    expect(access?.accessRoleId).toBeNull();
    expect(createSession).toHaveBeenCalledWith({ id: stefan.id, role: "owner" });
    expect(registerRefreshSession).toHaveBeenCalledWith(stefan.id, res.body.refreshToken);

    // Bearer-only: no cookies, not cacheable.
    expect(setCookies(res)).toEqual([]);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(prisma._states[0].handoffConsumedAt).toBeInstanceOf(Date);
  });

  it("refuses a replayed handoff", async () => {
    const app = buildApp(createPrismaMock());
    const { code, verifier } = await completeNativeCallback(app);
    const first = await request(app).post("/api/sso/oidc/native/token").send({ code, codeVerifier: verifier });
    expect(first.status).toBe(200);

    const replay = await request(app).post("/api/sso/oidc/native/token").send({ code, codeVerifier: verifier });

    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("SSO_HANDOFF_INVALID");
    expect(replay.body.accessToken).toBeUndefined();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("refuses a wrong verifier, and the attempt burns the code", async () => {
    const app = buildApp(createPrismaMock());
    const { code, verifier } = await completeNativeCallback(app);

    const wrong = await request(app)
      .post("/api/sso/oidc/native/token")
      .send({ code, codeVerifier: pkcePair().verifier });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("SSO_HANDOFF_INVALID");

    const retry = await request(app).post("/api/sso/oidc/native/token").send({ code, codeVerifier: verifier });
    expect(retry.status).toBe(401);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses an expired handoff", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const { code, verifier } = await completeNativeCallback(app);
    prisma._states[0].handoffExpiresAt = new Date(Date.now() - 1000);

    const res = await request(app).post("/api/sso/oidc/native/token").send({ code, codeVerifier: verifier });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SSO_HANDOFF_INVALID");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses an unknown code", async () => {
    const app = buildApp(createPrismaMock());
    await completeNativeCallback(app);
    const res = await request(app)
      .post("/api/sso/oidc/native/token")
      .send({ code: randomBytes(32).toString("base64url"), codeVerifier: pkcePair().verifier });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SSO_HANDOFF_INVALID");
  });

  it("refuses a user deactivated between the callback and the redemption", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const { code, verifier } = await completeNativeCallback(app);
    prisma._users[0].directoryStatus = "DEACTIVATED";

    const res = await request(app).post("/api/sso/oidc/native/token").send({ code, codeVerifier: verifier });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SSO_ACCOUNT_UNAVAILABLE");
    expect(res.body.accessToken).toBeUndefined();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("audits a successful redemption in the activity log — the sign-in, not the parked code", async () => {
    const app = buildApp(createPrismaMock());
    const { code, verifier } = await completeNativeCallback(app);
    // Only the approval (Continue) is in the log so far, not a sign-in.
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]![0].refs).toMatchObject({ outcome: "consent_approved" });
    recordActivity.mockClear();

    const res = await request(app).post("/api/sso/oidc/native/token").send({ code, codeVerifier: verifier });
    expect(res.status).toBe(200);

    expect(recordActivity).toHaveBeenCalledTimes(1);
    const entry = recordActivity.mock.calls[0]![0];
    expect(entry).toMatchObject({
      kind: "auth",
      severity: "ok",
      actor: { type: "user", id: stefan.id },
      refs: { outcome: "success", method: "sso-native", userId: stefan.id, provider: "google" },
    });
    // Neither the code, the verifier nor a token is written to the log.
    const logged = JSON.stringify(entry);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(verifier);
    expect(logged).not.toContain(res.body.accessToken);
  });

  it("audits a wrong verifier as pkce_mismatch with the provider and the user the code was for", async () => {
    const app = buildApp(createPrismaMock());
    const { code } = await completeNativeCallback(app);
    recordActivity.mockClear(); // the approval is covered above
    const res = await request(app)
      .post("/api/sso/oidc/native/token")
      .send({ code, codeVerifier: pkcePair().verifier });
    expect(res.status).toBe(401);
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]![0]).toMatchObject({
      kind: "auth",
      severity: "warn",
      refs: { outcome: "pkce_mismatch", method: "sso-native", provider: "google", userId: stefan.id },
    });
  });

  it("audits an unknown, replayed or expired code as invalid_or_expired_code", async () => {
    const app = buildApp(createPrismaMock());
    await completeNativeCallback(app);
    recordActivity.mockClear();
    const res = await request(app)
      .post("/api/sso/oidc/native/token")
      .send({ code: randomBytes(32).toString("base64url"), codeVerifier: pkcePair().verifier });
    expect(res.status).toBe(401);
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]![0]).toMatchObject({
      kind: "auth",
      severity: "warn",
      refs: { outcome: "invalid_or_expired_code", method: "sso-native" },
    });
  });

  it("audits a user deactivated between callback and redemption as account_unavailable", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const { code, verifier } = await completeNativeCallback(app);
    recordActivity.mockClear(); // the approval is covered above
    prisma._users[0].directoryStatus = "DEACTIVATED";
    await request(app).post("/api/sso/oidc/native/token").send({ code, codeVerifier: verifier });
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]![0].refs).toMatchObject({
      outcome: "account_unavailable",
      method: "sso-native",
      userId: stefan.id,
    });
  });

  it("does not audit a malformed request (no code was attempted)", async () => {
    const app = buildApp(createPrismaMock());
    await request(app).post("/api/sso/oidc/native/token").send({});
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("audits a refused browser context as browser_context (ADR-063 S8), at warn with an anonymous actor and no secrets", async () => {
    const app = buildApp(createPrismaMock());
    const code = "a".repeat(43);
    const codeVerifier = "b".repeat(43);
    const res = await request(app)
      .post("/api/sso/oidc/native/token")
      .set("Origin", "https://droplet-ai.local")
      .set("Sec-Fetch-Mode", "cors")
      .send({ code, codeVerifier });

    expect(res.status).toBe(403);
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]![0]).toMatchObject({
      kind: "auth",
      severity: "warn",
      actor: { type: "anonymous" },
      refs: { outcome: "browser_context", method: "sso-native" },
    });
    const logged = JSON.stringify(recordActivity.mock.calls);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(codeVerifier);
  });

  it("re-checks the TOTP gate at redemption: a factor enrolled after the callback refuses the session", async () => {
    const prisma = createPrismaMock([{ ...stefan, passwordHash: "$argon2id$mock" }]);
    const app = buildApp(prisma);
    const { code, verifier } = await completeNativeCallback(app);
    recordActivity.mockClear(); // the approval is covered above
    checkLoginSecondFactor.mockResolvedValue("failed");

    const res = await request(app).post("/api/sso/oidc/native/token").send({ code, codeVerifier: verifier });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOTP_REQUIRED");
    expect(res.body.accessToken).toBeUndefined();
    expect(createSession).not.toHaveBeenCalled();
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]![0].refs).toMatchObject({ outcome: "totp_required", method: "sso-native" });
  });

  it("refuses a browser context without burning the code (WARP-582 posture)", async () => {
    const app = buildApp(createPrismaMock());
    const { code, verifier } = await completeNativeCallback(app);

    const fromBrowser = await request(app)
      .post("/api/sso/oidc/native/token")
      .set("Origin", "https://droplet-ai.local")
      .set("Sec-Fetch-Mode", "cors")
      .send({ code, codeVerifier: verifier });
    expect(fromBrowser.status).toBe(403);
    expect(fromBrowser.body.code).toBe("NATIVE_CLIENT_REQUIRED");
    expect(fromBrowser.body.accessToken).toBeUndefined();

    const native = await request(app).post("/api/sso/oidc/native/token").send({ code, codeVerifier: verifier });
    expect(native.status).toBe(200);
  });

  it.each([
    ["no body", {}],
    ["a short code", { code: "abc", codeVerifier: "a".repeat(43) }],
    ["a short verifier (< 43, RFC 7636)", { code: "a".repeat(43), codeVerifier: "a".repeat(42) }],
    ["a long verifier (> 128)", { code: "a".repeat(43), codeVerifier: "a".repeat(129) }],
    ["a verifier outside the unreserved set", { code: "a".repeat(43), codeVerifier: `${"a".repeat(42)}+` }],
  ])("rejects %s → 400 INVALID_REQUEST", async (_label, body) => {
    const res = await request(buildApp(createPrismaMock())).post("/api/sso/oidc/native/token").send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUEST");
  });
});

// ── The two review minors: IP on the audit rows, server_error relay ─────────

describe("native SSO audit rows carry the caller's IP", () => {
  it("on a relayed callback failure, the approval and the redemption", async () => {
    const app = buildApp(createPrismaMock());
    await nativeCallbackRedirect(app, "error=access_denied&");
    expect(recordActivity.mock.calls[0]![0].refs.ip).toEqual(expect.any(String));
    recordActivity.mockClear();

    const app2 = buildApp(createPrismaMock());
    const { code, verifier } = await completeNativeCallback(app2);
    expect(recordActivity.mock.calls[0]![0].refs).toMatchObject({ outcome: "consent_approved" });
    expect(recordActivity.mock.calls[0]![0].refs.ip).toEqual(expect.any(String));
    recordActivity.mockClear();

    const res = await request(app2).post("/api/sso/oidc/native/token").send({ code, codeVerifier: verifier });
    expect(res.status).toBe(200);
    expect(recordActivity.mock.calls[0]![0].refs).toMatchObject({ outcome: "success" });
    expect(recordActivity.mock.calls[0]![0].refs.ip).toEqual(expect.any(String));
  });

  it("on the TOTP gate's row, which is also the native relay's audit", async () => {
    const app = buildApp(createPrismaMock([{ ...stefan, passwordHash: "$argon2id$mock" }]));
    checkLoginSecondFactor.mockResolvedValue("failed");
    await nativeCallbackRedirect(app, "code=idp-code&");
    expect(recordActivity.mock.calls[0]![0].refs.ip).toEqual(expect.any(String));
  });
});

describe("an unexpected failure after the native state is claimed", () => {
  it("is relayed to the app as error=server_error and audited, minting nothing", async () => {
    const prisma = createPrismaMock();
    prisma.ssoIdentity.findUnique.mockRejectedValue(new Error("db down"));
    const { res, url } = await nativeCallbackRedirect(buildApp(prisma), "code=idp-code&");
    expect(`${url.origin}${url.pathname}`).toBe(LOOPBACK);
    expect([...url.searchParams.keys()].sort()).toEqual(["error", "state"]);
    expect(url.searchParams.get("error")).toBe("server_error");
    expect(url.searchParams.get("state")).toBe("st-nat");
    expectNoSessionCookies(res);
    expect(prisma._states[0].nativeConsentHash).toBeNull();
    expect(prisma._states[0].handoffCodeHash).toBeNull();
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]![0].refs).toMatchObject({
      outcome: "unexpected_error",
      method: "sso-native",
      error: "server_error",
    });
    // The exception text stays in the log, never in the redirect or the audit.
    expect(res.headers.location).not.toContain("db down");
    expect(JSON.stringify(recordActivity.mock.calls)).not.toContain("db down");
  });

  it("is relayed when parking the consent fails", async () => {
    const prisma = createPrismaMock();
    const realUpdateMany = prisma.ssoLoginState.updateMany;
    prisma.ssoLoginState.updateMany = vi.fn(async (args: { where: Row; data: Row }) =>
      "nativeConsentHash" in args.data && args.data.nativeConsentHash !== null
        ? { count: 0 }
        : realUpdateMany(args),
    );
    const { url } = await nativeCallbackRedirect(buildApp(prisma), "code=idp-code&");
    expect(url.searchParams.get("error")).toBe("server_error");
  });

  it("falls through to the error handler (500) if the relay's own audit write fails", async () => {
    const prisma = createPrismaMock();
    prisma.ssoIdentity.findUnique.mockRejectedValue(new Error("db down"));
    recordActivity.mockRejectedValueOnce(new Error("audit down"));
    const app = buildApp(prisma);
    expect((await begin(app)).status).toBe(200);
    const res = await request(app).get("/api/sso/oidc/callback?code=idp-code&state=st-nat");
    expect(res.status).toBe(500);
    expect(res.headers.location).toBeUndefined();
  });

  it("leaves the browser flow on the error handler (500), as before", async () => {
    const prisma = createPrismaMock();
    prisma.ssoIdentity.findUnique.mockRejectedValue(new Error("db down"));
    const app = buildApp(prisma);
    buildAuthorizeRequest.mockResolvedValue({
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=st-br",
      state: "st-br",
      nonce: "no-br",
      codeVerifier: "box-verifier-br",
    });
    const auth = await request(app).post("/api/sso/oidc/authorize").send({ provider: "google" });
    expect(auth.status).toBe(302);
    const res = await request(app)
      .get("/api/sso/oidc/callback?code=idp-code&state=st-br")
      .set("Cookie", "droplet_sso_state=st-br");
    expect(res.status).toBe(500);
    expect(res.headers.location).toBeUndefined();
    expect(recordActivity).not.toHaveBeenCalled();
  });
});
