/**
 * WARP-116 — admin "revoke now" surface on the protected auth router.
 *
 * Covers:
 *   - POST /auth/users/:username/revoke-sessions — owner/admin denylists every
 *     live refresh token for the user (resolved username → local User.id),
 *     404 for an unknown user, 403 for a non-admin caller, 500 when the local
 *     directory isn't wired.
 *   - POST /auth/users/:username/disable — also revokes the disabled user's
 *     live sessions so the disable propagates immediately.
 *
 * Harness mirrors auth.directory-edituser.test.ts (protected router, synthetic
 * req.user, mocked NC client + password.service so the native argon2 binding is
 * never loaded under vitest). The jwt.service mock spreads the real module and
 * spies `revokeAllSessions` so we can assert the wiring without Redis.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/nextcloud.client.js", () => ({
  ncCheckSetupRequired: vi.fn(),
  ncInstallAndCreateAdmin: vi.fn().mockResolvedValue(undefined),
  ncLoginWithCredentials: vi.fn(),
  ncDeleteAppPassword: vi.fn().mockResolvedValue(undefined),
  ncGetCurrentUser: vi.fn(),
  ncCreateUser: vi.fn().mockResolvedValue(undefined),
  ncDeleteUser: vi.fn(),
  ncListUsers: vi.fn(),
  ncUpdateUser: vi.fn().mockResolvedValue(undefined),
  ncSetUserEnabled: vi.fn().mockResolvedValue(undefined),
  ncOAuth2AuthorizeUrl: vi.fn(),
  ncOAuth2ExchangeCode: vi.fn(),
  ncOAuth2RefreshToken: vi.fn(),
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: vi.fn().mockResolvedValue(undefined),
  getNcToken: vi.fn().mockResolvedValue(null),
  deleteNcToken: vi.fn().mockResolvedValue(undefined),
  touchNcToken: vi.fn().mockResolvedValue(undefined),
  resolveNcToken: vi.fn().mockResolvedValue("test-nc-token"),
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

// WARP-247 — the admin surfaces now revoke SESSION RECORDS (which also
// sweeps the WARP-116 refresh denylist internally).
const revokeAllSessions = vi.fn(async (_userId: string) => 2);
vi.mock("../services/session.service.js", () => ({
  createSession: vi.fn(async () => ({ sid: "sid-test", evictedSids: [] })),
  checkSession: vi.fn(async () => ({ kind: "ok", record: { userId: "x", role: "family", createdAt: 0, lastSeenAt: 0 } })),
  deleteSession: vi.fn(async () => undefined),
  revokeAllSessions: (...args: unknown[]) => revokeAllSessions(...(args as [string])),
}));

vi.mock("../services/password.service.js", () => ({
  hashPassword: vi.fn(async () => "$argon2id$stub"),
  verifyPassword: vi.fn().mockResolvedValue(true),
  verifyDummyPassword: vi.fn().mockResolvedValue(false),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

import { createProtectedAuthRouter } from "./auth.js";
import * as nc from "../services/nextcloud.client.js";
import { recordActivity } from "../services/activity.singleton.js";
import type { Role } from "../services/jwt.service.js";

/** Prisma stub: findUnique by nextcloudUsername (the username→id resolution). */
function createPrismaMock(seed: any[] = []) {
  const users: any[] = [...seed];
  const self: any = {};
  self.user = {
    findUnique: vi.fn(async ({ where }: any) => {
      return (
        users.find(
          (u) =>
            where.nextcloudUsername !== undefined &&
            u.nextcloudUsername === where.nextcloudUsername,
        ) ?? null
      );
    }),
  };
  self._users = users;
  return self;
}

function buildApp(prismaMock: any, callerRole: Role = "owner") {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = {
      id: `${callerRole}-id`,
      username: `user-${callerRole}`,
      displayName: `User ${callerRole}`,
      role: callerRole,
    };
    next();
  });
  app.use("/api", createProtectedAuthRouter(prismaMock));
  return app;
}

function seededAlice() {
  return {
    id: "u-alice",
    username: "alice",
    nextcloudUsername: "alice",
    displayName: "Alice",
    role: "family",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  revokeAllSessions.mockResolvedValue(2);
  (nc.ncSetUserEnabled as any).mockResolvedValue(undefined);
});

describe("POST /api/auth/users/:username/revoke-sessions", () => {
  it("resolves username → User.id and revokes, returning the count", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/alice/revoke-sessions");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", username: "alice", revoked: 2 });
    expect(revokeAllSessions).toHaveBeenCalledWith("u-alice");
    // WARP-237: admin session revocation emits a mandatory audit row.
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auth",
        severity: "warn",
        what: "Sessions revoked",
        refs: expect.objectContaining({
          targetUserId: "u-alice",
          username: "alice",
        }),
      }),
    );
  });

  it("404s for an unknown user (no local directory row)", async () => {
    const prisma = createPrismaMock([]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/ghost/revoke-sessions");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("USER_NOT_FOUND");
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it("403s a non-admin caller (admin gate mirrors the other user routes)", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "family");

    const res = await request(app).post("/api/auth/users/alice/revoke-sessions");

    expect(res.status).toBe(403);
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it("fails closed (500 USERS_NO_PRISMA) when the directory isn't wired", async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as any).user = {
        id: "owner-id",
        username: "user-owner",
        displayName: "Owner",
        role: "owner" as Role,
      };
      next();
    });
    app.use("/api", createProtectedAuthRouter(undefined));

    const res = await request(app).post("/api/auth/users/alice/revoke-sessions");

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("USERS_NO_PRISMA");
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/users/:username/disable — revokes sessions", () => {
  it("disables on Nextcloud AND revokes the user's live sessions", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/alice/disable");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "disabled", username: "alice" });
    expect(nc.ncSetUserEnabled).toHaveBeenCalledWith("test-nc-token", "alice", false);
    expect(revokeAllSessions).toHaveBeenCalledWith("u-alice");
  });

  it("still disables a legacy NC-only account with no local row (no revoke)", async () => {
    const prisma = createPrismaMock([]); // no local mirror
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/legacy/disable");

    expect(res.status).toBe(200);
    expect(nc.ncSetUserEnabled).toHaveBeenCalledWith("test-nc-token", "legacy", false);
    // No local row → nothing to revoke, but the disable itself must succeed.
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  // WARP-1062 (audit item B): disablement revokes sessions like its
  // revoke-sessions sibling, so it must emit the same mandatory-emit
  // privileged-action row — it was the one unaudited account-lifecycle write.
  it("emits the 'User disabled' audit row (WARP-1062)", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/alice/disable");

    expect(res.status).toBe(200);
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auth",
        severity: "warn",
        what: "User disabled",
        sub: "alice",
        refs: expect.objectContaining({
          username: "alice",
          targetUserId: "u-alice",
          sessionsRevoked: 2,
        }),
        actor: { type: "user", id: "owner-id" },
      }),
    );
  });

  it("audits a legacy NC-only disable too (targetUserId null, 0 sessions)", async () => {
    const prisma = createPrismaMock([]); // no local mirror
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/legacy/disable");

    expect(res.status).toBe(200);
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "User disabled",
        sub: "legacy",
        refs: expect.objectContaining({
          username: "legacy",
          targetUserId: null,
          sessionsRevoked: 0,
        }),
      }),
    );
  });
});
