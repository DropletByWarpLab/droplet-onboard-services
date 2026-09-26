/**
 * WARP-2858 — the `/auth/users/:username` write routes (update, disable,
 * enable, delete) resolve SSO/SCIM-provisioned accounts.
 *
 * `scim.service.ts provisionUser` and the SSO just-in-time create seed
 * `username` from the email and never write `nextcloudUsername` (schema:
 * `String? @unique`, no default). These routes used to resolve the path param
 * against `nextcloudUsername` ONLY, so for that population they fell through
 * to the rowless legacy branch: the Nextcloud call failed against a user
 * Nextcloud never had, and the local row was never deactivated, re-enabled,
 * edited or removed.
 *
 * Every route is exercised against BOTH shapes — a local account (mapping key
 * set, Nextcloud mirrored) and an SSO/SCIM account (no mapping key, Nextcloud
 * skipped with an explicit `ncMirror: "no_account"`). The resolver ordering is
 * mutation-tested: a handle that is one row's mapping key AND another row's
 * login handle must resolve to the mapping-key row.
 *
 * Harness copied from auth.directory-deleteuser.test.ts, plus `updateMany`
 * for the PUT route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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
    ncDeleteUser: vi.fn().mockResolvedValue(undefined),
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
  resolveNcToken: vi.fn().mockResolvedValue("caller-nc-token"),
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
  hashPassword: vi.fn(async () => "$argon2id$stub"),
  verifyPassword: vi.fn().mockResolvedValue(true),
  verifyDummyPassword: vi.fn().mockResolvedValue(false),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

const { purgeUserDataMock } = vi.hoisted(() => ({
  purgeUserDataMock: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));
vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: purgeUserDataMock,
}));

// WARP-1526 rail 6: removal hard-revokes credentials (revoke + denylist).
const { revokeAllSessionsMock, denylistUserMock } = vi.hoisted(() => ({
  revokeAllSessionsMock: vi.fn(async (_userId: string) => 2),
  denylistUserMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/session.service.js", () => ({
  createSession: vi.fn(async () => ({ sid: "sid-test", evictedSids: [] })),
  checkSession: vi.fn(async () => ({
    kind: "ok",
    record: { userId: "x", role: "family", createdAt: 0, lastSeenAt: 0 },
  })),
  deleteSession: vi.fn(async () => undefined),
  revokeAllSessions: (...args: unknown[]) =>
    revokeAllSessionsMock(...(args as [string])),
}));
vi.mock("../services/auth-denylist.service.js", () => ({
  denylistUser: denylistUserMock,
  isUserDenied: vi.fn().mockResolvedValue(false),
}));

import { createProtectedAuthRouter } from "./auth.js";
import * as nc from "../services/nextcloud.client.js";
import { recordActivity } from "../services/activity.singleton.js";
import type { Role } from "../services/jwt.service.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";
// WARP-2993: the /auth/users routes call Nextcloud as the box service
// account, never with the caller's own NC credential ("caller-nc-token").
import { adminBasicToken } from "../services/department-provisioner.service.js";
const SERVICE_NC_TOKEN = adminBasicToken();

/** Prisma stub: findUnique by nextcloudUsername + count + tx passthrough. */
function createPrismaMock(seed: any[] = []) {
  const users: any[] = seed.map((u) => ({ ...u }));
  const self: any = {};
  const seam = createTransactionSeam({ client: () => self, stores: { users } });
  self.$transaction = seam.$transaction;
  self.user = {
    // Each clause gated on its own key: a `{ nextcloudUsername }` probe must
    // NOT match a row whose mapping key is null.
    findUnique: vi.fn(async ({ where }: any) => {
      return (
        users.find(
          (u) =>
            (where.nextcloudUsername !== undefined &&
              u.nextcloudUsername === where.nextcloudUsername) ||
            (where.username !== undefined && u.username === where.username) ||
            (where.id !== undefined && u.id === where.id),
        ) ?? null
      );
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const idx = users.findIndex(
        (u) => u.id === where.id && (where.role === undefined || u.role === where.role),
      );
      if (idx < 0) {
        const err: any = new Error("not found");
        err.code = "P2025";
        throw err;
      }
      users[idx] = { ...users[idx], ...data };
      return users[idx];
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (let i = 0; i < users.length; i += 1) {
        const u = users[i];
        const match =
          ((where.id !== undefined && u.id === where.id) ||
            (where.nextcloudUsername !== undefined &&
              u.nextcloudUsername === where.nextcloudUsername)) &&
          (where.role === undefined || u.role === where.role);
        if (match) {
          users[i] = { ...u, ...data };
          count += 1;
        }
      }
      return { count };
    }),
    deleteMany: vi.fn(async ({ where }: any = {}) => {
      const before = users.length;
      for (let i = users.length - 1; i >= 0; i -= 1) {
        const u = users[i];
        const idOk = where?.id === undefined || u.id === where.id;
        const statusOk =
          where?.directoryStatus === undefined ||
          u.directoryStatus === where.directoryStatus;
        if (idOk && statusOk) users.splice(i, 1);
      }
      return { count: before - users.length };
    }),
    count: vi.fn(async ({ where }: any = {}) => {
      let n = 0;
      for (const u of users) {
        const roleOk =
          where?.role === undefined
            ? true
            : typeof where.role === "string"
              ? u.role === where.role
              : (where.role.in ?? []).includes(u.role);
        const statusOk =
          where?.directoryStatus === undefined ||
          u.directoryStatus === where.directoryStatus;
        const idOk = where?.id?.not === undefined || u.id !== where.id.not;
        if (roleOk && statusOk && idOk) n += 1;
      }
      return n;
    }),
  };
  // WARP-2984: the roster reads the directory too.
  self.user.findMany = vi.fn(async () => users.map((u) => ({ ...u })));
  self.m365Connection = { deleteMany: vi.fn(async () => ({ count: 0 })) };
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

// A second ACTIVE operator so the last-operator rail never decides a test
// that is about resolution.
const OTHER_ADMIN = {
  id: "u-other",
  username: "other",
  nextcloudUsername: "other",
  role: "admin",
  directoryStatus: "ACTIVE",
};

/** Local account: mapping key set, mirrored to Nextcloud under that name. */
const LOCAL = {
  id: "u-alice",
  username: "alice",
  nextcloudUsername: "alice",
  role: "family",
  directoryStatus: "ACTIVE",
  provisionSource: "LOCAL",
};

/** SSO/SCIM account: `username` seeded from the email, no mapping key. */
const SSO = {
  id: "u-dana",
  username: "dana.chen",
  nextcloudUsername: null,
  role: "family",
  directoryStatus: "ACTIVE",
  provisionSource: "SSO",
};

const row = (prisma: any, id: string) => prisma._users.find((u: any) => u.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  revokeAllSessionsMock.mockResolvedValue(2);
  (nc.ncSetUserEnabled as any).mockResolvedValue(undefined);
  (nc.ncDeleteUser as any).mockResolvedValue(undefined);
  (nc.ncUpdateUser as any).mockResolvedValue(undefined);
});

