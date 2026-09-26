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
    agentMaxIter: { defaultIter: 5, capIter: 10 },
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
import * as sessionSvc from "../services/nextcloud-session.service.js";
import { adminBasicToken } from "../services/department-provisioner.service.js";

interface SeedUser {
  id: string;
  username: string;
  displayName: string;
  nextcloudUsername: string | null;
  /** WARP-1527 (RBAC v2 T3): the roster now carries the enforcement tier +
   *  assigned custom-role id per row (T8's RosterUser extension). */
  role?: string;
  accessRoleId?: string | null;
  /** WARP-2984 — directory-only rows need these to render. */
  email?: string | null;
  directoryStatus?: string;
  provisionSource?: string;
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
        displayName: u.displayName,
        email: u.email ?? null,
        role: u.role ?? "family",
        accessRoleId: u.accessRoleId ?? null,
        directoryStatus: u.directoryStatus ?? "ACTIVE",
        provisionSource: u.provisionSource ?? "LOCAL",
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
    // WARP-1527: no local row → no fabricated tier/role chip (T8 renders
    // nothing rather than guessing).
    expect(res.body.users[0].role).toBeNull();
    expect(res.body.users[0].accessRoleId).toBeNull();
  });

  // WARP-1527 (RBAC v2 T3) — the roster extension the Roles & access tab
  // consumes: each row with a local User carries `role` (enforcement tier)
  // and `accessRoleId` (null = plain built-in tier), via an EXPLICIT prisma
  // select — never raw rows (the passwordHash sweep is WARP-1539; this
  // endpoint must not widen what it serializes).
  it("carries role + accessRoleId from the local row (WARP-1527 roster extension)", async () => {
    (nc.ncListUsers as any).mockResolvedValue([
      { id: "ana", displayName: "Ana", email: null },
    ]);
    const prisma = createPrismaMock([
      {
        id: "uuid-ana",
        username: "ana",
        displayName: "Ana",
        nextcloudUsername: "ana",
        role: "family",
        accessRoleId: "role-reception",
      },
    ]);

    const res = await request(buildApp(prisma)).get("/api/auth/users");

    expect(res.status).toBe(200);
    const [u] = res.body.users;
    expect(u.userId).toBe("uuid-ana");
    expect(u.role).toBe("family");
    expect(u.accessRoleId).toBe("role-reception");
    // the select stays explicit — nothing secret rides along
    const selectArg = prisma.user.findMany.mock.calls[0]?.[0]?.select;
    // WARP-2984 widened it by what a directory-only row needs to render —
    // still no passwordHash, no TOTP, nothing secret.
    expect(selectArg).toEqual({
      id: true,
      username: true,
      displayName: true,
      email: true,
      nextcloudUsername: true,
      role: true,
      accessRoleId: true,
      directoryStatus: true,
      provisionSource: true,
      deletionStatus: true,
      deletionDueAt: true,
    });
  });

  it("carries the directory `enabled` flag through to the roster", async () => {
    // The roster could not tell an active person from a deactivated one, so
    // the row only ever offered Disable and an admin had no way back. The
    // flag comes from Nextcloud's /cloud/users/details and reaches the
    // dashboard through the spread — this pins that it is not dropped again.
    (nc.ncListUsers as any).mockResolvedValue([
      { id: "ana", displayName: "Ana", email: null, enabled: true },
      { id: "tomas", displayName: "Tomas", email: null, enabled: false },
    ]);
    const prisma = createPrismaMock([]);

    const res = await request(buildApp(prisma)).get("/api/auth/users");

    expect(res.status).toBe(200);
    expect(
      res.body.users.map((u: { id: string; enabled?: boolean }) => [
        u.id,
        u.enabled,
      ]),
    ).toEqual([
      ["ana", true],
      ["tomas", false],
    ]);
  });
});

/**
 * WARP-2984 (Romain, 2026-09-22) — the roster shows EVERYONE: Nextcloud users
 * and local directory rows merged, no duplicates, each tagged with its source.
 */
