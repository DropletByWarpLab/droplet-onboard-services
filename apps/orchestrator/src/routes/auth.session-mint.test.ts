/**
 * WARP-247 — session-record minting at login + record deletion at logout.
 *
 * Harness mirrors auth.jwt-uuid.test.ts (real route handlers via supertest,
 * real JWT signers, NC client + nc-session + password.service mocked) with
 * session.service mocked so we can assert the wiring and inspect the sid
 * that rides inside the minted tokens.
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

import { createPublicAuthRouter, createProtectedAuthRouter } from "./auth.js";

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

describe("POST /api/auth/login — WARP-247 session mint", () => {
  it("creates a session record BEFORE signing and stamps its sid into both tokens", async () => {
    const app = publicApp(createPrismaMock());

    const res = await request(app)
      .post("/api/auth/login?return=body=1")
      .send({ email: "alice@warp.test", password: "hunter22hunter22" });

    expect(res.status).toBe(200);
    expect(createSession).toHaveBeenCalledWith({ id: "u-uuid-alice-1", role: "family" });

    const access = jwt.decode(res.body.accessToken) as { sid?: string };
    const refresh = jwt.decode(res.body.refreshToken) as { sid?: string };
    expect(access.sid).toBe("sid-mint-0001");
    expect(refresh.sid).toBe("sid-mint-0001");
  });
});

describe("POST /api/auth/logout — WARP-247 record deletion", () => {
  it("deletes the session record for the sid on req.user", async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use((req, _res, next) => {
      (req as never as { user: unknown }).user = {
        id: "u-uuid-alice-1",
        username: "alice",
        displayName: "Alice",
        role: "family",
        sid: "sid-mint-0001",
      };
      next();
    });
    app.use("/api", createProtectedAuthRouter(createPrismaMock() as never));

    const res = await request(app).post("/api/auth/logout");

    expect(res.status).toBe(200);
    expect(deleteSession).toHaveBeenCalledWith("u-uuid-alice-1", "sid-mint-0001");
  });
});