describe("POST /api/auth/users/:username/disable", () => {
  it("local account: DEACTIVATED locally, mirrored to Nextcloud, sessions revoked", async () => {
    const prisma = createPrismaMock([LOCAL, OTHER_ADMIN]);
    const res = await request(buildApp(prisma)).post("/api/auth/users/alice/disable");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "disabled", ncMirror: "synced" });
    expect(row(prisma, "u-alice").directoryStatus).toBe("DEACTIVATED");
    expect(nc.ncSetUserEnabled).toHaveBeenCalledWith(SERVICE_NC_TOKEN, "alice", false);
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u-alice");
  });

  it("SSO/SCIM account: DEACTIVATED locally, sessions revoked, Nextcloud skipped as no_account (was: 500, account left live)", async () => {
    const prisma = createPrismaMock([SSO, OTHER_ADMIN]);
    const res = await request(buildApp(prisma)).post("/api/auth/users/dana.chen/disable");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "disabled", username: "dana.chen", ncMirror: "no_account" });
    // No account to cut off in Nextcloud → nothing to warn about.
    expect(res.body.warning).toBeUndefined();
    expect(row(prisma, "u-dana").directoryStatus).toBe("DEACTIVATED");
    expect(nc.ncSetUserEnabled).not.toHaveBeenCalled();
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u-dana");
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "User disabled",
        refs: expect.objectContaining({ targetUserId: "u-dana", ncMirror: "no_account" }),
      }),
    );
  });

  it("SSO/SCIM owner is still owner-immutable once resolved (403, nothing written)", async () => {
    const prisma = createPrismaMock([{ ...SSO, role: "owner" }, OTHER_ADMIN]);
    const res = await request(buildApp(prisma, "admin")).post("/api/auth/users/dana.chen/disable");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
    expect(row(prisma, "u-dana").directoryStatus).toBe("ACTIVE");
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/users/:username/enable", () => {
  it("local account: ACTIVE locally and mirrored to Nextcloud", async () => {
    const prisma = createPrismaMock([{ ...LOCAL, directoryStatus: "DEACTIVATED" }]);
    const res = await request(buildApp(prisma)).post("/api/auth/users/alice/enable");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "enabled", ncMirror: "synced" });
    expect(row(prisma, "u-alice").directoryStatus).toBe("ACTIVE");
    expect(nc.ncSetUserEnabled).toHaveBeenCalledWith(SERVICE_NC_TOKEN, "alice", true);
  });

  it("SSO/SCIM account: ACTIVE locally, Nextcloud skipped as no_account (was: 500, row left DEACTIVATED)", async () => {
    const prisma = createPrismaMock([{ ...SSO, directoryStatus: "DEACTIVATED" }]);
    const res = await request(buildApp(prisma)).post("/api/auth/users/dana.chen/enable");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "enabled", username: "dana.chen", ncMirror: "no_account" });
    expect(row(prisma, "u-dana").directoryStatus).toBe("ACTIVE");
    expect(nc.ncSetUserEnabled).not.toHaveBeenCalled();
  });
});

