/**
 * Admin edit-user (PUT /auth/users/:username) — directory-aware edits.
 *
 * ADR-013: the built-in argon2id directory is the auth source of truth and
 * /auth/login verifies the LOCAL passwordHash by email. So an admin editing a
 * member's email or password MUST land on the local `User` row, not only on
 * Nextcloud — otherwise the edit has no effect on directory login. The edit
 * route also enforces the shared password policy (passwordZod) and still
 * mirrors changes to Nextcloud for the WebDAV account.
 *
 * Harness mirrors auth.directory-adduser.test.ts (protected router, synthetic
 * req.user, mocked password.service so the native argon2 binding is never
 * loaded under vitest).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readUserEmail } from "../services/user-directory.service.js";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/nextcloud.client.js", () => {
  class NextcloudOcsError extends Error {
    public readonly ocsStatus: number;
    constructor(message: string, ocsStatus: number) {
      super(message);
      this.name = "NextcloudOcsError";
      this.ocsStatus = ocsStatus;
    }
  }
  class NextcloudUserExistsError extends NextcloudOcsError {
    constructor(message = "User already exists") {
      super(message, 102);
      this.name = "NextcloudUserExistsError";
    }
  }
  return {
    ncCheckSetupRequired: vi.fn(),
    ncInstallAndCreateAdmin: vi.fn().mockResolvedValue(undefined),
    ncLoginWithCredentials: vi.fn(),
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
    NextcloudOcsError,
    NextcloudUserExistsError,
  };
});

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
  };
});

const hashPassword = vi.fn(async (_pw: string) => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g");
vi.mock("../services/password.service.js", () => ({
  hashPassword: (...args: unknown[]) => hashPassword(...(args as [string])),
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
import type { Role } from "../services/jwt.service.js";

/**
 * Prisma stub for the edit-user handler. `updateMany` mutates seeded rows
 * matched by `nextcloudUsername` (or `username`) and reports the row count —
 * mirroring Prisma's contract so the route's 404-on-zero-rows path is exercised.
 */
function createPrismaMock(seed: any[] = []) {
  const users: any[] = [...seed];
  const self: any = {};
  self.user = {
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (let i = 0; i < users.length; i += 1) {
        const u = users[i];
        const match =
          (where.nextcloudUsername !== undefined && u.nextcloudUsername === where.nextcloudUsername) ||
          (where.username !== undefined && u.username === where.username);
        if (match) {
          users[i] = { ...u, ...data };
          count += 1;
        }
      }
      return { count };
    }),
  };
  self._users = users;
  return self;
}

/** Mount the protected auth router behind a synthetic req.user (owner by default). */
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
    email: "alice@warp.test",
    passwordHash: "$argon2id$OLD-HASH",
    role: "family",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (nc.ncUpdateUser as any).mockResolvedValue(undefined);
  hashPassword.mockImplementation(async (_pw: string) => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g");
});

describe("PUT /api/auth/users/:username — directory-aware edits", () => {
  it("rejects a weak password with WEAK_PASSWORD and writes nothing", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ password: "weak" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WEAK_PASSWORD");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("writes the argon2id passwordHash to the local row (never the plaintext) and mirrors to Nextcloud", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ password: "New-secret123" });

    expect(res.status).toBe(200);
    const row = prisma._users.find((u: any) => u.username === "alice");
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toBe("$argon2id$OLD-HASH"); // actually rotated
    expect(JSON.stringify(row)).not.toContain("New-secret123"); // plaintext never stored
    // Still provisions the WebDAV side with the plaintext.
    expect(nc.ncUpdateUser).toHaveBeenCalledWith("test-nc-token", "alice", "password", "New-secret123");
  });

  it("writes a normalized email to the local row and mirrors it to Nextcloud", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ email: "  NewAlice@Example.COM  " });

    expect(res.status).toBe(200);
    const row = prisma._users.find((u: any) => u.username === "alice");
    // WARP-233: stored as a dcv1 blob — decrypt for the assertion.
    expect(readUserEmail(row.email)).toBe("newalice@example.com");
    expect(nc.ncUpdateUser).toHaveBeenCalledWith("test-nc-token", "alice", "email", "newalice@example.com");
  });

  it("updates displayName on the local row and Nextcloud", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ displayName: "Alice Cooper" });

    expect(res.status).toBe(200);
    const row = prisma._users.find((u: any) => u.username === "alice");
    expect(row.displayName).toBe("Alice Cooper");
    expect(nc.ncUpdateUser).toHaveBeenCalledWith("test-nc-token", "alice", "displayname", "Alice Cooper");
  });

  it("404s when changing the email/password of a user with no local directory row", async () => {
    const prisma = createPrismaMock([]); // no alice row
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/ghost")
      .send({ password: "Ghost-secret123" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("USER_NOT_FOUND");
    // The WebDAV-side write must not happen for a non-existent directory user.
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("fails closed (500 USERS_NO_PRISMA) when the directory isn't wired and a credential change is requested", async () => {
    // Legacy createAuthRouter() shim wires the protected router WITHOUT prisma.
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as any).user = { id: "owner-id", username: "user-owner", displayName: "Owner", role: "owner" as Role };
      next();
    });
    app.use("/api", createProtectedAuthRouter(undefined));

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ password: "New-secret123" });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("USERS_NO_PRISMA");
  });

  it("rejects a non-admin caller with 403", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "family");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ displayName: "Hacker" });

    expect(res.status).toBe(403);
  });
});