describe("GET /api/auth/users — every account, tagged by source (WARP-2984)", () => {
  it("appends SSO/SCIM rows Nextcloud does not list, with no duplicates", async () => {
    (nc.ncListUsers as any).mockResolvedValue([
      { id: "alice", displayName: "Alice", email: "alice@acme.test", enabled: true },
      { id: "legacy", displayName: "Legacy", email: null, enabled: true },
    ]);
    const prisma = createPrismaMock([
      { id: "u-alice", username: "alice", displayName: "Alice", nextcloudUsername: "alice" },
      {
        id: "u-dana", username: "dana.chen", displayName: "Dana Chen", nextcloudUsername: null,
        email: "dana@acme.test", provisionSource: "SSO",
      },
      {
        id: "u-kim", username: "kim", displayName: "Kim", nextcloudUsername: null,
        provisionSource: "SCIM", directoryStatus: "DEACTIVATED",
      },
    ]);

    const res = await request(buildApp(prisma)).get("/api/auth/users");

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.users.map((u: any) => [u.id, u]));
    // Exactly one row per account — alice is NOT repeated by the local pass.
    expect(res.body.users.map((u: any) => u.id).sort()).toEqual(["alice", "dana.chen", "kim", "legacy"]);
    expect(byId.alice).toMatchObject({ userId: "u-alice", source: "local", hasStorage: true });
    expect(byId.legacy).toMatchObject({ userId: null, source: "nextcloud", hasStorage: true });
    expect(byId["dana.chen"]).toMatchObject({
      userId: "u-dana", source: "sso", hasStorage: false, enabled: true,
      displayName: "Dana Chen", email: "dana@acme.test", role: "family",
    });
    // Directory-only row: `enabled` is the directory status, the only state it has.
    expect(byId.kim).toMatchObject({ userId: "u-kim", source: "scim", hasStorage: false, enabled: false });
  });

  it("a local row matched by username (null mapping key) is not appended a second time", async () => {
    (nc.ncListUsers as any).mockResolvedValue([{ id: "bob", displayName: "Bob", email: null }]);
    const prisma = createPrismaMock([
      { id: "u-bob", username: "bob", displayName: "Bob", nextcloudUsername: null },
    ]);

    const res = await request(buildApp(prisma)).get("/api/auth/users");

    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toMatchObject({ id: "bob", userId: "u-bob", hasStorage: true });
  });

  it("a local row whose Nextcloud user is gone is listed under its mapping key, without storage", async () => {
    (nc.ncListUsers as any).mockResolvedValue([]);
    const prisma = createPrismaMock([
      { id: "u-eve", username: "eve", displayName: "Eve", nextcloudUsername: "eve-nc" },
    ]);

    const res = await request(buildApp(prisma)).get("/api/auth/users");

    // The mapping key is what the write routes' resolver tries first.
    expect(res.body.users).toEqual([
      expect.objectContaining({ id: "eve-nc", userId: "u-eve", source: "local", hasStorage: false }),
    ]);
  });

  it("service principals stay off the roster (machine accounts, not people)", async () => {
    (nc.ncListUsers as any).mockResolvedValue([]);
    const prisma = createPrismaMock([
      { id: "u-svc", username: "svc-agent", displayName: "Agent", nextcloudUsername: null, role: "service" },
    ]);

    const res = await request(buildApp(prisma)).get("/api/auth/users");

    expect(res.body.users).toEqual([]);
  });
});

describe("GET /api/auth/users — runs as the box service account (WARP-2993)", () => {
  it("works for an owner/admin with NO Nextcloud credential of their own (no longer NC instance admins)", async () => {
    // A de-admined human's own NC token could not list users anyway; the
    // route must not depend on it at all.
    (sessionSvc.resolveNcToken as any).mockResolvedValueOnce(null);
    (nc.ncListUsers as any).mockResolvedValue([{ id: "bob", displayName: "Bob", email: null }]);

    for (const role of ["owner", "admin"] as Role[]) {
      const res = await request(buildApp(createPrismaMock([]), role)).get("/api/auth/users");
      expect(res.status).toBe(200);
    }
    for (const call of (nc.ncListUsers as any).mock.calls) {
      expect(call[0]).toBe(adminBasicToken());
    }
    expect(sessionSvc.resolveNcToken).not.toHaveBeenCalled();
  });
});
