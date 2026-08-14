/**
 * WARP-1726 (third pass) — the session/refresh cookie PAIR is an invariant.
 *
 * The dashboard short-circuits its `/api/auth/me` probe on exactly one refresh
 * answer: a 401 carrying NO_REFRESH_TOKEN (apps/web-dashboard/src/lib/auth.tsx).
 * It treats "you presented no refresh credential" as proof there is no session
 * left to rescue, and logs the user out without asking a second question.
 *
 * That inference is only sound because of a property of THIS service, not of
 * the client: a browser can never be holding a live session cookie while
 * holding no refresh cookie. Two directions keep it true —
 *
 *   1. every site that MINTS a session cookie mints a refresh cookie with it,
 *      so the pair is always born together; and
 *   2. every clear that REMOVES the refresh cookie removes the session cookie
 *      too, so the pair is always destroyed together.
 *
 * Break either one — a future route that mints a session cookie alone, or an
 * error branch that drops only the refresh cookie — and the short-circuit
 * silently starts ending live sessions. That is the false logout WARP-1726
 * exists to remove, re-entering through the server instead of the client.
 * Nothing enforced this: the only existing coverage of the pairing is the
 * OAuth callback in `oauth2.test.ts`.
 *
 * The assertions are behavioural: real route handlers under supertest, real
 * JWT signers, and the invariant read off the real `Set-Cookie` headers a
 * browser would receive. Cookie NAMES are asserted as wire literals on
 * purpose — the dashboard has no import of the server's constants, so the
 * string on the wire is the actual contract between the two.
 *
 * Harness mirrors auth.return-body-gate.test.ts (NC client, nc-session,
 * password.service, session.service and the jwt.service side effects mocked).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "legacy",
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheIncr: vi.fn().mockResolvedValue(1),
}));

vi.mock("../services/nextcloud.client.js", () => ({
  ncCheckSetupRequired: vi.fn(),
  ncInstallAndCreateAdmin: vi.fn().mockResolvedValue(undefined),
  ncLoginWithCredentials: vi.fn().mockResolvedValue({ token: "nc", loginName: "x" }),
  ncDeleteAppPassword: vi.fn().mockResolvedValue(undefined),
  ncGetCurrentUser: vi.fn(),
  ncCreateUser: vi.fn().mockResolvedValue(undefined),
  ncDeleteUser: vi.fn(),
  ncListUsers: vi.fn(),
  ncUpdateUser: vi.fn().mockResolvedValue(undefined),
  ncSetUserEnabled: vi.fn(),
  ncOAuth2AuthorizeUrl: vi.fn(),
  ncOAuth2ExchangeCode: vi.fn(),
  ncOAuth2RefreshToken: vi.fn(),
  NextcloudUserExistsError: class extends Error {},
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: vi.fn().mockResolvedValue(undefined),
  getNcToken: vi.fn().mockResolvedValue(null),
  deleteNcToken: vi.fn().mockResolvedValue(undefined),
  touchNcToken: vi.fn().mockResolvedValue(undefined),
  resolveNcToken: vi.fn().mockResolvedValue("tok"),
}));

vi.mock("../services/password.service.js", () => ({
  hashPassword: vi.fn(async () => "$argon2id$stub"),
  verifyPassword: vi.fn().mockResolvedValue(true),
  verifyDummyPassword: vi.fn().mockResolvedValue(false),
}));

vi.mock("../services/jwt.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/jwt.service.js")>(
    "../services/jwt.service.js",
  );
  return {
    ...actual,
    denyRefreshToken: vi.fn().mockResolvedValue(undefined),
    claimRefreshRotation: vi.fn().mockResolvedValue(true),
    registerRefreshSession: vi.fn().mockResolvedValue(undefined),
    unregisterRefreshSession: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../services/session.service.js", () => ({
  createSession: vi.fn(async () => ({ sid: "sid-pairing-0001", evictedSids: [] })),
  deleteSession: vi.fn(async () => undefined),
  checkSession: vi.fn(async () => ({
    kind: "ok",
    record: { userId: "u-1", role: "family", createdAt: 0, lastSeenAt: 0 },
  })),
  revokeAllSessions: vi.fn(async () => 0),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

import { checkSession } from "../services/session.service.js";
import { createPublicAuthRouter } from "./auth.js";

/**
 * The names as they appear on the wire. The dashboard never imports the
 * server's constants — it only ever sees these strings — so pinning the
 * literals is pinning the actual cross-service contract.
 */
const SESSION_COOKIE = "droplet_session";
const REFRESH_COOKIE = "droplet_refresh";

const aliceRow = {
  id: "u-uuid-alice-1",
  username: "alice",
  displayName: "Alice",
  email: "alice@warp.test",
  nextcloudUsername: "alice",
  passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
  role: "family",
  isLocal: true,
  directoryStatus: "ACTIVE",
  mustChangePassword: false,
  accessRoleId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createPrismaMock() {
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.email === aliceRow.email || where.id === aliceRow.id) return aliceRow;
        return null;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.email === aliceRow.email ? aliceRow : null,
      ),
      update: vi.fn(async () => aliceRow),
    },
    totpCredential: { findUnique: vi.fn(async () => null) },
    recoveryCode: { findMany: vi.fn(async () => []) },
  };
}

function publicApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", createPublicAuthRouter(createPrismaMock() as never));
  return app;
}

const CREDS = { email: "alice@warp.test", password: "hunter22hunter22" };

