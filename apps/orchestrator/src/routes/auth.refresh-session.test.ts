/**
 * WARP-247 — /auth/refresh gated on a live session record.
 *
 * Shares the mock header from auth.session-mint.test.ts (real route handlers
 * via supertest, real JWT signers, NC client + nc-session + password.service
 * mocked) with session.service mocked so each test can drive the checkSession
 * outcome and assert the rotation gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

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

const createSession = vi.fn(
  async (_user?: { id: string; role: string }) => ({ sid: "sid-mint-0001", evictedSids: [] }),
);
const deleteSession = vi.fn(async (_userId?: string, _sid?: string) => undefined);
vi.mock("../services/session.service.js", () => ({
  createSession: (...a: unknown[]) => createSession(...(a as [{ id: string; role: string }])),
  deleteSession: (...a: unknown[]) => deleteSession(...(a as [string, string])),
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

import { createPublicAuthRouter } from "./auth.js";
import { signRefreshToken } from "../services/jwt.service.js";
import { denyRefreshToken, claimRefreshRotation } from "../services/jwt.service.js";
import { checkSession } from "../services/session.service.js";

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
      // WARP-233 pre-backfill fallback probe (plaintext row, no blind index).
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.email === aliceRow.email ? aliceRow : null,
      ),
      update: vi.fn(async () => aliceRow),
    },
    totpCredential: { findUnique: vi.fn(async () => null) },
    recoveryCode: { findMany: vi.fn(async () => []) },
  };
}

function publicApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", createPublicAuthRouter(prisma as never));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  createSession.mockResolvedValue({ sid: "sid-mint-0001", evictedSids: [] });
  // `vi.clearAllMocks()` only drops recorded calls — a per-test
  // `mockImplementation` survives it — so re-arm the happy-path claim here.
  (claimRefreshRotation as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

async function loginAndGetRefreshToken(app: ReturnType<typeof publicApp>) {
  const res = await request(app)
    .post("/api/auth/login?return=body=1")
    .send({ email: "alice@warp.test", password: "hunter22hunter22" });
  expect(res.status).toBe(200);
  return res.body.refreshToken as string;
}

describe("POST /api/auth/refresh — WARP-247 session gate", () => {
  it("rotates when the session record is live, keeping the same sid and NOT touching lastSeenAt", async () => {
    const app = publicApp(createPrismaMock());
    const refreshToken = await loginAndGetRefreshToken(app);

    (checkSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: "ok",
      record: { userId: "u-uuid-alice-1", role: "family", createdAt: 0, lastSeenAt: 0 },
    });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken });

    expect(res.status).toBe(200);
    expect(checkSession).toHaveBeenCalledWith("sid-mint-0001", { touch: false });
    const newAccess = jwt.decode(res.body.accessToken) as { sid?: string };
    const newRefresh = jwt.decode(res.body.refreshToken) as { sid?: string };
    expect(newAccess.sid).toBe("sid-mint-0001");
    expect(newRefresh.sid).toBe("sid-mint-0001");
  });

  it("refuses rotation, burns the token, and clears cookies when the record is missing", async () => {
    const app = publicApp(createPrismaMock());
    const refreshToken = await loginAndGetRefreshToken(app);

    (checkSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: "missing" });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_EXPIRED");
    expect(res.body.reason).toBe("revoked");
    expect(denyRefreshToken).toHaveBeenCalledWith(refreshToken);
  });

  it("refuses rotation with the timeout reason when the session is idle-expired", async () => {
    const app = publicApp(createPrismaMock());
    const refreshToken = await loginAndGetRefreshToken(app);

    (checkSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: "expired",
      reason: "idle_timeout",
    });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "SESSION_EXPIRED", reason: "idle_timeout" });
  });

  it("fails OPEN on a Redis error (rotation proceeds — denylist already checked)", async () => {
    const app = publicApp(createPrismaMock());
    const refreshToken = await loginAndGetRefreshToken(app);

    (checkSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: "error" });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(200);
  });

  it("refuses a legacy sid-less refresh token outright (one forced re-login per device)", async () => {
    const app = publicApp(createPrismaMock());
    const legacyRefresh = signRefreshToken({
      id: "u-uuid-alice-1",
      username: "alice",
      displayName: "Alice",
      role: "family",
    });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: legacyRefresh });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "SESSION_EXPIRED", reason: "revoked" });
    expect(checkSession).not.toHaveBeenCalled();
  });
});

/**
 * WARP-1726 — the rotation-conflict 401 must be DISTINGUISHABLE from a dead
 * session.
 *
 * The dashboard polls the Network tab from many hooks at once, so when the
 * access token expires several requests 401 together and race into
 * `/auth/refresh`. `claimRefreshRotation` lets exactly one of them through;
 * the losers used to get a bare 401 with only a human message, which the
 * dashboard's `authFetch` read as "session is dead" → clear the cached user →
 * hard-navigate to /login. That full page load is the reload loop users see.
 *
 * The claim itself is unchanged (the loser is still rejected — that's what
 * stops two live token pairs existing for one refresh token); we only LABEL
 * the answer so the client can tell "someone else is rotating, retry in a
 * moment" from "log in again".
 */
