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
    ncDeleteShare: vi.fn().mockResolvedValue(undefined),
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

// WARP-3600 — a removed mailbox nudges the email-indexer; the hop is the seam.
const { requestIndexerRefreshMock } = vi.hoisted(() => ({
  requestIndexerRefreshMock: vi.fn().mockResolvedValue(true),
}));
vi.mock("../services/email/provision.service.js", () => ({
  requestIndexerRefresh: requestIndexerRefreshMock,
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

// WARP-3160 — lifecycle post-effects revoke the leaver's overlay/VPN devices.
const { revokeOverlayDevicesMock } = vi.hoisted(() => ({
  revokeOverlayDevicesMock: vi.fn(async () => ({ revoked: 1, failed: 0, hqPending: 0, pendingDenied: 0 })),
}));
vi.mock("../services/vpn-peer-revoke.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/vpn-peer-revoke.service.js")>()),
  revokeOverlayDevicesForUser: revokeOverlayDevicesMock,
}));

// WARP-3384 — Delete revokes the person's paired file-sync devices.
const { revokeDeviceClientsMock } = vi.hoisted(() => ({
  revokeDeviceClientsMock: vi.fn(async () => ({ revoked: 2, appPasswordsNotDeleted: 0, failed: 0 })),
}));
vi.mock("../services/device-client-revoke.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/device-client-revoke.service.js")>()),
  revokeDeviceClientsForUser: revokeDeviceClientsMock,
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
import {
  purgeDueDeletions,
  releaseStaleHandovers,
  HANDOVER_STALE_MS,
} from "../services/leaver-deletion.service.js";
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
          (where.deletionStatus === undefined || u.deletionStatus === where.deletionStatus) &&
          // WARP-3176: the release / revoke are pinned to the request's claim.
          (where.deletionClaimedAt === undefined ||
            u.deletionClaimedAt?.getTime() === where.deletionClaimedAt?.getTime()),
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
        // WARP-3176: the stale-claim release is pinned to the claim time read.
        if (
          where.deletionClaimedAt !== undefined &&
          u.deletionClaimedAt?.getTime() !== where.deletionClaimedAt?.getTime()
        ) {
          continue;
        }
        // The nightly claim: OR of { status, due <= now } branches.
        if (
          where.OR &&
          !where.OR.some(
            (c: any) =>
              u.deletionStatus === c.deletionStatus &&
              (c.deletionDueAt === undefined || u.deletionDueAt <= c.deletionDueAt.lte) &&
              (c.deletionClaimedAt === undefined ||
                (u.deletionClaimedAt != null && u.deletionClaimedAt <= c.deletionClaimedAt.lte)),
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
          (where.directoryStatus === undefined || u.directoryStatus === where.directoryStatus) &&
          (where.deletionStatus === undefined || u.deletionStatus === where.deletionStatus) &&
          // WARP-3176: the stale-claim sweep ages the claim.
          (where.deletionClaimedAt === undefined ||
            (u.deletionClaimedAt != null && u.deletionClaimedAt <= where.deletionClaimedAt.lte)) &&
          (where.OR === undefined ||
            where.OR.some(
              (c: any) =>
                u.deletionStatus === c.deletionStatus &&
                (c.deletionDueAt === undefined || u.deletionDueAt <= c.deletionDueAt.lte) &&
                (c.deletionClaimedAt === undefined ||
                  (u.deletionClaimedAt != null && u.deletionClaimedAt <= c.deletionClaimedAt.lte)),
            )),
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
  // WARP-3193 SEC-AUTH-6 — the username-keyed private tables. Seeded with one
  // row per seeded user plus one for a bystander, so a test can prove the
  // purge took exactly the removed person's rows.
  const owners = [...seed.map((u: any) => u.username), "bystander"];
  const usernameTables: Record<string, { key: string; rows: any[] }> = {
    note: { key: "userId", rows: [] },
    calendarEvent: { key: "userId", rows: [] },
    calendarSource: { key: "userId", rows: [] },
    reminder: { key: "userId", rows: [] },
    chatSession: { key: "userId", rows: [] },
    chatProject: { key: "userId", rows: [] },
    pushSubscription: { key: "username", rows: [] },
  };
  for (const [model, t] of Object.entries(usernameTables)) {
    for (const o of owners) t.rows.push({ [t.key]: o });
    self[model] = {
      deleteMany: vi.fn(async ({ where }: any = {}) => {
        const before = t.rows.length;
        for (let i = t.rows.length - 1; i >= 0; i -= 1) {
          if (t.rows[i][t.key] === where?.[t.key]) t.rows.splice(i, 1);
        }
        return { count: before - t.rows.length };
      }),
    };
  }
  // WARP-3600 — the rows keyed by User.id (mailboxes) and by the Nextcloud
  // login (file index), with the lookalikes a wrong scope would take: a
  // bystander, a login that merely starts with the leaver's, and the shared
  // library sentinel. Brain chunks (keyed by User.id) are not this code's.
  const ids = seed.map((u: any) => u.id);
  const logins = seed.map((u: any) => u.nextcloudUsername).filter((l: any) => l);
  const ownedTables: Record<string, any[]> = {
    emailAccount: [...ids, "bystander-id"].map((userId) => ({ userId })),
    fileContentChunk: [
      ...logins.map((userId: string) => ({ userId, source: "nextcloud" })),
      ...logins.map((l: string) => ({ userId: `${l}2`, source: "nextcloud" })),
      ...ids.map((userId: string) => ({ userId, source: "brain" })),
      { userId: "__household__", source: "nextcloud" },
      { userId: "bystander", source: "nextcloud" },
    ],
    fileIndexStatus: [
      ...logins.map((userId: string) => ({ userId })),
      ...logins.map((l: string) => ({ userId: `${l}2` })),
      { userId: "__household__" },
      { userId: "bystander" },
    ],
  };
  for (const [model, rows] of Object.entries(ownedTables)) {
    self[model] = {
      deleteMany: vi.fn(async ({ where }: any = {}) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (Object.entries(where).every(([k, v]) => rows[i][k] === v)) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      }),
    };
  }
  self._ownedRows = (model: string, key: string, source?: string) =>
    ownedTables[model]!.filter((r) => r.userId === key && (source === undefined || r.source === source)).length;
  const shareRows: any[] = [
    ...ids.flatMap((createdById: string, i: number) => [
      { id: `s-${createdById}-a`, ncShareId: 100 + i * 10, createdById, revokedAt: null },
      { id: `s-${createdById}-b`, ncShareId: 101 + i * 10, createdById, revokedAt: null },
    ]),
    { id: "s-bystander", ncShareId: 900, createdById: "bystander-id", revokedAt: null },
  ];
  self.departmentShare = {
    findMany: vi.fn(async ({ where }: any) =>
      shareRows.filter((r) => r.createdById === where.createdById && r.revokedAt === where.revokedAt),
    ),
    update: vi.fn(async ({ where, data }: any) => {
      Object.assign(shareRows.find((r) => r.id === where.id), data);
    }),
  };
  self._shareRows = shareRows;
  self._usernameRows = (model: string, owner: string) =>
    usernameTables[model]!.rows.filter((r) => r[usernameTables[model]!.key] === owner).length;
  self._usernameModels = Object.keys(usernameTables);
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
  (nc.ncDeleteShare as any).mockReset().mockResolvedValue(undefined);
  requestIndexerRefreshMock.mockResolvedValue(true);
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

  // WARP-3384: scheduling the deletion revokes the person's paired devices
  // (file-sync app passwords, drive logins) now, as the removal it is, and
  // BEFORE the Nextcloud account is disabled: a disabled account cannot
  // authenticate its own app-password delete.
  it("WARP-3384: revokes the person's paired devices (removal, by the admin) BEFORE disabling Nextcloud, once", async () => {
    const prisma = createPrismaMock([seededAlice(), OWNER_ROW]);
    const res = await del(buildApp(prisma), "alice");

    expect(res.status).toBe(200);
    expect(revokeDeviceClientsMock).toHaveBeenCalledTimes(1);
    expect(revokeDeviceClientsMock).toHaveBeenCalledWith("alice", { type: "user", id: "owner-id" }, "removal");
    expect(revokeDeviceClientsMock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(nc.ncSetUserEnabled).mock.invocationCallOrder[0],
    );
  });

  it("WARP-3384: a refused delete (the owner) revokes no devices", async () => {
    const owner = createPrismaMock([{ ...OWNER_ROW, id: "u-boss", nextcloudUsername: "boss" }]);
    expect((await del(buildApp(owner, "admin"), "boss")).body.code).toBe("OWNER_IMMUTABLE");
    expect(revokeDeviceClientsMock).not.toHaveBeenCalled();
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

  it("WARP-3384: sweeps the person's device clients BEFORE the Nextcloud account is deleted", async () => {
    const prisma = createPrismaMock([due()]);
    expect(await purgeDueDeletions(prisma)).toEqual({ completed: 1, failed: 0 });
    expect(revokeDeviceClientsMock).toHaveBeenCalledWith("alice", { type: "system" }, "removal");
    expect(revokeDeviceClientsMock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(nc.ncDeleteUser).mock.invocationCallOrder[0],
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

    // WARP-3176: not while the claim is fresh (a live removal may hold it)…
    expect(await purgeDueDeletions(prisma)).toEqual({ completed: 0, failed: 0 });
    // …but on a later run, once it is stale.
    const later = new Date(Date.now() + HANDOVER_STALE_MS + 60_000);
    expect(await purgeDueDeletions(prisma, later)).toEqual({ completed: 1, failed: 0 });
    expect(prisma._users).toHaveLength(0);
  });

  it("WARP-3176: never takes over a fresh PURGING claim a hand-over is completing inline", async () => {
    const prisma = createPrismaMock([
      { ...due(), deletionStatus: "PURGING", deletionClaimedAt: new Date() },
    ]);
    expect(await purgeDueDeletions(prisma)).toEqual({ completed: 0, failed: 0 });
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
  });

  // WARP-3193 SEC-AUTH-6 — notes, calendar (incl. CalDAV credentials),
  // reminders, chats and push subscriptions key on the USERNAME with no FK
  // to User; they go with the row, in its transaction, or the next account
  // deriving the same handle inherits them.
  it("SEC-AUTH-6: purges exactly the removed person's username-keyed rows, at SERIALIZABLE with the row delete", async () => {
    const prisma = createPrismaMock([due(), OWNER_ROW]);
    expect(await purgeDueDeletions(prisma)).toEqual({ completed: 1, failed: 0 });
    for (const model of prisma._usernameModels) {
      expect(prisma._usernameRows(model, "alice"), model).toBe(0);
      expect(prisma._usernameRows(model, OWNER_ROW.username), model).toBe(1);
      expect(prisma._usernameRows(model, "bystander"), model).toBe(1);
    }
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("SEC-AUTH-6: purges nothing when the Nextcloud delete fails (the claimed row stays to retry from)", async () => {
    (nc.ncDeleteUser as any).mockRejectedValueOnce(new Error("nc down"));
    const prisma = createPrismaMock([due()]);
    expect(await purgeDueDeletions(prisma)).toEqual({ completed: 0, failed: 1 });
    for (const model of prisma._usernameModels) {
      expect(prisma._usernameRows(model, "alice"), model).toBe(1);
    }
  });

  it("SEC-AUTH-6: purges nothing when the row changed state concurrently (row not deleted)", async () => {
    const prisma = createPrismaMock([due()]);
    (nc.ncDeleteUser as any).mockImplementationOnce(async () => {
      prisma._users.find((u: any) => u.id === "u-alice").directoryStatus = "ACTIVE";
    });
    await purgeDueDeletions(prisma);
    expect(prisma._users.some((u: any) => u.id === "u-alice")).toBe(true);
    for (const model of prisma._usernameModels) {
      expect(prisma._usernameRows(model, "alice"), model).toBe(1);
    }
  });

  // WARP-3600 — the mailbox, the file index and the department links go with
  // the person, each scoped by THEIR identifier (User.id / their own Nextcloud
  // login), by equality only.
  describe("WARP-3600: the final purge is complete", () => {
    it("removes the leaver's mailbox and file-index rows in the row's own transaction, and nothing of anyone else's", async () => {
      const prisma = createPrismaMock([due(), OWNER_ROW]);
      expect(await purgeDueDeletions(prisma)).toEqual({ completed: 1, failed: 0 });
      expect(prisma.emailAccount.deleteMany).toHaveBeenCalledWith({ where: { userId: "u-alice" } });
      expect(prisma._ownedRows("emailAccount", "u-alice")).toBe(0);
      expect(prisma._ownedRows("fileContentChunk", "alice", "nextcloud")).toBe(0);
      expect(prisma._ownedRows("fileIndexStatus", "alice")).toBe(0);
      // A login that only STARTS with the leaver's, the shared library, a
      // bystander, the owner, and the leaver's brain chunks (purgeUserData's,
      // by id) are all untouched.
      expect(prisma._ownedRows("fileContentChunk", "alice2", "nextcloud")).toBe(1);
      expect(prisma._ownedRows("fileIndexStatus", "alice2")).toBe(1);
      expect(prisma._ownedRows("fileContentChunk", "__household__")).toBe(1);
      expect(prisma._ownedRows("fileIndexStatus", "__household__")).toBe(1);
      expect(prisma._ownedRows("fileContentChunk", "bystander")).toBe(1);
      expect(prisma._ownedRows("emailAccount", "bystander-id")).toBe(1);
      expect(prisma._ownedRows("emailAccount", "own")).toBe(1);
      expect(prisma._ownedRows("fileContentChunk", "o", "nextcloud")).toBe(1);
      expect(prisma._ownedRows("fileIndexStatus", "o")).toBe(1);
      expect(prisma._ownedRows("fileContentChunk", "u-alice", "brain")).toBe(1);
    });

    it("a second person later given the same login finds no chunk, index row or mailbox from the first", async () => {
      const prisma = createPrismaMock([due()]);
      await purgeDueDeletions(prisma);
      expect(prisma._ownedRows("fileContentChunk", "alice")).toBe(0);
      expect(prisma._ownedRows("fileIndexStatus", "alice")).toBe(0);
      expect(prisma._ownedRows("emailAccount", "u-alice")).toBe(0);
    });

    it("nudges the email-indexer after a mailbox is removed, and not when there was none", async () => {
      await purgeDueDeletions(createPrismaMock([due()]));
      expect(requestIndexerRefreshMock).toHaveBeenCalledTimes(1);

      requestIndexerRefreshMock.mockClear();
      const noMailbox = createPrismaMock([due()]);
      noMailbox.emailAccount.deleteMany.mockResolvedValue({ count: 0 });
      await purgeDueDeletions(noMailbox);
      expect(requestIndexerRefreshMock).not.toHaveBeenCalled();
    });

    it("a failing indexer nudge does not fail the removal", async () => {
      requestIndexerRefreshMock.mockRejectedValueOnce(new Error("indexer down"));
      expect(await purgeDueDeletions(createPrismaMock([due()]))).toEqual({ completed: 1, failed: 0 });
    });

    it("an SSO/SCIM person (no Nextcloud login) loses the mailbox by id and no file-index row is matched", async () => {
      const prisma = createPrismaMock([{ ...due(), nextcloudUsername: null }]);
      await purgeDueDeletions(prisma);
      expect(prisma._ownedRows("emailAccount", "u-alice")).toBe(0);
      expect(prisma.fileContentChunk.deleteMany).not.toHaveBeenCalled();
      expect(prisma.fileIndexStatus.deleteMany).not.toHaveBeenCalled();
    });

    it("never matches the file index with a shared-library sentinel", async () => {
      const prisma = createPrismaMock([{ ...due(), nextcloudUsername: "__household__" }]);
      await purgeDueDeletions(prisma);
      expect(prisma.fileContentChunk.deleteMany).not.toHaveBeenCalled();
      // Both the seeded row for this "login" and the sentinel's own row survive.
      expect(prisma._ownedRows("fileContentChunk", "__household__")).toBe(2);
      expect(prisma._ownedRows("fileIndexStatus", "__household__")).toBe(2);
    });

    it("removes nothing when the Nextcloud delete fails or the row changed state", async () => {
      (nc.ncDeleteUser as any).mockRejectedValueOnce(new Error("nc down"));
      const failed = createPrismaMock([due()]);
      await purgeDueDeletions(failed);
      expect(failed.emailAccount.deleteMany).not.toHaveBeenCalled();
      expect(failed._ownedRows("fileContentChunk", "alice", "nextcloud")).toBe(1);
      expect(failed.departmentShare.findMany).not.toHaveBeenCalled();

      const raced = createPrismaMock([due()]);
      (nc.ncDeleteUser as any).mockImplementationOnce(async () => {
        raced._users.find((u: any) => u.id === "u-alice").directoryStatus = "ACTIVE";
      });
      await purgeDueDeletions(raced);
      expect(raced._ownedRows("emailAccount", "u-alice")).toBe(1);
      expect(raced._ownedRows("fileIndexStatus", "alice")).toBe(1);
      expect(raced.departmentShare.findMany).not.toHaveBeenCalled();
      expect(nc.ncDeleteShare).not.toHaveBeenCalled();
    });

    it("revokes the shares the leaver minted (and only those) with the box's admin credential, keeping the rows", async () => {
      const prisma = createPrismaMock([due(), OWNER_ROW]);
      await purgeDueDeletions(prisma);
      expect(prisma.departmentShare.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { createdById: "u-alice", revokedAt: null } }),
      );
      const revoked = vi.mocked(nc.ncDeleteShare).mock.calls.map((c) => c[1]);
      expect(revoked.sort()).toEqual([100, 101]);
      expect(vi.mocked(nc.ncDeleteShare).mock.calls.every((c) => c[0] === SERVICE_NC_TOKEN)).toBe(true);
      const byId = (id: string) => prisma._shareRows.find((r: any) => r.id === id);
      expect(byId("s-u-alice-a").revokedAt).toBeInstanceOf(Date);
      expect(byId("s-u-alice-b").revokedAt).toBeInstanceOf(Date);
      expect(byId("s-own-a").revokedAt).toBeNull();
      expect(byId("s-bystander").revokedAt).toBeNull();
    });

    it("a share that is already gone upstream counts as revoked; one that fails is listed for an admin", async () => {
      (nc.ncDeleteShare as any).mockImplementation(async (_t: string, id: number) => {
        if (id === 100) throw new Error("OCS share delete failed: 404");
        if (id === 101) throw new Error("OCS share delete failed: 500");
      });
      const prisma = createPrismaMock([due()]);
      expect(await purgeDueDeletions(prisma)).toEqual({ completed: 1, failed: 0 });
      const byId = (id: string) => prisma._shareRows.find((r: any) => r.id === id);
      expect(byId("s-u-alice-a").revokedAt).toBeInstanceOf(Date);
      expect(byId("s-u-alice-b").revokedAt).toBeNull();
      const removedRow = vi
        .mocked(recordActivity)
        .mock.calls.map((c) => c[0] as any)
        .find((r) => r.what === "User removed");
      expect(removedRow.refs.purged).toMatchObject({
        departmentSharesRevoked: 1,
        departmentSharesNeedingReview: [101],
      });
    });

    it("records the counts, and only counts, on the 'User removed' row", async () => {
      await purgeDueDeletions(createPrismaMock([due()]));
      const removedRow = vi
        .mocked(recordActivity)
        .mock.calls.map((c) => c[0] as any)
        .find((r) => r.what === "User removed");
      expect(removedRow.refs.purged).toEqual({
        emailAccounts: 1,
        fileChunks: 1,
        fileIndexRows: 1,
        departmentSharesRevoked: 2,
      });
    });

    it("brain memory is purged by the local User.id, never the username", async () => {
      await purgeDueDeletions(createPrismaMock([{ ...due(), id: "11111111-aaaa-4aaa-8aaa-111111111111" }]));
      expect(purgeUserDataMock).toHaveBeenCalledTimes(1);
      expect(purgeUserDataMock.mock.calls[0][1]).toBe("11111111-aaaa-4aaa-8aaa-111111111111");
    });
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

  it("WARP-3160: scheduling revokes the person's overlay devices once, as the admin, reason removal", async () => {
    const prisma = createPrismaMock([seededAlice(), OWNER_ROW]);
    expect((await del(buildApp(prisma), "alice")).status).toBe(200);
    // Once: the disable step is told not to sweep them again as `deactivation`.
    expect(revokeOverlayDevicesMock).toHaveBeenCalledTimes(1);
    expect(revokeOverlayDevicesMock).toHaveBeenCalledWith("alice", { type: "user", id: "owner-id" }, "removal");
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "User deletion scheduled",
        refs: expect.objectContaining({ vpnDevicesRevoked: 1, vpnDevicesFailed: 0 }),
      }),
    );
  });

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

    // WARP-3176: the claim records when, what it replaced, and to whom.
    expect(prisma._users.find((u: any) => u.id === "u-alice")).toMatchObject({
      deletionClaimedAt: expect.any(Date),
      handoverPriorStatus: "NONE",
      handoverRecipientId: "u-bob",
    });

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
    expect(prisma._users.find((u: any) => u.id === "u-alice")).toMatchObject({
      deletionStatus: "PENDING",
      deletionClaimedAt: null,
      handoverPriorStatus: null,
      handoverRecipientId: null,
    });
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

describe("releaseStaleHandovers — WARP-3176 crash recovery", () => {
  const MIN = 60 * 1000;
  const BOB = {
    id: "u-bob",
    username: "bob",
    nextcloudUsername: "bob",
    role: "family",
    directoryStatus: "ACTIVE",
    deletionStatus: "NONE",
  };
  const claimed = (ageMs: number, prior = "NONE") => ({
    ...seededAlice(),
    deletionStatus: "HANDING_OVER",
    deletionClaimedAt: new Date(Date.now() - ageMs),
    handoverPriorStatus: prior,
    handoverRecipientId: "u-bob",
    ...(prior === "PENDING"
      ? { directoryStatus: "DEACTIVATED", deletionDueAt: new Date(Date.now() + 5 * DAY) }
      : {}),
  });
  const alice = (prisma: any) => prisma._users.find((u: any) => u.id === "u-alice");

  it("releases a claim older than the transfer timeout plus margin and audits it as interrupted", async () => {
    const prisma = createPrismaMock([claimed(HANDOVER_STALE_MS + MIN), BOB]);
    expect(await releaseStaleHandovers(prisma)).toEqual({ released: 1, failed: 0 });
    expect(alice(prisma)).toMatchObject({
      deletionStatus: "NONE",
      deletionClaimedAt: null,
      handoverPriorStatus: null,
      handoverRecipientId: null,
    });
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "File hand-over interrupted, may be partial",
        sub: expect.stringContaining("alice → bob"),
        refs: expect.objectContaining({
          targetUsername: "alice",
          recipientUsername: "bob",
          mayBePartial: true,
        }),
        actor: { type: "system" },
      }),
    );
    // Nothing is deleted or transferred by the release.
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
  });

  it("leaves a live claim (inside the window) alone — occ may still be running on the host", async () => {
    const live = HANDOVER_STALE_MS - MIN;
    // 660 s is the transfer's own exec timeout; the window must exceed it.
    expect(HANDOVER_STALE_MS).toBeGreaterThan(660_000);
    const prisma = createPrismaMock([claimed(live), BOB]);
    expect(await releaseStaleHandovers(prisma)).toEqual({ released: 0, failed: 0 });
    expect(alice(prisma).deletionStatus).toBe("HANDING_OVER");
    expect(vi.mocked(recordActivity)).not.toHaveBeenCalled();
  });

  it("restores PENDING for a person already on retention, so the scheduled delete is not lost", async () => {
    const prisma = createPrismaMock([claimed(HANDOVER_STALE_MS + MIN, "PENDING"), BOB]);
    await releaseStaleHandovers(prisma);
    expect(alice(prisma)).toMatchObject({ deletionStatus: "PENDING", directoryStatus: "DEACTIVATED" });
  });

  it("never releases a claim re-taken between the read and the release", async () => {
    const prisma = createPrismaMock([claimed(HANDOVER_STALE_MS + MIN), BOB]);
    const realFindMany = prisma.user.findMany;
    prisma.user.findMany = vi.fn(async (args: any) => {
      const rows = (await realFindMany(args)).map((r: any) => ({ ...r }));
      // A fresh hand-over claims the row after the sweep read it.
      alice(prisma).deletionClaimedAt = new Date();
      return rows;
    });
    expect(await releaseStaleHandovers(prisma)).toEqual({ released: 0, failed: 0 });
    expect(alice(prisma).deletionStatus).toBe("HANDING_OVER");
  });

  it("a released claim unblocks the next hand-over", async () => {
    hostExecMock.mockReset();
    hostExecMock.mockResolvedValue({ stdout: "Transferring files to bob/files/x ...\n", stderr: "" });
    const prisma = createPrismaMock([OWNER_ROW, claimed(HANDOVER_STALE_MS + MIN), BOB]);
    const app = buildApp(prisma, "owner");
    const blocked = await request(app)
      .delete("/api/auth/users/alice")
      .send({ disposition: "handover", recipientId: "u-bob" });
    expect(blocked.status).toBe(409);
    await releaseStaleHandovers(prisma);
    const res = await request(app)
      .delete("/api/auth/users/alice")
      .send({ disposition: "handover", recipientId: "u-bob" });
    expect(res.status).toBe(200);
  });
});