type EmittedCookie = {
  name: string;
  value: string;
  path: string | null;
  /** An empty value is how Express spells "delete this cookie". */
  cleared: boolean;
};

/** Parse the real Set-Cookie lines a browser would act on. */
function emittedCookies(res: request.Response): EmittedCookie[] {
  const raw = res.headers["set-cookie"] as unknown;
  const lines = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  return lines.map((line) => {
    const [pair, ...attrs] = line.split(";");
    const eq = pair!.indexOf("=");
    const value = eq === -1 ? "" : pair!.slice(eq + 1).trim();
    const pathAttr = attrs
      .map((a) => a.trim())
      .find((a) => a.toLowerCase().startsWith("path="));
    return {
      name: (eq === -1 ? pair! : pair!.slice(0, eq)).trim(),
      value,
      path: pathAttr ? pathAttr.slice("path=".length) : null,
      cleared: value === "",
    };
  });
}

const findCookie = (res: request.Response, name: string) =>
  emittedCookies(res).find((c) => c.name === name);

/**
 * The invariant itself, in one place so every response below is held to the
 * same standard — and so a future route can be added to this file for free.
 */
function expectCookiesMoveInLockstep(res: request.Response, label: string) {
  const session = findCookie(res, SESSION_COOKIE);
  const refresh = findCookie(res, REFRESH_COOKIE);

  if (session && !session.cleared) {
    // Direction 1: a session cookie is never minted alone. If it were, the
    // browser would hold a live session with no refresh credential, and the
    // next 401 would refresh → NO_REFRESH_TOKEN → immediate logout.
    expect(refresh, `${label}: minted a session cookie without a refresh cookie`).toBeDefined();
    expect(refresh!.cleared, `${label}: minted a session cookie while clearing the refresh cookie`).toBe(false);
  }

  if (refresh?.cleared) {
    // Direction 2: the refresh cookie is never dropped alone — that would
    // strand the same live-session-without-refresh state from the other side.
    expect(session, `${label}: cleared the refresh cookie without clearing the session cookie`).toBeDefined();
    expect(session!.cleared, `${label}: cleared the refresh cookie but left the session cookie set`).toBe(true);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("session and refresh cookies are minted and cleared as a PAIR (WARP-1726)", () => {
  it("POST /api/auth/login — the primary login path mints both, correctly scoped", async () => {
    const res = await request(publicApp()).post("/api/auth/login").send(CREDS);

    expect(res.status).toBe(200);

    const session = findCookie(res, SESSION_COOKIE);
    const refresh = findCookie(res, REFRESH_COOKIE);

    expect(session?.value, "login set no session cookie").toBeTruthy();
    expect(refresh?.value, "login set no refresh cookie").toBeTruthy();
    // The scopes are load-bearing too: the refresh cookie is deliberately
    // narrower than the session cookie, which is why the browser can present a
    // session on /api/network/* while the refresh cookie rides only /api/auth.
    expect(session?.path).toBe("/");
    expect(refresh?.path).toBe("/api/auth");

    expectCookiesMoveInLockstep(res, "login");
  });

  it("POST /api/auth/refresh — rotation re-mints both, never a lone session", async () => {
    const app = publicApp();

    const login = await request(app).post("/api/auth/login").send(CREDS);
    const refreshCookie = findCookie(login, REFRESH_COOKIE);
    expect(refreshCookie?.value).toBeTruthy();

    const rotated = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${refreshCookie!.value}`);

    expect(rotated.status).toBe(200);

    const session = findCookie(rotated, SESSION_COOKIE);
    const refresh = findCookie(rotated, REFRESH_COOKIE);
    expect(session?.value, "rotation set no session cookie").toBeTruthy();
    expect(refresh?.value, "rotation set no refresh cookie").toBeTruthy();
    // Rotation replaces the pair; it must not hand back the token it just
    // denylisted, or the next refresh presents a burned credential.
    expect(refresh!.value).not.toBe(refreshCookie!.value);
    expect(refresh?.path).toBe("/api/auth");

    expectCookiesMoveInLockstep(rotated, "refresh rotation");
  });

  it("POST /api/auth/refresh on a dead session — clears both, never the refresh alone", async () => {
    const app = publicApp();

    const login = await request(app).post("/api/auth/login").send(CREDS);
    const refreshCookie = findCookie(login, REFRESH_COOKIE);

    // The session record is gone (revoked, or idle/absolute timeout), which is
    // the branch that burns the token and tears the cookie pair down.
    (checkSession as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce({ kind: "missing" });

    const dead = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${refreshCookie!.value}`);

    expect(dead.status).toBe(401);
    expect(dead.body).toMatchObject({ code: "SESSION_EXPIRED" });

    expect(findCookie(dead, REFRESH_COOKIE)?.cleared, "refresh cookie was not cleared").toBe(true);
    expect(findCookie(dead, SESSION_COOKIE)?.cleared, "session cookie was left behind").toBe(true);

    expectCookiesMoveInLockstep(dead, "refresh on a dead session");
  });

  it("POST /api/auth/refresh with NO credential — answers NO_REFRESH_TOKEN and touches no cookie", async () => {
    // The answer the dashboard's short-circuit keys on. Nothing was presented,
    // so nothing is burned and nothing is cleared — the response must not
    // disturb a cookie jar it never inspected.
    const res = await request(publicApp()).post("/api/auth/refresh");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "NO_REFRESH_TOKEN" });
    expect(emittedCookies(res)).toEqual([]);

    expectCookiesMoveInLockstep(res, "refresh with no credential");
  });
});