describe("PUT /api/auth/users/:username", () => {
  it("local account: password lands on the local row and mirrors to Nextcloud", async () => {
    const prisma = createPrismaMock([LOCAL]);
    const res = await request(buildApp(prisma))
      .put("/api/auth/users/alice")
      .send({ password: "New-secret123" });

    expect(res.status).toBe(200);
    expect(res.body.ncMirror).toBe("synced");
    expect(row(prisma, "u-alice").passwordHash).toBe("$argon2id$stub");
    expect(nc.ncUpdateUser).toHaveBeenCalledWith(SERVICE_NC_TOKEN, "alice", "password", "New-secret123");
  });

  it("SSO/SCIM account: displayName + email land on the local row, Nextcloud skipped (was: 404 USER_NOT_FOUND)", async () => {
    const prisma = createPrismaMock([SSO]);
    const res = await request(buildApp(prisma))
      .put("/api/auth/users/dana.chen")
      .send({ displayName: "Dana C.", email: "Dana@Example.com" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", username: "dana.chen", ncMirror: "no_account" });
    expect(row(prisma, "u-dana").displayName).toBe("Dana C.");
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("SSO/SCIM account: a quota edit is refused explicitly (409 NO_NEXTCLOUD_ACCOUNT) before any write", async () => {
    const prisma = createPrismaMock([SSO]);
    const res = await request(buildApp(prisma))
      .put("/api/auth/users/dana.chen")
      .send({ displayName: "Dana C.", quota: 1024 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NO_NEXTCLOUD_ACCOUNT");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  // WARP-2858 (Romain, 2026-09-22): no local password on an IdP-provisioned
  // account — it would be a login the IdP's disable/deprovision cannot reach.
  it.each(["SSO", "SCIM"])("%s-provisioned account: a password write → 409 SSO_MANAGED_ACCOUNT, nothing written anywhere", async (source) => {
    const prisma = createPrismaMock([{ ...SSO, provisionSource: source }]);
    const res = await request(buildApp(prisma))
      .put("/api/auth/users/dana.chen")
      .send({ displayName: "Dana C.", password: "New-secret123" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SSO_MANAGED_ACCOUNT");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(row(prisma, "u-dana").passwordHash).toBeUndefined();
    expect(row(prisma, "u-dana").displayName).toBeUndefined();
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("a LOCAL row that later linked SSO keeps its password (the tag, not the link, decides)", async () => {
    const prisma = createPrismaMock([{ ...LOCAL }]);
    const res = await request(buildApp(prisma))
      .put("/api/auth/users/alice")
      .send({ password: "New-secret123" });

    expect(res.status).toBe(200);
    expect(row(prisma, "u-alice").passwordHash).toBe("$argon2id$stub");
  });

  it("SSO/SCIM owner: an admin rewriting their password is still refused (rail 1b)", async () => {
    const prisma = createPrismaMock([{ ...SSO, role: "owner" }]);
    const res = await request(buildApp(prisma, "admin"))
      .put("/api/auth/users/dana.chen")
      .send({ password: "Takeover-123x" });

    expect(res.status).toBe(403);
    expect(row(prisma, "u-dana").passwordHash).toBeUndefined();
  });
});

// WARP-3113: Delete schedules (files kept 30 days); the nightly job removes
// the account — covered in auth.directory-deleteuser.test.ts.
const RETAIN = { disposition: "retention" };

describe("DELETE /api/auth/users/:username", () => {
  it("local account: revoked now, Nextcloud login disabled, deletion scheduled, nothing purged", async () => {
    const prisma = createPrismaMock([LOCAL, OTHER_ADMIN]);
    const res = await request(buildApp(prisma)).delete("/api/auth/users/alice").send(RETAIN);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "pending_deletion", ncMirror: "synced" });
    expect(nc.ncSetUserEnabled).toHaveBeenCalledWith(SERVICE_NC_TOKEN, "alice", false);
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
    expect(purgeUserDataMock).not.toHaveBeenCalled();
    expect(row(prisma, "u-alice")).toMatchObject({ directoryStatus: "DEACTIVATED", deletionStatus: "PENDING" });
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({ what: "User deletion scheduled" }),
    );
  });

  it("SSO/SCIM account: scheduled, sessions revoked, Nextcloud skipped (no account)", async () => {
    const prisma = createPrismaMock([SSO, OTHER_ADMIN]);
    const res = await request(buildApp(prisma)).delete("/api/auth/users/dana.chen").send(RETAIN);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "pending_deletion", username: "dana.chen", ncMirror: "no_account" });
    expect(nc.ncSetUserEnabled).not.toHaveBeenCalled();
    expect(row(prisma, "u-dana")).toMatchObject({ deletionStatus: "PENDING" });
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u-dana");
  });

  it("SSO/SCIM owner cannot be deleted (403, row intact)", async () => {
    const prisma = createPrismaMock([{ ...SSO, role: "owner" }, OTHER_ADMIN]);
    const res = await request(buildApp(prisma, "admin")).delete("/api/auth/users/dana.chen").send(RETAIN);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
    expect(row(prisma, "u-dana")).toMatchObject({ directoryStatus: "ACTIVE" });
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
  });
});

/**
 * Mutation test for the resolver ORDER. `sam` is row A's mapping key AND row
 * B's login handle. Mapping key first means A — the row this handle named
 * before WARP-2820/2858. Reversing the two lookups resolves B and fails here.
 */
describe("handle resolution order — nextcloudUsername before username", () => {
  const A = { id: "u-a", username: "a-login", nextcloudUsername: "sam", role: "family", directoryStatus: "ACTIVE" };
  const B = { id: "u-b", username: "sam", nextcloudUsername: null, role: "family", directoryStatus: "ACTIVE" };

  it("disable resolves the mapping-key row, never the login-handle row", async () => {
    const prisma = createPrismaMock([A, B, OTHER_ADMIN]);
    const res = await request(buildApp(prisma)).post("/api/auth/users/sam/disable");

    expect(res.status).toBe(200);
    expect(row(prisma, "u-a").directoryStatus).toBe("DEACTIVATED");
    expect(row(prisma, "u-b").directoryStatus).toBe("ACTIVE");
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u-a");
  });

  it("delete resolves the mapping-key row, never the login-handle row", async () => {
    const prisma = createPrismaMock([A, B, OTHER_ADMIN]);
    const res = await request(buildApp(prisma)).delete("/api/auth/users/sam").send(RETAIN);

    expect(res.status).toBe(200);
    expect(row(prisma, "u-a").deletionStatus).toBe("PENDING");
    expect(row(prisma, "u-b").deletionStatus).toBeUndefined();
  });
});

/**
 * WARP-2984 — every roster row's `id` is a handle the write routes resolve.
 * Round trip: list, take the SSO row's id, disable it, list again.
 */
describe("roster → action round trip (WARP-2984)", () => {
  it("the SSO row the roster lists can be disabled by its roster id", async () => {
    (nc.ncListUsers as any).mockResolvedValue([{ id: "alice", displayName: "Alice", email: null, enabled: true }]);
    const prisma = createPrismaMock([LOCAL, SSO, OTHER_ADMIN]);
    const app = buildApp(prisma);

    const before = await request(app).get("/api/auth/users");
    const dana = before.body.users.find((u: any) => u.userId === "u-dana");
    expect(dana).toMatchObject({ source: "sso", hasStorage: false, enabled: true });

    const res = await request(app).post(`/api/auth/users/${encodeURIComponent(dana.id)}/disable`);
    expect(res.status).toBe(200);

    const after = await request(app).get("/api/auth/users");
    expect(after.body.users.find((u: any) => u.userId === "u-dana").enabled).toBe(false);
  });
});