describe("hand-over claim token — WARP-3176", () => {
  const BOB = {
    id: "u-bob",
    username: "bob",
    nextcloudUsername: "bob",
    role: "family",
    directoryStatus: "ACTIVE",
    deletionStatus: "NONE",
  };

  it("a request whose claim was released and re-taken never releases or revokes the newer claim", async () => {
    let finish: (v: any) => void = () => undefined;
    hostExecMock.mockReset();
    hostExecMock.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const prisma = createPrismaMock([OWNER_ROW, seededAlice(), BOB]);
    const app = buildApp(prisma, "owner");
    const first = request(app)
      .delete("/api/auth/users/alice")
      .send({ disposition: "handover", recipientId: "u-bob" })
      .then((r) => r);
    await vi.waitFor(() => expect(hostExecMock).toHaveBeenCalledTimes(1));

    // The sweep released the first claim, and a second request re-claimed.
    const alice = prisma._users.find((u: any) => u.id === "u-alice");
    const newer = new Date(alice.deletionClaimedAt.getTime() + 1000);
    Object.assign(alice, { deletionStatus: "HANDING_OVER", deletionClaimedAt: newer });

    // The first request's transfer now finishes: its revoke misses (409-ish
    // refusal) and its release misses too, so the newer claim stands.
    finish({ stdout: "Transferring files to bob/files/x ...\n", stderr: "" });
    const res = await first;
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(prisma._users.find((u: any) => u.id === "u-alice")).toMatchObject({
      deletionStatus: "HANDING_OVER",
      deletionClaimedAt: newer,
      directoryStatus: "ACTIVE",
    });
    expect(nc.ncDeleteUser).not.toHaveBeenCalled();
  });
});
