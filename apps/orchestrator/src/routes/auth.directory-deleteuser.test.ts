/**
 * WARP-3113 — Delete schedules a 30-day retention (the route) and the nightly
 * job completes the removal (leaver-deletion.service.ts). Both halves are
 * exercised here against one Prisma stub.
 *
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

// WARP-3169 — the hand-over transfer runs through the host helper; the exec
// boundary is the seam, so the argv ncTransferOwnership builds is asserted.
const { hostExecMock } = vi.hoisted(() => ({ hostExecMock: vi.fn() }));
vi.mock("../services/update-agent/host-exec.js", () => ({
  getOtaHost: () => ({
    exec: hostExecMock,
    helperPath: "/opt/droplet/docker/ota/apply-update.sh",
    composeFile: "/opt/droplet/docker/docker-compose.yml",
    runner: {},
  }),
}));

import { createProtectedAuthRouter } from "./auth.js";
import { purgeDueDeletions } from "../services/leaver-deletion.service.js";
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
  const users: any[] = seed.map((u) => ({ deletionStatus: "NONE", deletionDueAt: null, ...u }));
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
        (u) =>
          u.id === where.id &&
          (where.role === undefined || u.role === where.role) &&
          // WARP-3169: the claim / release / revoke pin the deletion state.
          (where.deletionStatus === undefined || u.deletionStatus === where.deletionStatus),
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
        const delOk =
          where?.deletionStatus === undefined ||
          u.deletionStatus === where.deletionStatus;
        if (idOk && statusOk && delOk) users.splice(i, 1);
      }
      return { count: before - users.length };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (let i = 0; i < users.length; i += 1) {
        const u = users[i];
        if (where.id !== undefined && u.id !== where.id) continue;
        if (where.directoryStatus !== undefined && u.directoryStatus !== where.directoryStatus) continue;
        const del = where.deletionStatus;
        if (del !== undefined) {
          const allowed = typeof del === "string" ? [del] : del.in;
          if (!allowed.includes(u.deletionStatus)) continue;
        }
        // The nightly claim: OR of { status, due <= now } branches.
        if (
          where.OR &&
          !where.OR.some(
            (c: any) =>
              u.deletionStatus === c.deletionStatus &&
              (c.deletionDueAt === undefined || u.deletionDueAt <= c.deletionDueAt.lte),
          )
        ) {
          continue;
        }
        users[i] = { ...u, ...data };
        count += 1;
      }
      return { count };
    }),
    findMany: vi.fn(async ({ where }: any) =>
      users.filter(
        (u) =>
          u.directoryStatus === where.directoryStatus &&
          where.OR.some(
            (c: any) =>
              u.deletionStatus === c.deletionStatus &&
              (c.deletionDueAt === undefined || u.deletionDueAt <= c.deletionDueAt.lte),
          ),
      ),
    ),
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
  // WARP-3059 — and their sync cursors, which carry the old account's delta
  // positions. Same reason for a real delegate: a missing one would be a
  // swallowed TypeError that reads as "purged".
  self.m365DeltaCursor = {
    deleteMany: vi.fn(async () => ({ count: 0 })),
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
    deletionStatus: "NONE",
    deletionDueAt: null,
  };
}

const RETAIN = { disposition: "retention" };
function del(app: any, handle: string) {
  return request(app).delete(`/api/auth/users/${handle}`).send(RETAIN);
}
const OWNER_ROW = {
  id: "own",
  username: "o",
  nextcloudUsername: "o",
  role: "owner",
  directoryStatus: "ACTIVE",
  deletionStatus: "NONE",
};
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  revokeAllSessionsMock.mockResolvedValue(2);
  (nc.ncDeleteUser as any).mockResolvedValue(undefined);
  (nc.ncSetUserEnabled as any).mockResolvedValue(undefined);
  purgeUserDataMock.mockResolvedValue({ items: 0, chunks: 0 });
});


describe("DELETE /api/auth/users/:username — WARP-3113 schedules, never purges", () => {
  it("a DELETE with no body (iOS/Mac on main) defaults to retention and the audit says so", async () => {
    const prisma = createPrismaMock([seededAlice(), OWNER_ROW]);
    const res = await request(buildApp(prisma)).delete("/api/auth/users/alice");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending_deletion");
    expect(prisma._users.find((u: any) => u.id === "u-alice")).toMatchObject({
      directoryStatus: "DEACTIVATED",
      deletionStatus: "PENDING",
    });
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "User deletion scheduled",
        refs: expect.objectContaining({
          disposition: "retention",
          dispositionDefaulted: true,
          dispositionNote: "disposition defaulted: retention (client sent none)",
        }),
      }),
    );
  });

  it("an explicit disposition is recorded as chosen, not defaulted; an unknown one is a 400", async () => {
    const prisma = createPrismaMock([seededAlice(), OWNER_ROW]);
    const app = buildApp(prisma);
    const bad = await request(app).delete("/api/auth/users/alice").send({ disposition: "purge_now" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("UNKNOWN_DISPOSITION");
    expect(prisma._users.find((u: any) => u.id === "u-alice").deletionStatus).toBe("NONE");

    await del(app, "alice");
    const row = vi.mocked(recordActivity).mock.calls.at(-1)![0] as any;
    expect(row.refs).toMatchObject({ disposition: "retention", dispositionDefaulted: false });
    expect(row.refs.dispositionNote).toBeUndefined();
  });

  it("revokes now, keeps the files, and marks PENDING 30 days out — audited with the actor", async () => {
    const prisma = createPrismaMock([seededAlice(), OWNER_ROW]);
    const before = Date.now();
    const res = await del(buildApp(prisma), "alice");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending_deletion");
    const row = prisma._users.find((u: any) => u.id === "u-alice");
    expect(row).toMatchObject({
      directoryStatus: "DEACTIVATED",
      deletionStatus: "PENDING",
      deletionRequestedBy: "user-owner",
    });
    const due = new Date(row.deletionDueAt).getTime();
    expect(due - before).toBeGreaterThanOrEqual(30 * DAY - 1000);
    expect(due - before).toBeLessThanOrEqual(30 * DAY + 5000);
    // Nothing is purged at request time.
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
    expect(purgeUserDataMock).not.toHaveBeenCalled();
    // WebDAV cut off through the Nextcloud enable flag; sessions ended.
    expect(nc.ncSetUserEnabled).toHaveBeenCalledWith(SERVICE_NC_TOKEN, "alice", false);
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u-alice");
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "User deletion scheduled",
        refs: expect.objectContaining({ actor: "user-owner", targetUserId: "u-alice", disposition: "retention" }),
        actor: expect.objectContaining({ type: "user" }),
      }),
    );
  });

  it("the rails still apply: the owner can't be scheduled (403), nor yourself (409), nor the last operator (409)", async () => {
    const owner = createPrismaMock([{ ...OWNER_ROW, id: "u-boss", nextcloudUsername: "boss" }]);
    expect((await del(buildApp(owner, "admin"), "boss")).body.code).toBe("OWNER_IMMUTABLE");

    const self = createPrismaMock([
      { id: "owner-id", username: "user-owner", nextcloudUsername: "selfowner", role: "admin", directoryStatus: "ACTIVE" },
      { id: "u-other", username: "other", nextcloudUsername: "other", role: "admin", directoryStatus: "ACTIVE" },
    ]);
    expect((await del(buildApp(self, "owner"), "selfowner")).body.code).toBe("SELF_ACTION_NOT_ALLOWED");

    const last = createPrismaMock([
      { id: "u-sam", username: "sam", nextcloudUsername: "sam", role: "admin", directoryStatus: "ACTIVE" },
    ]);
    const res = await del(buildApp(last, "admin"), "sam");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LAST_OPERATOR_INVARIANT");
    expect(last._users[0].deletionStatus).toBe("NONE");
    expect(vi.mocked(recordActivity)).not.toHaveBeenCalled();
  });

  it("runs the rails at SERIALIZABLE and pins the write to the evaluated role", async () => {
    const prisma = createPrismaMock([seededAlice(), OWNER_ROW]);
    await del(buildApp(prisma), "alice");
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-alice", role: "family", deletionStatus: "NONE" } }),
    );
  });

  it("a serialization loser (P2034) is a 409 and schedules nothing", async () => {
    const prisma = createPrismaMock([seededAlice(), OWNER_ROW]);
    const conflict: any = new Error("could not serialize access");
    conflict.code = "P2034";
    prisma.user.update.mockRejectedValueOnce(conflict);
    const res = await del(buildApp(prisma), "alice");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONCURRENT_MUTATION");
    expect(vi.mocked(recordActivity)).not.toHaveBeenCalled();
  });

  it("is idempotent: a second DELETE keeps the first date", async () => {
    const prisma = createPrismaMock([seededAlice(), OWNER_ROW]);
    const app = buildApp(prisma);
    const first = await del(app, "alice");
    const second = await del(app, "alice");
    expect(second.status).toBe(200);
    expect(new Date(second.body.deletionDueAt).getTime()).toBe(new Date(first.body.deletionDueAt).getTime());
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("a legacy Nextcloud-only account (no row) can't be scheduled — refused, never purged", async () => {
    const prisma = createPrismaMock([]);
    const res = await del(buildApp(prisma), "legacy");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NO_DIRECTORY_ROW");
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
  });

  it("sequential admin schedules DO trip the last-operator rail", async () => {
    const prisma = createPrismaMock([
      { id: "u-sam", username: "sam", nextcloudUsername: "sam", role: "admin", directoryStatus: "ACTIVE" },
      { id: "u-kim", username: "kim", nextcloudUsername: "kim", role: "admin", directoryStatus: "ACTIVE" },
    ]);
    const app = buildApp(prisma, "admin");
    expect((await del(app, "sam")).status).toBe(200);
    const second = await del(app, "kim");
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("LAST_OPERATOR_INVARIANT");
  });
});

describe("cancel + reactivate while pending — WARP-3113", () => {
  it("cancel clears the schedule, keeps the person deactivated, and audits the actor", async () => {
    const prisma = createPrismaMock([seededAlice(), OWNER_ROW]);
    const app = buildApp(prisma);
    await del(app, "alice");
    vi.mocked(recordActivity).mockClear();

    const res = await request(app).post("/api/auth/users/alice/cancel-deletion");
    expect(res.status).toBe(200);
    expect(prisma._users.find((u: any) => u.id === "u-alice")).toMatchObject({
      directoryStatus: "DEACTIVATED",
      deletionStatus: "NONE",
      deletionDueAt: null,
    });
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({ what: "User deletion cancelled", refs: expect.objectContaining({ actor: "user-owner" }) }),
    );
  });

  it("cancel with nothing pending → 409; members can't cancel (403)", async () => {
    const prisma = createPrismaMock([seededAlice(), OWNER_ROW]);
    expect((await request(buildApp(prisma)).post("/api/auth/users/alice/cancel-deletion")).status).toBe(409);
    expect((await request(buildApp(prisma, "family")).post("/api/auth/users/alice/cancel-deletion")).status).toBe(403);
  });

  it("reactivating a person scheduled for deletion is refused until the deletion is cancelled", async () => {
    const prisma = createPrismaMock([seededAlice(), OWNER_ROW]);
    const app = buildApp(prisma);
    await del(app, "alice");
    const refused = await request(app).post("/api/auth/users/alice/enable");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("DELETION_PENDING");

    await request(app).post("/api/auth/users/alice/cancel-deletion");
    vi.mocked(recordActivity).mockClear();
    const ok = await request(app).post("/api/auth/users/alice/enable");
    expect(ok.status).toBe(200);
    expect(prisma._users.find((u: any) => u.id === "u-alice").directoryStatus).toBe("ACTIVE");
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({ what: "User reactivated", refs: expect.objectContaining({ actor: "user-owner" }) }),
    );
  });
});

describe("purgeDueDeletions — the nightly job (WARP-3113)", () => {
  const due = () => ({
    ...seededAlice(),
    directoryStatus: "DEACTIVATED",
    deletionStatus: "PENDING",
    deletionDueAt: new Date(Date.now() - DAY),
    deletionRequestedBy: "user-owner",
  });

  it("leaves a deletion that isn't due yet alone", async () => {
    const prisma = createPrismaMock([{ ...due(), deletionDueAt: new Date(Date.now() + DAY) }]);
    expect(await purgeDueDeletions(prisma)).toEqual({ completed: 0, failed: 0 });
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
  });

  it("completes a due deletion: Nextcloud account, brain memory, M365 link, the row, then 'User removed'", async () => {
    const prisma = createPrismaMock([due()]);
    expect(await purgeDueDeletions(prisma)).toEqual({ completed: 1, failed: 0 });
    expect(nc.ncDeleteUser).toHaveBeenCalledWith(SERVICE_NC_TOKEN, "alice");
    expect(purgeUserDataMock).toHaveBeenCalledWith(prisma, "u-alice");
    expect(prisma.m365Connection.deleteMany).toHaveBeenCalledWith({ where: { userId: "u-alice" } });
    expect(prisma._users).toHaveLength(0);
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u-alice");
    expect(denylistUserMock).toHaveBeenCalledWith("u-alice", expect.any(Number));
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "User removed",
        // The job is the clock; the audit names who asked for it.
        refs: expect.objectContaining({ actor: "user-owner", targetUserId: "u-alice" }),
        actor: { type: "system" },
      }),
    );
  });

  it("a failed Nextcloud delete keeps the row claimed (PURGING) and the next run retries it", async () => {
    (nc.ncDeleteUser as any).mockRejectedValueOnce(new Error("nc down"));
    const prisma = createPrismaMock([due()]);
    expect(await purgeDueDeletions(prisma)).toEqual({ completed: 0, failed: 1 });
    const row = prisma._users.find((u: any) => u.id === "u-alice");
    expect(row).toMatchObject({ directoryStatus: "DEACTIVATED", deletionStatus: "PURGING" });

    // A claimed row can no longer be cancelled.
    const cancel = await request(buildApp(prisma)).post("/api/auth/users/alice/cancel-deletion");
    expect(cancel.status).toBe(409);

    expect(await purgeDueDeletions(prisma)).toEqual({ completed: 1, failed: 0 });
    expect(prisma._users).toHaveLength(0);
  });

  it("a person with no Nextcloud account (SSO/SCIM) is removed without a Nextcloud call", async () => {
    const prisma = createPrismaMock([{ ...due(), nextcloudUsername: null }]);
    expect(await purgeDueDeletions(prisma)).toEqual({ completed: 1, failed: 0 });
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
    expect(prisma._users).toHaveLength(0);
  });
});

describe("WARP-3113 review follow-ups", () => {
  const due = (over: any = {}) => ({
    ...seededAlice(),
    directoryStatus: "DEACTIVATED",
    deletionStatus: "PENDING",
    deletionDueAt: new Date(Date.now() - DAY),
    deletionRequestedBy: "user-owner",
    ...over,
  });

  it("uses the person's Nextcloud login, not their username, to disable and to delete", async () => {
    const row = { ...seededAlice(), username: "alice.m", nextcloudUsername: "amartin" };
    const prisma = createPrismaMock([row, OWNER_ROW]);
    expect((await del(buildApp(prisma), "amartin")).status).toBe(200);
    expect(nc.ncSetUserEnabled).toHaveBeenCalledWith(SERVICE_NC_TOKEN, "amartin", false);

    prisma._users.find((u: any) => u.id === "u-alice").deletionDueAt = new Date(Date.now() - DAY);
    await purgeDueDeletions(prisma);
    expect(nc.ncDeleteUser).toHaveBeenCalledWith(SERVICE_NC_TOKEN, "amartin");
  });

  it("scheduling denylists access tokens and runs the shared disable step ('User disabled')", async () => {
    const prisma = createPrismaMock([seededAlice(), OWNER_ROW]);
    await del(buildApp(prisma), "alice");
    expect(denylistUserMock).toHaveBeenCalledWith("u-alice", expect.any(Number));
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({ what: "User disabled", refs: expect.objectContaining({ targetUserId: "u-alice" }) }),
    );
  });

  it.todo("WARP-3160: scheduling revokes the person's overlay devices (revokeOverlayDevicesForUser, once #2403 is on stage)");

  it("the job skips an ACTIVE row even if it is marked PENDING", async () => {
    const prisma = createPrismaMock([due({ directoryStatus: "ACTIVE" })]);
    expect(await purgeDueDeletions(prisma)).toEqual({ completed: 0, failed: 0 });
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
    expect(prisma._users).toHaveLength(1);
  });

  it("the claim re-checks the due date: a cancel + re-delete after the job's read is not purged early", async () => {
    const prisma = createPrismaMock([due()]);
    // The job read a stale snapshot (due yesterday); meanwhile an admin
    // cancelled and deleted again, so the stored date is 30 days out.
    const stale = prisma._users.map((u: any) => ({ ...u }));
    prisma.user.findMany.mockResolvedValueOnce(stale);
    prisma._users[0].deletionDueAt = new Date(Date.now() + 30 * DAY);

    expect(await purgeDueDeletions(prisma)).toEqual({ completed: 0, failed: 0 });
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
    expect(prisma._users[0].deletionStatus).toBe("PENDING");
  });
});


describe("DELETE /api/auth/users/:username — WARP-3169 hand-over", () => {
  const BOB = {
    id: "u-bob",
    username: "bob",
    nextcloudUsername: "bob",
    role: "family",
    directoryStatus: "ACTIVE",
    deletionStatus: "NONE",
  };
  const OCC_OUT =
    "Analysing files of alice ...\nTransferring files to bob/files/transferred from alice on 2026-09-25 22-40-00 ...\nRestoring shares ...\n";

  function handover(app: any, recipientId?: string) {
    return request(app)
      .delete("/api/auth/users/alice")
      .send({ disposition: "handover", ...(recipientId !== undefined ? { recipientId } : {}) });
  }

  function expectAliceUntouched(prisma: any) {
    const alice = prisma._users.find((u: any) => u.id === "u-alice");
    expect(alice).toMatchObject({ directoryStatus: "ACTIVE", deletionStatus: "NONE" });
    expect(nc.ncSetUserEnabled).not.toHaveBeenCalled();
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    hostExecMock.mockReset();
    hostExecMock.mockResolvedValue({ stdout: OCC_OUT, stderr: "" });
  });

  it("transfers the files, then deletes at once, and audits who handed what to whom", async () => {
    const prisma = createPrismaMock([OWNER_ROW, seededAlice(), BOB]);
    const res = await handover(buildApp(prisma, "owner"), "u-bob");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "deleted",
      recipient: "bob",
      folder: "transferred from alice on 2026-09-25 22-40-00",
    });
    expect(hostExecMock).toHaveBeenCalledTimes(1);
    expect(hostExecMock.mock.calls[0][0]).toBe("/opt/droplet/docker/ota/apply-update.sh");
    expect(hostExecMock.mock.calls[0][1]).toEqual([
      "nc-transfer-ownership",
      "--compose-file",
      "/opt/droplet/docker/docker-compose.yml",
      "--from",
      "alice",
      "--to",
      "bob",
    ]);
    expect(nc.ncDeleteUser).toHaveBeenCalledWith(SERVICE_NC_TOKEN, "alice");
    expect(prisma._users.find((u: any) => u.id === "u-alice")).toBeUndefined();
    const handed = (recordActivity as any).mock.calls.find(
      (c: any[]) => c[0].what === "Files handed over",
    );
    expect(handed?.[0].refs).toMatchObject({
      actor: "user-owner",
      targetUsername: "alice",
      recipientUsername: "bob",
      folder: "transferred from alice on 2026-09-25 22-40-00",
    });
    // The transfer is recorded before the account is removed.
    const order = (recordActivity as any).mock.calls.map((c: any[]) => c[0].what);
    expect(order.indexOf("Files handed over")).toBeLessThan(order.length - 1);
  });

  it.each([
    ["an external guest", { ...BOB, role: "guest" }, "u-bob", "RECIPIENT_ROLE"],
    ["a deactivated person", { ...BOB, directoryStatus: "DEACTIVATED" }, "u-bob", "RECIPIENT_NOT_ACTIVE"],
    ["a person already pending deletion", { ...BOB, deletionStatus: "PENDING" }, "u-bob", "RECIPIENT_NOT_ACTIVE"],
    ["the leaver", BOB, "u-alice", "RECIPIENT_IS_LEAVER"],
    ["someone unknown", BOB, "u-nobody", "RECIPIENT_UNKNOWN"],
    // By id only: a username or Nextcloud handle is not a recipient id.
    ["a username instead of an id", BOB, "bob", "RECIPIENT_UNKNOWN"],
  ])("refuses %s as recipient and changes nothing", async (_label, recipientRow, handle, code) => {
    const prisma = createPrismaMock([OWNER_ROW, seededAlice(), recipientRow]);
    const res = await handover(buildApp(prisma, "owner"), handle);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(hostExecMock).not.toHaveBeenCalled();
    expectAliceUntouched(prisma);
  });

  it("refuses a hand-over with no recipient", async () => {
    const prisma = createPrismaMock([OWNER_ROW, seededAlice(), BOB]);
    const res = await handover(buildApp(prisma, "owner"));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RECIPIENT_REQUIRED");
    expect(hostExecMock).not.toHaveBeenCalled();
    expectAliceUntouched(prisma);
  });

  it("a timeout after occ started says the result may be partial, audits it, and deletes nothing", async () => {
    const err: any = new Error("OTA host helper nc-transfer-ownership exited 124: ");
    err.stderr = "[apply-update] nc-transfer-ownership alice -> bob\n";
    hostExecMock.mockRejectedValue(err);
    const prisma = createPrismaMock([OWNER_ROW, seededAlice(), BOB]);
    const res = await handover(buildApp(prisma, "owner"), "u-bob");

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("HANDOVER_INCOMPLETE");
    expect(res.body.error).toMatch(/may already be in bob's "Transferred from/);
    expect(res.body.error).toMatch(/Nothing was deleted/);
    expectAliceUntouched(prisma);
    const failed = (recordActivity as any).mock.calls.find(
      (c: any[]) => c[0].what === "File hand-over failed, may be partial",
    );
    expect(failed?.[0].refs).toMatchObject({
      actor: "user-owner",
      targetUsername: "alice",
      recipientUsername: "bob",
      reason: "timed out",
      mayBePartial: true,
    });
  });

  it("a second hand-over of the same leaver while one runs is refused with 409 and never transfers", async () => {
    let finish: (v: any) => void = () => undefined;
    hostExecMock.mockImplementation(() => new Promise((r) => (finish = r)));
    const prisma = createPrismaMock([OWNER_ROW, seededAlice(), BOB]);
    const app = buildApp(prisma, "owner");

    const first = handover(app, "u-bob").then((r) => r);
    await vi.waitFor(() => expect(hostExecMock).toHaveBeenCalledTimes(1));
    expect(prisma._users.find((u: any) => u.id === "u-alice").deletionStatus).toBe("HANDING_OVER");

    const second = await handover(app, "u-bob");
    expect(second.status).toBe(409);
    // A retention delete can't overwrite the claim either.
    const retain = await del(app, "alice");
    expect(retain.status).toBe(409);
    expect(hostExecMock).toHaveBeenCalledTimes(1);

    finish({ stdout: OCC_OUT, stderr: "" });
    expect((await first).status).toBe(200);
  });

  it("a failed transfer releases the claim back to PENDING for a person on retention", async () => {
    hostExecMock.mockRejectedValue(new Error("exited 1"));
    const pending = { ...seededAlice(), directoryStatus: "DEACTIVATED", deletionStatus: "PENDING", deletionDueAt: new Date(Date.now() + 5 * DAY) };
    const prisma = createPrismaMock([OWNER_ROW, pending, BOB]);
    const res = await handover(buildApp(prisma, "owner"), "u-bob");
    expect(res.status).toBe(502);
    expect(prisma._users.find((u: any) => u.id === "u-alice").deletionStatus).toBe("PENDING");
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
  });

  it("a failed transfer returns an error and changes nothing — no deactivation, no delete", async () => {
    const err: any = new Error("OTA host helper nc-transfer-ownership exited 1");
    err.stderr = "[apply-update] ERROR: unknown Nextcloud user: bob\n";
    hostExecMock.mockRejectedValue(err);
    const prisma = createPrismaMock([OWNER_ROW, seededAlice(), BOB]);
    const res = await handover(buildApp(prisma, "owner"), "u-bob");

    expect(res.status).toBe(502);
    // The helper refused before occ ran (no start marker), so nothing moved.
    expect(res.body.code).toBe("HANDOVER_FAILED");
    expect(res.body.error).toMatch(/nothing was changed/);
    expectAliceUntouched(prisma);
    expect(
      (recordActivity as any).mock.calls.some((c: any[]) => c[0].what === "Files handed over"),
    ).toBe(false);
  });

  it("still refuses the owner as the leaver before any transfer", async () => {
    const prisma = createPrismaMock([
      { ...OWNER_ROW, id: "own2", username: "o2", nextcloudUsername: "o2" },
      OWNER_ROW,
      BOB,
    ]);
    const res = await request(buildApp(prisma, "admin"))
      .delete("/api/auth/users/o2")
      .send({ disposition: "handover", recipientId: "u-bob" });
    expect(res.status).toBe(403);
    expect(hostExecMock).not.toHaveBeenCalled();
  });
});
