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
import { denyRefreshToken } from "../services/jwt.service.js";
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
