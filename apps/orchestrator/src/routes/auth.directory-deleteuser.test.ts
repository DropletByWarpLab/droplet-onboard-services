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
 * WARP-1565 finished the removal this route only half-did. The guarded
 * transaction still owns the REVOCATION (directoryStatus=DEACTIVATED, made
 * atomically with rails 4 + 5); the local User row is then deleted at the
 * end of the request, after Nextcloud confirms the account is gone — so a
 * failing NC delete leaves a fully-revoked row to retry from rather than an
 * orphaned account with working WebDAV. Harness mirrors
 * auth.directory-edituser.test.ts.
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
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";

/** Prisma stub: findUnique by nextcloudUsername + count + tx passthrough. */
function createPrismaMock(seed: any[] = []) {
  const users: any[] = [...seed];
  // Every seeded user is given a Microsoft 365 link, so the delete tests can
  // assert the credential actually goes with them (WARP-2115).
  const m365Rows: any[] = seed.map((u: any) => ({ userId: u.id }));
  const self: any = {};
  // WARP-1570: shared seam — records the options argument (auth.ts opens
  // the removal rails with SERIALIZABLE_TX) and rolls `users` back when the
  // guard refuses inside the callback.
  const seam = createTransactionSeam({ client: () => self, stores: { users } });
  self.$transaction = seam.$transaction;
  self._seam = () => seam;
  self.user = {
    // WARP-1526 (pr-reviewer #1229 B2): the routes resolve by
    // nextcloudUsername, then the guard RE-READS by id inside the
    // transaction — the stub must answer both keys.
    findUnique: vi.fn(async ({ where }: any) => {
      return (
        users.find(
          (u) =>
            (where.nextcloudUsername !== undefined &&
              u.nextcloudUsername === where.nextcloudUsername) ||
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
  // WARP-2115 — the delete path also purges the removed person's Microsoft 365
  // connection. Without this delegate the route's try/catch would swallow a
  // TypeError and the cascade would look like it worked while doing nothing.
  self.m365Connection = {
    deleteMany: vi.fn(async ({ where }: any = {}) => {
      const before = m365Rows.length;
      for (let i = m365Rows.length - 1; i >= 0; i -= 1) {
        if (where?.userId === undefined || m365Rows[i].userId === where.userId) {
          m365Rows.splice(i, 1);
        }
      }
      return { count: before - m365Rows.length };
    }),
  };
  self._m365Rows = m365Rows;
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
    // WARP-2115 — the removed person's Microsoft 365 refresh token must go
    // with them. Nothing cascades (userId is not an FK) and the /api/m365
    // routes scope to the requester's OWN connection, so a row left behind
    // holds a live mailbox credential nobody can ever disconnect.
    expect(prisma.m365Connection.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u-alice" },
    });
    expect(prisma._m365Rows.some((r: any) => r.userId === "u-alice")).toBe(false);
    // Rail 6 — previously this surface revoked NOTHING and audited NOTHING.
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u-alice");
    expect(denylistUserMock).toHaveBeenCalledWith("u-alice", expect.any(Number));
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auth",
        severity: "warn",
        sourceIcon: "user-x",
        // WARP-1565: the local row is now deleted too, so the plain
        // shipped headline is true again — the qualified wording existed
        // only while the removal was half-done (pr-reviewer #1229 B3).
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

/**
 * WARP-1526 — pr-reviewer #1229 B3.
 *
 * The transaction here used to wrap a COUNT with no write: a read-only
 * transaction pins nothing, so it read as protection without being any.
 * Worse, the route never touched the local row, so an NC-deleted admin
 * stayed `role="admin" / directoryStatus=ACTIVE` and kept counting as a
 * live operator for the NEXT removal's rail 5 — sequentially deleting
 * every admin never tripped the invariant — while `/auth/login` verifies
 * the LOCAL passwordHash, so the "removed" admin could sign back in once
 * the ACCESS_TOKEN_TTL denylist entry expired.
 *
 * The fix keeps full local-row deletion out of scope (WARP-1565) but makes
 * check + change atomic: the transaction now writes
 * `directoryStatus="DEACTIVATED"`, which is the same lever the disable
 * path uses and which /auth/login, SSO, WebAuthn and the auth middleware
 * all already fail closed on.
 */
describe("DELETE /api/auth/users/:username — WARP-1526 B3 atomic local write", () => {
  it("deactivates the local row INSIDE the guarded transaction (login fails closed; the row stops counting as an operator)", async () => {
    const prisma = createPrismaMock([
      seededAlice(),
      { id: "own", username: "o", nextcloudUsername: "o", role: "owner", directoryStatus: "ACTIVE" },
    ]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).delete("/api/auth/users/alice");

    expect(res.status).toBe(200);
    // WARP-1565 deletes the row at the END of the request, so the final
    // state can no longer witness this. The property being pinned is
    // unchanged and still load-bearing: the REVOCATION is a write, made
    // inside the SERIALIZABLE transaction the rails ran in, pinned to the
    // role they were evaluated against. (That the row then goes away is the
    // sibling test; that it SURVIVES revoked when Nextcloud fails is the
    // one after it.)
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u-alice", role: "family" },
      data: { directoryStatus: "DEACTIVATED" },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  /**
   * WARP-1565 residual 1 — the half-delete finished.
   *
   * WARP-1526 bounded the exposure (the row is DEACTIVATED inside the
   * guarded transaction, and every login gate fails closed on that), but the
   * row itself survived a route called DELETE whose Nextcloud account is
   * genuinely gone. Two things follow from an orphan row, and the second is
   * the one an operator actually hits:
   *
   *   • the roster carries a person with no account behind them, and
   *   • `username` / `email` / `nextcloudUsername` are UNIQUE columns, so
   *     the freed identity is not free. Re-inviting the same person — the
   *     obvious next action after removing them by mistake, or after an
   *     employee returns — collides on the orphan.
   *
   * Deleting the row LAST, after the Nextcloud account is confirmed gone, is
   * what makes the two directories agree in the failure case too: an NC
   * delete that throws leaves a fully-revoked local row to retry from,
   * which is strictly today's behaviour rather than a new hole.
   */
  it("deletes the local row once the Nextcloud account is gone (the identity is reusable)", async () => {
    const prisma = createPrismaMock([
      seededAlice(),
      { id: "own", username: "o", nextcloudUsername: "o", role: "owner", directoryStatus: "ACTIVE" },
    ]);
    const app = buildApp(prisma, "owner");

    expect((await request(app).delete("/api/auth/users/alice")).status).toBe(200);

    expect(prisma._users.find((u: any) => u.id === "u-alice")).toBeUndefined();
    // Ordering is the contract: NC first, local row after. A row deleted
    // before a failing ncDeleteUser would strand an NC account with working
    // WebDAV and nothing left locally to reconcile it from.
    expect(nc.ncDeleteUser).toHaveBeenCalled();
  });

  it("keeps the revoked local row when the Nextcloud delete fails (nothing to retry from otherwise)", async () => {
    (nc.ncDeleteUser as any).mockRejectedValueOnce(new Error("nc down"));
    const prisma = createPrismaMock([
      seededAlice(),
      { id: "own", username: "o", nextcloudUsername: "o", role: "owner", directoryStatus: "ACTIVE" },
    ]);
    const app = buildApp(prisma, "owner");

    expect((await request(app).delete("/api/auth/users/alice")).status).toBe(500);

    const row = prisma._users.find((u: any) => u.id === "u-alice");
    expect(row).toBeDefined();
    // Access is still revoked — the guarded write committed before the
    // Nextcloud call, and that half must not be undone by its failure.
    expect(row.directoryStatus).toBe("DEACTIVATED");
  });

  it("sequential admin removals DO trip the last-operator rail (the deactivated row no longer counts)", async () => {
    // The pre-fix bug: both admins stayed ACTIVE in the directory, so each
    // removal counted the other as a surviving operator and the box could
    // be emptied of operators one DELETE at a time.
    const prisma = createPrismaMock([
      { id: "u-sam", username: "sam", nextcloudUsername: "sam", role: "admin", directoryStatus: "ACTIVE" },
      { id: "u-kim", username: "kim", nextcloudUsername: "kim", role: "admin", directoryStatus: "ACTIVE" },
    ]);
    const app = buildApp(prisma, "admin");

    const first = await request(app).delete("/api/auth/users/sam");
    expect(first.status).toBe(200);

    const second = await request(app).delete("/api/auth/users/kim");
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("LAST_OPERATOR_INVARIANT");
    expect(prisma._users.find((u: any) => u.id === "u-kim").directoryStatus).toBe(
      "ACTIVE",
    );
  });

  // WARP-1565: this used to assert the OPPOSITE headline, and correctly so —
  // while the local row survived, "User removed" was a false statement in an
  // append-only, signature-chained audit log. Now that the row is deleted,
  // the qualified wording would be the false one, and both removal surfaces
  // describe the same event in the same words.
  it("audits 'User removed' — the statement the completed removal makes true", async () => {
    const prisma = createPrismaMock([
      seededAlice(),
      { id: "own", username: "o", nextcloudUsername: "o", role: "owner", directoryStatus: "ACTIVE" },
    ]);
    const app = buildApp(prisma, "owner");

    await request(app).delete("/api/auth/users/alice");

    const row = vi.mocked(recordActivity).mock.calls[0][0] as any;
    expect(row.kind).toBe("auth");
    expect(row.severity).toBe("warn");
    expect(row.what).toBe("User removed");
    // The audit row outlives the row it describes — `targetUserId` is a ref
    // VALUE, not a foreign key, so the trail survives the delete.
    expect(row.refs).toEqual(
      expect.objectContaining({ targetUserId: "u-alice", targetUsername: "alice" }),
    );
  });

  it("a serialization loser (P2034) is a 409 CONCURRENT_MUTATION and never deletes the Nextcloud account", async () => {
    const prisma = createPrismaMock([
      seededAlice(),
      { id: "own", username: "o", nextcloudUsername: "o", role: "owner", directoryStatus: "ACTIVE" },
    ]);
    const app = buildApp(prisma, "owner");
    const conflict: any = new Error("could not serialize access");
    conflict.code = "P2034";
    prisma.user.update.mockRejectedValueOnce(conflict);

    const res = await request(app).delete("/api/auth/users/alice");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONCURRENT_MUTATION");
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
    expect(vi.mocked(recordActivity)).not.toHaveBeenCalled();
  });
});
