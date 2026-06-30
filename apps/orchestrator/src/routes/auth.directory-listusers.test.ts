/**
 * Directory listing (GET /auth/users) — actor-resolution shape (WARP-947).
 *
 * The Projects (native PM) activity feed records `actorId` as the local
 * `User.id` UUID (WARP-485 invariant). The dashboard resolves an actor id to a
 * display name via this directory endpoint. Before WARP-947 the endpoint
 * returned only the Nextcloud `id` (the OCS username) + `displayName`, so the
 * UUID-keyed lookup never matched and the UI fell back to a cryptic
 * "User <first4>" stub. This suite pins the contract that each directory entry
 * also carries the local `userId` UUID (joined by `nextcloudUsername` /
 * `username`) so the UUID-keyed resolution can succeed — while keeping `id` as
 * the Nextcloud username the admin People page still depends on.
 *
 * Harness mirrors auth.directory-adduser.test.ts (protected router behind a
 * synthetic req.user, mocked Nextcloud client + session resolver).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    DROPLET_SHARED_FOLDER_NAME: "Household",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/nextcloud.client.js", () => ({
  ncListUsers: vi.fn(),
  ncCheckSetupRequired: vi.fn(),
  ncInstallAndCreateAdmin: vi.fn(),
  ncLoginWithCredentials: vi.fn(),
  ncDeleteAppPassword: vi.fn(),
  ncGetCurrentUser: vi.fn(),
  ncCreateUser: vi.fn(),
  ncDeleteUser: vi.fn(),
  ncUpdateUser: vi.fn(),
  ncSetUserEnabled: vi.fn(),
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
  };
});

vi.mock("../services/password.service.js", () => ({
  hashPassword: vi.fn(),
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

interface SeedUser {
  id: string;
  username: string;
  displayName: string;
  nextcloudUsername: string | null;
}

/** Prisma stub exposing only `user.findMany` keyed for the directory join. */
function createPrismaMock(seed: SeedUser[]) {
  const self: any = {};
  self.user = {
    findMany: vi.fn(async () =>
      seed.map((u) => ({
        id: u.id,
        username: u.username,
        nextcloudUsername: u.nextcloudUsername,
      })),
    ),
  };
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/users — directory carries the local userId UUID (WARP-947)", () => {
  it("attaches the local User.id UUID joined by nextcloudUsername, keeping id as the NC username", async () => {
    (nc.ncListUsers as any).mockResolvedValue([
      { id: "sarubinchik", displayName: "Sam Rubinchik", email: "sam@warp.test" },
    ]);
    const prisma = createPrismaMock([
      {
        id: "2f95a1c0-0000-4000-8000-000000000001",
        username: "sarubinchik",
        displayName: "Sam Rubinchik",
        nextcloudUsername: "sarubinchik",
      },
    ]);

    const res = await request(buildApp(prisma)).get("/api/auth/users");

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    const [u] = res.body.users;
    // `id` stays the Nextcloud username — the admin People page keys on it.
    expect(u.id).toBe("sarubinchik");
    // `userId` is the local User.id UUID — matches PM activity/comment actorId.
    expect(u.userId).toBe("2f95a1c0-0000-4000-8000-000000000001");
    expect(u.displayName).toBe("Sam Rubinchik");
  });

  it("falls back to matching on username when nextcloudUsername is null", async () => {
    (nc.ncListUsers as any).mockResolvedValue([
      { id: "alice", displayName: "Alice", email: null },
    ]);
    const prisma = createPrismaMock([
      {
        id: "uuid-alice",
        username: "alice",
        displayName: "Alice",
        nextcloudUsername: null,
      },
    ]);

    const res = await request(buildApp(prisma)).get("/api/auth/users");

    expect(res.status).toBe(200);
    expect(res.body.users[0].userId).toBe("uuid-alice");
  });

  it("returns userId: null for a directory user with no local row (fail-soft)", async () => {
    (nc.ncListUsers as any).mockResolvedValue([
      { id: "ghost", displayName: "Ghost", email: null },
    ]);
    const prisma = createPrismaMock([]);

    const res = await request(buildApp(prisma)).get("/api/auth/users");

    expect(res.status).toBe(200);
    expect(res.body.users[0].id).toBe("ghost");
    expect(res.body.users[0].userId).toBeNull();
  });
});
