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
    agentMaxIter: { defaultIter: 5, capIter: 10 },
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
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";

/**
 * Prisma stub: findUnique by nextcloudUsername (the username→id resolution).
 * WARP-1526: the disable path now runs the guard rails in a $transaction and
 * writes directoryStatus on the LOCAL row (the ADR-013 source of truth), so
 * the stub also carries update / count / $transaction.
 */
function createPrismaMock(seed: any[] = []) {
  const users: any[] = [...seed];
  const self: any = {};
  // WARP-1570: shared seam — the disable path runs its guard rails inside
  // SERIALIZABLE_TX, so the options argument has to survive, and a refusal
  // has to roll the directoryStatus write back.
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
      const idx = users.findIndex((u) => u.id === where.id);
      if (idx < 0) {
        const err: any = new Error("not found");
        err.code = "P2025";
        throw err;
      }
      users[idx] = { ...users[idx], ...data };
      return users[idx];
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

/**
 * WARP-1526 — role-mutation-guard rails on the disable/enable paths.
 *
 * The disable path now runs rails 1/2/5 through the shared guard service
 * and — the load-bearing change — writes `directoryStatus` on the LOCAL
 * row inside the guard transaction. ADR-013 made the local directory the
 * auth source of truth, yet dashboard-disable only ever flipped the
 * Nextcloud flag: a "disabled" member could still sign in through
 * /auth/login. The local write closes that and is what makes the
 * last-operator count honest. The NC flag becomes the downstream mirror
 * (best-effort + logged, same posture as the droplet-admins cascade).
 */
describe("POST /api/auth/users/:username/disable — WARP-1526 rails", () => {
  it("disabling the OWNER → 403 OWNER_IMMUTABLE; Nextcloud untouched, nothing revoked, no audit row", async () => {
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

    const res = await request(app).post("/api/auth/users/boss/disable");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
    expect(nc.ncSetUserEnabled).not.toHaveBeenCalled();
    expect(revokeAllSessions).not.toHaveBeenCalled();
    expect(vi.mocked(recordActivity)).not.toHaveBeenCalled();
    expect(prisma._users[0].directoryStatus).toBe("ACTIVE");
  });

  it("disabling YOURSELF → 409 SELF_ACTION_NOT_ALLOWED; Nextcloud untouched", async () => {
    const prisma = createPrismaMock([
      {
        id: "admin-id", // buildApp's synthetic req.user.id for callerRole=admin
        username: "user-admin",
        nextcloudUsername: "selfadmin",
        displayName: "Self Admin",
        role: "admin",
        directoryStatus: "ACTIVE",
      },
      // A second ACTIVE operator so the refusal provably comes from the
      // self-action rail, not the last-operator invariant.
      {
        id: "u-other",
        username: "other",
        nextcloudUsername: "other",
        displayName: "Other",
        role: "admin",
        directoryStatus: "ACTIVE",
      },
    ]);
    const app = buildApp(prisma, "admin");

    const res = await request(app).post("/api/auth/users/selfadmin/disable");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SELF_ACTION_NOT_ALLOWED");
    expect(nc.ncSetUserEnabled).not.toHaveBeenCalled();
  });

  it("disabling the last ACTIVE operator → 409 LAST_OPERATOR_INVARIANT with the design copy; nothing disabled anywhere", async () => {
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

    const res = await request(app).post("/api/auth/users/sam/disable");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LAST_OPERATOR_INVARIANT");
    expect(res.body.error).toBe(
      "This is the last person who can manage access — give someone else an admin role first.",
    );
    expect(nc.ncSetUserEnabled).not.toHaveBeenCalled();
    expect(revokeAllSessions).not.toHaveBeenCalled();
    expect(prisma._users[0].directoryStatus).toBe("ACTIVE");
  });

  it("a permitted disable writes directoryStatus=DEACTIVATED on the local row (the ADR-013 truth) AND mirrors to Nextcloud", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/alice/disable");

    expect(res.status).toBe(200);
    expect(prisma._users[0].directoryStatus).toBe("DEACTIVATED");
    expect(nc.ncSetUserEnabled).toHaveBeenCalledWith("test-nc-token", "alice", false);
    expect(revokeAllSessions).toHaveBeenCalledWith("u-alice");
  });

  it("an NC outage no longer fails the disable — the local row is truth; the mirror is best-effort (logged)", async () => {
    // SEMANTICS CHANGE (WARP-1526, conscious): previously ncSetUserEnabled
    // ran FIRST and its failure 500'd the whole disable with nothing done.
    // Now the guard transaction commits the local DEACTIVATED (login +
    // middleware fail closed immediately) and the NC mirror failure is
    // logged for the operator — same best-effort posture as the
    // droplet-admins cascade.
    (nc.ncSetUserEnabled as any).mockRejectedValueOnce(new Error("nc down"));
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/alice/disable");

    expect(res.status).toBe(200);
    expect(prisma._users[0].directoryStatus).toBe("DEACTIVATED");
    expect(revokeAllSessions).toHaveBeenCalledWith("u-alice");
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({ what: "User disabled" }),
    );
  });
});

