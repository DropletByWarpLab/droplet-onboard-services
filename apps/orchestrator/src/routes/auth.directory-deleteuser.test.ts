/**
 * WARP-1526 — DELETE /api/auth/users/:username through the role-mutation
 * guard.
 *
 * This route predates the people-surface invariants and had NONE of them:
 * no self-action rail, no owner protection, no operator-count check, no
 * session revocation, and no audit row (WARP-490/WARP-1062 landed on the
 * siblings only). It now runs rails 1/2/4/5 via the shared guard service
 * and the rail-6 removal post-effects (revoke + denylist + "User removed").
 *
 * Deliberately NOT changed here (out of WARP-1526 scope, flagged in the
 * ticket report): this route still does not delete the LOCAL User row —
 * it deletes the Nextcloud account and purges brain memory, exactly as
 * before. Harness mirrors auth.directory-edituser.test.ts.
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

/** Prisma stub: findUnique by nextcloudUsername + count + tx passthrough. */
function createPrismaMock(seed: any[] = []) {
  const users: any[] = [...seed];
  const self: any = {};
  self.$transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => fn(self));
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
    directoryStatus: "ACTIVE",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  revokeAllSessionsMock.mockResolvedValue(2);
  (nc.ncDeleteUser as any).mockResolvedValue(undefined);
  purgeUserDataMock.mockResolvedValue({ items: 0, chunks: 0 });
});

describe("DELETE /api/auth/users/:username — rail 6 post-effects (WARP-490 parity)", () => {
  it("deletes on Nextcloud, purges brain memory, hard-revokes credentials, and emits 'User removed'", async () => {
    const prisma = createPrismaMock([seededAlice(), { id: "own", username: "o", nextcloudUsername: "o", role: "owner", directoryStatus: "ACTIVE" }]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).delete("/api/auth/users/alice");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "deleted", username: "alice" });
    expect(nc.ncDeleteUser).toHaveBeenCalledWith("test-nc-token", "alice");
    expect(purgeUserDataMock).toHaveBeenCalledWith(prisma, "alice");
    // Rail 6 — previously this surface revoked NOTHING and audited NOTHING.
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u-alice");
    expect(denylistUserMock).toHaveBeenCalledWith("u-alice", expect.any(Number));
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auth",
        severity: "warn",
        sourceIcon: "user-x",
        what: "User removed",
        sub: "alice",
        refs: expect.objectContaining({
          targetUserId: "u-alice",
          targetUsername: "alice",
          role: "family",
        }),
      }),
    );
  });

  it("legacy NC-only delete (no local row): NC delete + purge still run; audit row lands with targetUserId null; nothing revoked", async () => {
    const prisma = createPrismaMock([]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).delete("/api/auth/users/legacy");

    expect(res.status).toBe(200);
    expect(nc.ncDeleteUser).toHaveBeenCalledWith("test-nc-token", "legacy");
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
    expect(denylistUserMock).not.toHaveBeenCalled();
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "User removed",
        sub: "legacy",
        refs: expect.objectContaining({ targetUserId: null }),
      }),
    );
  });
});

describe("DELETE /api/auth/users/:username — WARP-1526 rails", () => {
  it("deleting the OWNER → 403 OWNER_IMMUTABLE; Nextcloud account untouched", async () => {
    const prisma = createPrismaMock([
      {
        id: "u-boss",
        username: "boss",
        nextcloudUsername: "boss",
        displayName: "Boss",
        role: "owner",
        directoryStatus: "ACTIVE",
      },
    ]);
    const app = buildApp(prisma, "admin");

    const res = await request(app).delete("/api/auth/users/boss");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
    expect(res.body.error).toBe(
      "The owner has full control and can't be changed here.",
    );
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
    expect(purgeUserDataMock).not.toHaveBeenCalled();
    expect(vi.mocked(recordActivity)).not.toHaveBeenCalled();
  });

  it("deleting YOURSELF → 409 SELF_ACTION_NOT_ALLOWED; Nextcloud untouched", async () => {
    const prisma = createPrismaMock([
      {
        id: "owner-id", // buildApp's synthetic req.user.id for callerRole=owner
        username: "user-owner",
        nextcloudUsername: "selfowner",
        displayName: "Self Owner",
        role: "admin", // non-owner row so the refusal is provably the self rail
        directoryStatus: "ACTIVE",
      },
      {
        id: "u-other",
        username: "other",
        nextcloudUsername: "other",
        role: "admin",
        directoryStatus: "ACTIVE",
      },
    ]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).delete("/api/auth/users/selfowner");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SELF_ACTION_NOT_ALLOWED");
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
  });

  it("deleting the last ACTIVE operator → 409 LAST_OPERATOR_INVARIANT; Nextcloud untouched", async () => {
    const prisma = createPrismaMock([
      {
        id: "u-sam",
        username: "sam",
        nextcloudUsername: "sam",
        displayName: "Sam",
        role: "admin",
        directoryStatus: "ACTIVE",
      },
    ]);
    const app = buildApp(prisma, "admin"); // synthetic admin session, no local row

    const res = await request(app).delete("/api/auth/users/sam");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LAST_OPERATOR_INVARIANT");
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
    expect(vi.mocked(recordActivity)).not.toHaveBeenCalled();
  });

  it("deleting an admin while another ACTIVE operator remains → 200 (the rail counts, it doesn't blanket-block admins)", async () => {
    const prisma = createPrismaMock([
      {
        id: "u-sam",
        username: "sam",
        nextcloudUsername: "sam",
        displayName: "Sam",
        role: "admin",
        directoryStatus: "ACTIVE",
      },
      {
        id: "u-kim",
        username: "kim",
        nextcloudUsername: "kim",
        displayName: "Kim",
        role: "admin",
        directoryStatus: "ACTIVE",
      },
    ]);
    const app = buildApp(prisma, "admin");

    const res = await request(app).delete("/api/auth/users/sam");

    expect(res.status).toBe(200);
    expect(nc.ncDeleteUser).toHaveBeenCalledWith("test-nc-token", "sam");
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u-sam");
  });
});

/**
 * pr-reviewer (#1229) — the removal rails' operator count must run at
 * SERIALIZABLE, not the READ COMMITTED default Postgres/Prisma actually
 * give you (the code used to claim serializable WAS the default; it is
 * not). Two concurrent deletions of the last two operators would otherwise
 * both read "one other operator remains" and both proceed.
 *
 * Honest scope note, asserted here so it is not mistaken for closed: this
 * route does NOT delete the local User row (pre-existing, called out in the
 * handler), so the transaction is count-only. A read-only SERIALIZABLE
 * transaction cannot conflict with another read-only one, so the isolation
 * level alone does not fully close this particular race — the residual gap
 * is the missing local write, tracked separately.
 */
describe("DELETE /api/auth/users/:username — serializable isolation", () => {
  it("passes { isolationLevel: 'Serializable' } to the removal-rails $transaction", async () => {
    const prisma = createPrismaMock([
      seededAlice(),
      { id: "own", username: "o", nextcloudUsername: "o", role: "owner", directoryStatus: "ACTIVE" },
    ]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).delete("/api/auth/users/alice");

    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: "Serializable",
    });
  });
});
