/**
 * Admin add-user (POST /auth/users) — email-based user creation with derived
 * userid and password policy enforcement (WARP-635).
 *
 * After this task the admin creates household/family users by email; the
 * userid is derived server-side (no username field in the request body) and
 * the password must satisfy passwordZod.
 *
 * Harness mirrors auth.invites.test.ts (protected router, synthetic req.user)
 * combined with the findFirst mock from auth.directory-setup.test.ts
 * (needed by deriveUniqueUserId).
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
    ncUpdateUser: vi.fn(),
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
 * Prisma stub for the add-user handler. Includes:
 *   - user.findFirst  — used by deriveUniqueUserId collision check
 *   - user.upsert     — idempotent local-row write
 */
function createPrismaMock(seed: any[] = []) {
  const users: any[] = [...seed];
  const self: any = {};
  self.user = {
    findFirst: vi.fn(async ({ where }: any) => {
      const candidate = where?.OR?.[0]?.username;
      if (!candidate) return null;
      return (
        users.find(
          (u) => u.username === candidate || u.nextcloudUsername === candidate,
        ) ?? null
      );
    }),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const idx = users.findIndex(
        (u) =>
          (where.nextcloudUsername !== undefined &&
            u.nextcloudUsername === where.nextcloudUsername) ||
          (where.email !== undefined && u.email === where.email),
      );
      if (idx >= 0) {
        users[idx] = { ...users[idx], ...update };
        return users[idx];
      }
      const row = { id: `u-${users.length + 1}`, ...create };
      users.push(row);
      return row;
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

beforeEach(() => {
  vi.clearAllMocks();
  // Reset ncCreateUser to the default success implementation so a
  // mockRejectedValue set in one test doesn't bleed into the next.
  (nc.ncCreateUser as any).mockResolvedValue(undefined);
  // Reset hashPassword to the default fixed argon2id PHC string so a
  // per-test override doesn't bleed into subsequent tests.
  hashPassword.mockImplementation(async (_pw: string) => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g");
});

describe("POST /api/auth/users — email-based user creation with derived userid", () => {
  it("rejects a weak password with WEAK_PASSWORD", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .post("/api/auth/users")
      .send({ email: "kid@warp.test", password: "weak" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WEAK_PASSWORD");
  });

  it("creates a user from email and derives the userid", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .post("/api/auth/users")
      .send({ email: "kid@warp.test", password: "Kid-secret123" });

    expect(res.status).toBe(201);
    // userid derived from email local-part: "kid"
    expect(nc.ncCreateUser).toHaveBeenCalledWith(
      expect.anything(),
      "kid",
      "Kid-secret123",
      undefined,
    );
  });

  it("returns the derived username in the response body", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .post("/api/auth/users")
      .send({ email: "alice@warp.test", password: "Alice-secret123" });

    expect(res.status).toBe(201);
    expect(res.body.username).toBe("alice");
  });

  it("derives a collision-free username when the base is already taken", async () => {
    const prisma = createPrismaMock([
      { id: "u1", username: "kid", nextcloudUsername: "kid", email: "other@warp.test", role: "family" },
    ]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .post("/api/auth/users")
      .send({ email: "kid@warp.test", password: "Kid-secret123" });

    expect(res.status).toBe(201);
    // "kid" is taken, so the derived id should be "kid-2"
    expect(res.body.username).toBe("kid-2");
  });

  it("rejects an invalid email with INVALID_EMAIL", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .post("/api/auth/users")
      .send({ email: "not-an-email", password: "Kid-secret123" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_EMAIL");
  });

  it("writes the local prisma row before calling ncCreateUser", async () => {
    const callOrder: string[] = [];
    const prisma = createPrismaMock();
    const origUpsert = prisma.user.upsert;
    prisma.user.upsert = vi.fn(async (...args: any[]) => {
      callOrder.push("user.upsert");
      return origUpsert(...args);
    });
    (nc.ncCreateUser as any).mockImplementation(async () => {
      callOrder.push("ncCreateUser");
    });
    const app = buildApp(prisma, "owner");

    await request(app)
      .post("/api/auth/users")
      .send({ email: "bob@warp.test", password: "Bob-secret123" });

    expect(callOrder).toEqual(["user.upsert", "ncCreateUser"]);
  });

  it("returns 409 when the Nextcloud user already exists", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, "owner");
    const { NextcloudUserExistsError } = await import("../services/nextcloud.client.js") as any;
    (nc.ncCreateUser as any).mockRejectedValue(new NextcloudUserExistsError());

    const res = await request(app)
      .post("/api/auth/users")
      .send({ email: "existing@warp.test", password: "Existing-secret123" });

    expect(res.status).toBe(409);
  });

  it("is accessible to an admin caller (not just owner)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .post("/api/auth/users")
      .send({ email: "admin-created@warp.test", password: "Admin-secret123" });

    expect(res.status).toBe(201);
  });

  it("writes the argon2id passwordHash so the user can log in (never the plaintext)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .post("/api/auth/users")
      .send({ email: "kid@warp.test", password: "Kid-secret123" });

    expect(res.status).toBe(201);
    const row = prisma._users.find((u: any) => u.email === "kid@warp.test");
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(row)).not.toContain("Kid-secret123");
  });
});