describe("POST /api/auth/users/:username/enable — WARP-1526 local re-activate", () => {
  it("flips the local row back to ACTIVE and mirrors enabled=true to Nextcloud", async () => {
    const prisma = createPrismaMock([
      { ...seededAlice(), directoryStatus: "DEACTIVATED" },
    ]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/alice/enable");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "enabled", username: "alice" });
    expect(prisma._users[0].directoryStatus).toBe("ACTIVE");
    expect(nc.ncSetUserEnabled).toHaveBeenCalledWith("test-nc-token", "alice", true);
  });

  it("legacy NC-only enable (no local row) keeps working", async () => {
    const prisma = createPrismaMock([]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/legacy/enable");

    expect(res.status).toBe(200);
    expect(nc.ncSetUserEnabled).toHaveBeenCalledWith("test-nc-token", "legacy", true);
  });
});

/**
 * pr-reviewer (#1229) — the disable path's rail-5 count + local
 * directoryStatus write must run at SERIALIZABLE, not the READ COMMITTED
 * default Postgres/Prisma actually give you. Under READ COMMITTED two
 * concurrent disables of the last two operators both count "one other
 * operator remains", both pass, and both commit — zero non-disabled
 * owner-union-admin, the exact state LAST_OPERATOR_INVARIANT exists to
 * prevent. The mock runs the callback serially, so only the OPTION can be
 * asserted; that is what stops the silent regression coming back.
 */
describe("POST /api/auth/users/:username/disable — serializable isolation", () => {
  it("passes { isolationLevel: 'Serializable' } to the guard $transaction", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/alice/disable");

    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: "Serializable",
    });
  });
});

/**
 * WARP-1526 — pr-reviewer #1229 N1.
 *
 * This branch introduced the fail-soft disable (local row is truth, NC is
 * a best-effort mirror), so it owns the consequence: Nextcloud is proxied
 * at `/nextcloud/` with no orchestrator auth in front, so a still-enabled
 * NC account keeps web + WebDAV + desktop-sync access even though every
 * orchestrator login gate now refuses. A bare 200 and an unqualified
 * "User disabled" audit row would hide that from the operator.
 */
describe("POST /api/auth/users/:username/disable — N1 degraded-mirror honesty", () => {
  it("a failed NC mirror still 200s (local revocation is authoritative) but SAYS SO in the body", async () => {
    (nc.ncSetUserEnabled as any).mockRejectedValueOnce(new Error("nc down"));
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/alice/disable");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "disabled",
      username: "alice",
      ncMirror: "failed",
    });
    expect(res.body.warning).toMatch(/Nextcloud/i);
    expect(prisma._users[0].directoryStatus).toBe("DEACTIVATED");
  });

  it("the audit row carries the degraded marker so the trail is not falsely clean", async () => {
    (nc.ncSetUserEnabled as any).mockRejectedValueOnce(new Error("nc down"));
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    await request(app).post("/api/auth/users/alice/disable");

    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warn",
        what: "User disabled",
        refs: expect.objectContaining({ ncMirror: "failed" }),
      }),
    );
  });

  it("the happy path reports a synced mirror and no warning", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app).post("/api/auth/users/alice/disable");

    expect(res.body.ncMirror).toBe("synced");
    expect(res.body.warning).toBeUndefined();
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        refs: expect.objectContaining({ ncMirror: "synced" }),
      }),
    );
  });
});