describe("POST /api/auth/refresh — rotation-conflict labelling (WARP-1726)", () => {
  it("answers the loser of two concurrent refreshes with 401 + ROTATION_IN_FLIGHT", async () => {
    const app = publicApp(createPrismaMock());
    const refreshToken = await loginAndGetRefreshToken(app);

    // Model the real single-claim semantics: the first caller takes the claim,
    // every later caller loses it until it expires.
    let claimTaken = false;
    (claimRefreshRotation as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (claimTaken) return false;
      claimTaken = true;
      return true;
    });

    const [first, second] = await Promise.all([
      request(app).post("/api/auth/refresh").send({ refreshToken }),
      request(app).post("/api/auth/refresh").send({ refreshToken }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 401]);
    const loser = first.status === 401 ? first : second;
    expect(loser.body).toMatchObject({
      error: "Refresh token is already being rotated",
      code: "ROTATION_IN_FLIGHT",
    });
  });

  it("rejects the losing claim without burning the token or clearing cookies", async () => {
    const app = publicApp(createPrismaMock());
    const refreshToken = await loginAndGetRefreshToken(app);

    (claimRefreshRotation as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("ROTATION_IN_FLIGHT");
    // Security posture unchanged: no new token pair for the loser…
    expect(res.body.accessToken).toBeUndefined();
    // …and the token stays live for the winner's rotation to consume, so the
    // conflict must NOT denylist it or tear the browser's cookies down.
    expect(denyRefreshToken).not.toHaveBeenCalledWith(refreshToken);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  // The dead-session 401 keeps its OWN code — the client branches on these two
  // being different, so a regression that collapsed them would be silent.
  it("keeps SESSION_EXPIRED distinct from ROTATION_IN_FLIGHT", async () => {
    const app = publicApp(createPrismaMock());
    const refreshToken = await loginAndGetRefreshToken(app);

    (checkSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: "missing" });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_EXPIRED");
  });
});

/**
 * WARP-1726 (second pass) — "you presented no refresh token" is the one 401 the
 * server can answer DEFINITIVELY without the client checking its work.
 *
 * Every anonymous page load walks /api/auth/me → 401 → /api/auth/refresh. That
 * refresh has no cookie and no body token, so it cannot possibly rotate
 * anything. Unlabelled, the dashboard could not tell it from a 401 it had to
 * verify, and spent a THIRD request (/api/auth/me again) re-confirming what the
 * server already knew for certain — on every anonymous cold boot. Labelling it
 * lets the client skip that probe. The status stays 401: only the code is new.
 */
describe("POST /api/auth/refresh — the no-token 401 is labelled (WARP-1726)", () => {
  it("answers a cookieless, bodyless refresh with 401 + NO_REFRESH_TOKEN", async () => {
    const app = publicApp(createPrismaMock());

    const res = await request(app).post("/api/auth/refresh").send({});

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: "No refresh token available",
      code: "NO_REFRESH_TOKEN",
    });
  });

  it("does not burn a token or clear cookies — there was nothing to act on", async () => {
    const app = publicApp(createPrismaMock());

    const res = await request(app).post("/api/auth/refresh").send({});

    expect(denyRefreshToken).not.toHaveBeenCalled();
    expect(res.headers["set-cookie"]).toBeUndefined();
    // No rotation claim is taken for a request that carries no token.
    expect(claimRefreshRotation).not.toHaveBeenCalled();
  });

  // The three definitive-ish codes must stay distinct: the dashboard branches on
  // them and a regression that collapsed any pair would be silent.
  it("keeps NO_REFRESH_TOKEN distinct from SESSION_EXPIRED and ROTATION_IN_FLIGHT", async () => {
    const app = publicApp(createPrismaMock());
    const refreshToken = await loginAndGetRefreshToken(app);

    (checkSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: "missing" });
    const expired = await request(app).post("/api/auth/refresh").send({ refreshToken });

    (claimRefreshRotation as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const rotating = await request(app).post("/api/auth/refresh").send({ refreshToken });

    const absent = await request(app).post("/api/auth/refresh").send({});

    expect([expired.body.code, rotating.body.code, absent.body.code]).toEqual([
      "SESSION_EXPIRED",
      "ROTATION_IN_FLIGHT",
      "NO_REFRESH_TOKEN",
    ]);
  });
});
