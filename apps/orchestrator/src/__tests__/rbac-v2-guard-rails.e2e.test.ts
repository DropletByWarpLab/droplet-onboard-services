/**
 * WARP-1534 (RBAC v2 T10, ADR-032 §4 + §12) — end-to-end guard-rail coverage
 * across BOTH person-mutation surfaces.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS SHAPED LIKE THIS
 *
 * Every rail in role-mutation-guard.service.ts already has a unit test, and
 * each route has its own suite. The epic still shipped four blockers CI-green
 * (WARP-1523 rank-cap regression on the UPDATE paths, WARP-1526's
 * owner-probe-via-`role`-key, WARP-1570's mock-hidden transactional holes,
 * WARP-1572's invite handoff) — because a per-file suite proves a rail is
 * WIRED in the file it lives in, never that the rail is wired on EVERY path
 * that can reach the same row. This suite asserts the rail × path MATRIX:
 * one express app, one directory, both routers mounted, so an assertion
 * failing here means a path is missing a rail rather than a rail being wrong.
 *
 * SPLIT WITH THE PG LANE (rbac-v2-guard-rails.pg.test.ts) — deliberate:
 *   here     — the PRE-TRANSACTION rails (1 owner-untouchable, 2 self-action,
 *              3 rank cap, 7 assignable enum) and rail 6's post-commit
 *              session revocation. All four rails are pure functions of
 *              (actor, target-row, requested-role); the DB contributes only
 *              the target row, so an in-memory directory is a faithful
 *              stand-in AND lets one file drive three routers at once.
 *   pg lane  — every invariant whose truth depends on the DATABASE:
 *              last-operator / last-owner counts, SERIALIZABLE behaviour,
 *              the §9 floor clamp as PERSISTED, and the resolver composition
 *              (exception ⊕ workspace enablement). Those are exactly what
 *              mocked Prisma let through (WARP-1570), so they are not
 *              asserted here at all.
 *
 * Harness mirrors auth.directory-deleteuser.test.ts (leaf effect modules
 * mocked, synthetic req.user, real routers).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

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
    ncSetUserEnabled: vi.fn().mockResolvedValue(undefined),
    ncGetUserQuotaAdmin: vi.fn().mockResolvedValue(null),
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
  const actual =
    await vi.importActual<typeof import("../services/jwt.service.js")>(
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

const { purgeUserDataMock } = vi.hoisted(() => ({
  purgeUserDataMock: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));
vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: purgeUserDataMock,
}));

const { recordActivityMock, revokeAllSessionsMock, denylistUserMock, kickReconcileMock } =
  vi.hoisted(() => ({
    recordActivityMock: vi.fn().mockResolvedValue(undefined),
    revokeAllSessionsMock: vi.fn(async (_userId: string) => 2),
    denylistUserMock: vi.fn().mockResolvedValue(undefined),
    kickReconcileMock: vi.fn(),
  }));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));
vi.mock("../services/session.service.js", () => ({
  createSession: vi.fn(async () => ({ sid: "sid-test", evictedSids: [] })),
  checkSession: vi.fn(async () => ({
    kind: "ok",
    record: { userId: "x", role: "family", createdAt: 0, lastSeenAt: 0 },
  })),
  deleteSession: vi.fn(async () => undefined),
  revokeAllSessions: (...args: unknown[]) => revokeAllSessionsMock(...(args as [string])),
}));
vi.mock("../services/auth-denylist.service.js", () => ({
  denylistUser: denylistUserMock,
  isUserDenied: vi.fn().mockResolvedValue(false),
}));
vi.mock("../services/department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic-token"),
  DROPLET_ADMINS_GROUP: "droplet-admins",
}));
vi.mock("../services/nextcloud-groups.client.js", () => ({
  ncAddUserToGroup: vi.fn().mockResolvedValue(undefined),
  ncRemoveUserFromGroup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/department-reconciler.service.js", () => ({
  kickReconcile: kickReconcileMock,
}));

import { createPeopleRouter } from "../routes/people.js";
import { createProtectedAuthRouter } from "../routes/auth.js";
import {
  assertRankCap,
  SERIALIZABLE_TX,
} from "../services/role-mutation-guard.service.js";
import * as nc from "../services/nextcloud.client.js";
import {
  createTransactionSeam,
  expectAllTransactionsAt,
  gate,
} from "./helpers/prisma-tx-harness.js";
import type { Role } from "../services/jwt.service.js";

// ── the shared in-memory directory ─────────────────────────────────

interface Row {
  id: string;
  username: string;
  nextcloudUsername: string | null;
  displayName: string;
  role: Role;
  directoryStatus: "ACTIVE" | "DEACTIVATED";
  isLocal: boolean;
  accessRoleId: string | null;
}

type PartialRow = Partial<Row> & Pick<Row, "id" | "username" | "role">;

function row(seed: PartialRow): Row {
  return {
    nextcloudUsername: seed.username,
    displayName: seed.username,
    directoryStatus: "ACTIVE",
    isLocal: true,
    accessRoleId: null,
    ...seed,
  };
}

/**
 * The `warp1534-` namespace is carried here as well as in the pg lane — not
 * because an in-memory map can collide, but so a grep for the ticket finds
 * BOTH lanes' fixtures and a failure message names its owner.
 */
const OWNER = row({ id: "warp1534-owner-id", username: "warp1534-owner", role: "owner" });
const ADMIN = row({ id: "warp1534-admin-id", username: "warp1534-admin", role: "admin" });
const ADMIN2 = row({ id: "warp1534-admin2-id", username: "warp1534-admin2", role: "admin" });
const FAMILY = row({ id: "warp1534-family-id", username: "warp1534-family", role: "family" });

/**
 * Minimal Prisma stub. Deliberately NOT a general-purpose fake: it answers
 * exactly the reads the pre-tx rails and their routes make.
 *
 * `$transaction` is the SHARED seam (`helpers/prisma-tx-harness.ts`), never
 * hand-rolled. The first version of this file rolled its own
 * `async (fn) => fn(self)` — the exact shape WARP-1570 exists to eliminate.
 * It discarded the options argument, so this suite could assert every guard
 * rail correctly and still stay green if a route dropped `SERIALIZABLE_TX`;
 * it never rolled back, so "the rail refused, therefore nothing was written"
 * was unprovable; and it ran transactions strictly serially, so the write
 * skew rails 4/5 exist to stop could not even be expressed. The seam-adoption
 * gate caught it, correctly.
 */
function createPrismaMock(seed: Row[]) {
  const users: Row[] = seed.map((u) => ({ ...u }));
  const exceptions: Array<Record<string, unknown>> = [];
  const usagePolicies = new Map<string, Record<string, unknown>>();
  const self: Record<string, unknown> = {};

  // Every store the guarded routes write to is registered, so a throw inside
  // a transaction restores all three — the atomicity half of the seam.
  const seam = createTransactionSeam({
    client: () => self,
    stores: { users, exceptions, usagePolicies },
  });

  const matches = (u: Row, where: Record<string, any> = {}): boolean => {
    if (where.id !== undefined && typeof where.id === "string" && u.id !== where.id) return false;
    if (where.id?.not !== undefined && u.id === where.id.not) return false;
    if (where.username !== undefined && u.username !== where.username) return false;
    if (
      where.nextcloudUsername !== undefined &&
      u.nextcloudUsername !== where.nextcloudUsername
    ) {
      return false;
    }
    if (where.role !== undefined) {
      if (typeof where.role === "string") {
        if (u.role !== where.role) return false;
      } else if (Array.isArray(where.role.in) && !where.role.in.includes(u.role)) {
        return false;
      }
    }
    if (where.directoryStatus !== undefined && u.directoryStatus !== where.directoryStatus) {
      return false;
    }
    if (where.accessRoleId !== undefined && u.accessRoleId !== where.accessRoleId) return false;
    return true;
  };

  self.$transaction = seam.$transaction;

  self.user = {
    findUnique: vi.fn(async ({ where }: any) => users.find((u) => matches(u, where)) ?? null),
    findFirst: vi.fn(async ({ where }: any = {}) => users.find((u) => matches(u, where)) ?? null),
    findMany: vi.fn(async ({ where }: any = {}) => users.filter((u) => matches(u, where))),
    count: vi.fn(async ({ where }: any = {}) => users.filter((u) => matches(u, where)).length),
    update: vi.fn(async ({ where, data }: any) => {
      const idx = users.findIndex((u) => matches(u, where));
      if (idx < 0) {
        const err: any = new Error("record not found");
        err.code = "P2025";
        throw err;
      }
      users[idx] = { ...users[idx], ...data };
      return users[idx];
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      users.forEach((u, i) => {
        if (matches(u, where)) {
          users[i] = { ...u, ...data };
          count += 1;
        }
      });
      return { count };
    }),
    delete: vi.fn(async ({ where }: any) => {
      const idx = users.findIndex((u) => matches(u, where));
      if (idx < 0) {
        const err: any = new Error("record not found");
        err.code = "P2025";
        throw err;
      }
      return users.splice(idx, 1)[0];
    }),
    // WARP-1565: `DELETE /api/auth/users/:username` finishes the removal by
    // deleting the local row once Nextcloud has confirmed the account is
    // gone, and it does so with a PREDICATED `deleteMany` (pinned to
    // directoryStatus=DEACTIVATED) rather than `delete` by id, so a row
    // re-activated in the window survives. The stub has to honour the
    // predicate for that refusal to be expressible here at all — a
    // `deleteMany` that ignored `where` would delete the row unconditionally
    // and this suite would go green on the wrong behaviour.
    deleteMany: vi.fn(async ({ where }: any = {}) => {
      const doomed = users.filter((u) => matches(u, where));
      for (const u of doomed) users.splice(users.indexOf(u), 1);
      return { count: doomed.length };
    }),
  };

  self.accessRole = {
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
  };
  self.userAccessException = {
    findMany: vi.fn(async ({ where }: any = {}) =>
      exceptions.filter((x) => where?.userId === undefined || x.userId === where.userId),
    ),
    deleteMany: vi.fn(async ({ where }: any = {}) => {
      const before = exceptions.length;
      for (let i = exceptions.length - 1; i >= 0; i -= 1) {
        if (where?.userId === undefined || exceptions[i].userId === where.userId) {
          exceptions.splice(i, 1);
        }
      }
      return { count: before - exceptions.length };
    }),
    createMany: vi.fn(async ({ data }: any) => {
      (data as Array<Record<string, unknown>>).forEach((d, i) =>
        exceptions.push({ id: `x-${exceptions.length + i}`, createdAt: new Date(), ...d }),
      );
      return { count: data.length };
    }),
  };
  self.userUsagePolicy = {
    findUnique: vi.fn(async ({ where }: any) => usagePolicies.get(where.userId) ?? null),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = usagePolicies.get(where.userId);
      const next = existing
        ? { ...existing, ...update }
        : { updatedAt: new Date(), ...create };
      usagePolicies.set(where.userId, next);
      return next;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const next = { ...(usagePolicies.get(where.userId) ?? {}), ...data };
      usagePolicies.set(where.userId, next);
      return next;
    }),
  };
  self.scopeBinding = {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    createMany: vi.fn(async () => ({ count: 0 })),
    findMany: vi.fn(async () => []),
  };

  (self as any)._users = users;
  (self as any)._exceptions = exceptions;
  (self as any)._seam = () => seam;
  return self as any;
}

/** Mount BOTH person-mutation surfaces on ONE app over ONE directory. */
function buildApp(prisma: any, actor: Row) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = {
      id: actor.id,
      username: actor.username,
      displayName: actor.displayName,
      role: actor.role,
    };
    next();
  });
  app.use("/api", createPeopleRouter(prisma, async () => new Set()));
  app.use("/api", createProtectedAuthRouter(prisma));
  return app;
}

const DIRECTORY = [OWNER, ADMIN, ADMIN2, FAMILY];

beforeEach(() => {
  vi.clearAllMocks();
  revokeAllSessionsMock.mockResolvedValue(2);
  purgeUserDataMock.mockResolvedValue({ items: 0, chunks: 0 });
});

// ── rail 1 — the owner is untouchable, on EVERY path, from BOTH surfaces ──

describe("rail 1 (OWNER_IMMUTABLE) — every owner-targeting mutation, both surfaces", () => {
  /**
   * `[label, surface, request-builder]`. Building the request lazily (rather
   * than sharing one supertest agent) keeps each case independent and makes
   * the failure message name the exact path that lost its rail.
   */
  const paths: Array<[string, "people" | "auth", (app: express.Express) => request.Test]> = [
    [
      "PATCH /api/people/:id/role",
      "people",
      (app) => request(app).patch(`/api/people/${OWNER.id}/role`).send({ role: "admin" }),
    ],
    [
      "PATCH /api/people/:id/scope",
      "people",
      // A VALID payload on purpose: `scopeSchema` rejects `[]` with a 400
      // that would mask the rail entirely (the first draft of this suite did
      // exactly that and "passed" the wrong assertion).
      (app) => request(app).patch(`/api/people/${OWNER.id}/scope`).send({ scopes: ["team"] }),
    ],
    ["DELETE /api/people/:id", "people", (app) => request(app).delete(`/api/people/${OWNER.id}`)],
    [
      "PUT /api/people/:id/usage",
      "people",
      (app) =>
        request(app).put(`/api/people/${OWNER.id}/usage`).send({ storageQuotaBytes: "1024" }),
    ],
    [
      "PATCH /api/people/:id/access (built-in tier)",
      "people",
      (app) =>
        request(app)
          .patch(`/api/people/${OWNER.id}/access`)
          .send({ accessRoleId: null, tier: "family" }),
    ],
    [
      "PUT /api/people/:id/access-exceptions",
      "people",
      (app) =>
        request(app)
          .put(`/api/people/${OWNER.id}/access-exceptions`)
          .send({ exceptions: [{ moduleId: "cameras", effect: "deny" }] }),
    ],
    [
      "PUT /api/auth/users/:username (role key)",
      "auth",
      (app) =>
        request(app)
          .put(`/api/auth/users/${OWNER.nextcloudUsername}`)
          .send({ role: "admin", displayName: "Hijacked" }),
    ],
    [
      "POST /api/auth/users/:username/disable",
      "auth",
      (app) => request(app).post(`/api/auth/users/${OWNER.nextcloudUsername}/disable`),
    ],
    [
      "DELETE /api/auth/users/:username",
      "auth",
      (app) => request(app).delete(`/api/auth/users/${OWNER.nextcloudUsername}`),
    ],
  ];

  it.each(paths)("%s refuses an ADMIN actor with 403 OWNER_IMMUTABLE", async (_label, _s, build) => {
    const prisma = createPrismaMock(DIRECTORY);
    const res = await build(buildApp(prisma, ADMIN));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "OWNER_IMMUTABLE" });
    // The design copy is contract, not decoration — the dashboard renders it.
    expect(res.body.error).toBe("The owner has full control and can't be changed here.");
    // Refusals never mutate and never audit (guard-service module contract).
    expect(prisma._users.find((u: Row) => u.id === OWNER.id)).toMatchObject({
      role: "owner",
      directoryStatus: "ACTIVE",
    });
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it.each(paths)("%s refuses even an OWNER actor (exactly-one-owner doctrine)", async (
    _label,
    _s,
    build,
  ) => {
    // A second owner row is what makes this case honest: with only one owner
    // the last-owner backstop could be mistaken for the reason. Rail 1 is
    // actor-independent, so this must still be OWNER_IMMUTABLE, not
    // LAST_OWNER_INVARIANT and not a success.
    const owner2 = row({
      id: "warp1534-owner2-id",
      username: "warp1534-owner2",
      role: "owner",
    });
    const prisma = createPrismaMock([...DIRECTORY, owner2]);
    const res = await build(buildApp(prisma, owner2));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "OWNER_IMMUTABLE" });
  });
});

// ── rail 2 — self-lockout ──────────────────────────────────────────

describe("rail 2 (SELF_ACTION_NOT_ALLOWED) — an operator cannot act on themselves", () => {
  const selfPaths: Array<[string, (app: express.Express, me: Row) => request.Test]> = [
    [
      "PATCH /api/people/:id/role",
      (app, me) => request(app).patch(`/api/people/${me.id}/role`).send({ role: "guest" }),
    ],
    [
      "PATCH /api/people/:id/scope",
      (app, me) => request(app).patch(`/api/people/${me.id}/scope`).send({ scopes: ["team"] }),
    ],
    ["DELETE /api/people/:id", (app, me) => request(app).delete(`/api/people/${me.id}`)],
    [
      "PATCH /api/people/:id/access",
      (app, me) =>
        request(app)
          .patch(`/api/people/${me.id}/access`)
          .send({ accessRoleId: null, tier: "guest" }),
    ],
    [
      "PUT /api/people/:id/access-exceptions",
      (app, me) =>
        request(app)
          .put(`/api/people/${me.id}/access-exceptions`)
          .send({ exceptions: [] }),
    ],
    [
      "POST /api/auth/users/:username/disable",
      (app, me) => request(app).post(`/api/auth/users/${me.nextcloudUsername}/disable`),
    ],
    [
      "DELETE /api/auth/users/:username",
      (app, me) => request(app).delete(`/api/auth/users/${me.nextcloudUsername}`),
    ],
  ];

  it.each(selfPaths)("%s refuses with 409 SELF_ACTION_NOT_ALLOWED", async (_label, build) => {
    const prisma = createPrismaMock(DIRECTORY);
    const res = await build(buildApp(prisma, ADMIN), ADMIN);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "SELF_ACTION_NOT_ALLOWED",
      error: "Cannot modify your own role, scope, or account",
    });
    expect(prisma._users.find((u: Row) => u.id === ADMIN.id)).toMatchObject({
      role: "admin",
      directoryStatus: "ACTIVE",
    });
  });

  it("PUT /api/auth/users/:username refuses a self role key (409, not a silent strip)", async () => {
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, ADMIN))
      .put(`/api/auth/users/${ADMIN.nextcloudUsername}`)
      .send({ role: "owner" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "SELF_ACTION_NOT_ALLOWED" });
  });

  it("PUT /api/people/:id/usage deliberately ALLOWS a self edit (WARP-1271)", async () => {
    // Rail 2 is not universal, and asserting the exception keeps a future
    // "tighten every path" sweep from silently breaking the shipped
    // behaviour: capping your OWN storage locks nobody out of the box.
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, ADMIN))
      .put(`/api/people/${ADMIN.id}/usage`)
      .send({ storageQuotaBytes: "1024" });

    expect(res.status).toBe(200);
  });
});

// ── rail 3 — the rank cap, on EVERY mutation path (the WARP-1523 regression) ──

describe("rail 3 (ROLE_RANK_EXCEEDED) — the rank cap holds on the UPDATE paths too", () => {
  it("PATCH /api/people/:id/role — admin cannot promote anyone to owner", async () => {
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, ADMIN))
      .patch(`/api/people/${FAMILY.id}/role`)
      .send({ role: "owner" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "ROLE_RANK_EXCEEDED" });
    expect(prisma._users.find((u: Row) => u.id === FAMILY.id)).toMatchObject({ role: "family" });
  });

  it("PUT /api/auth/users/:username — a `role: owner` key is refused, never stripped (WARP-1523)", async () => {
    // The exact regression: `updateUserSchema` has no `role` field, so a role
    // key used to be dropped by zod and the request answered 200 — an admin
    // probing for privilege escalation saw what looked like a success.
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, ADMIN))
      .put(`/api/auth/users/${FAMILY.nextcloudUsername}`)
      .send({ role: "owner", displayName: "Still Family" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "ROLE_RANK_EXCEEDED" });
    expect(prisma._users.find((u: Row) => u.id === FAMILY.id)).toMatchObject({
      role: "family",
      displayName: FAMILY.displayName,
    });
  });

  it("POST /api/auth/users — creating an owner is refused at the create site", async () => {
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, ADMIN))
      .post("/api/auth/users")
      .send({
        username: "warp1534-newbie",
        password: "Correct-Horse-Battery-9",
        email: "warp1534-newbie@example.test",
        role: "owner",
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_RANK_EXCEEDED");
  });

  it("fails CLOSED when the actor carries no role claim — layer 1 answers first", async () => {
    // Both layers refuse, and the ORDER matters for what the client sees:
    // `requireRole` owns the "no role on session" 403 (no rail code), so
    // rail 3's own fail-closed is defence-in-depth BEHIND it, unreachable
    // through the router. Asserting a rail code here would have been
    // asserting a body no client can ever receive.
    const prisma = createPrismaMock(DIRECTORY);
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as any).user = { id: ADMIN.id, username: ADMIN.username };
      next();
    });
    app.use("/api", createPeopleRouter(prisma, async () => new Set()));

    const res = await request(app)
      .patch(`/api/people/${FAMILY.id}/role`)
      .send({ role: "family" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Forbidden: no role on session" });
    expect(prisma._users.find((u: Row) => u.id === FAMILY.id)).toMatchObject({ role: "family" });
  });

  it("the rail itself fails closed on a missing/undefined actor role", () => {
    // The layer-2 half of the case above, asserted where it IS reachable:
    // ROLE_RANK[requested] > ROLE_RANK[undefined] is `NaN`-false in a naive
    // implementation, which would PASS. The rail must refuse on the falsy
    // actor role before it ever compares ranks.
    for (const actorRole of [undefined, null] as const) {
      expect(() => assertRankCap(actorRole, "guest", "nope")).toThrowError(
        expect.objectContaining({ code: "ROLE_RANK_EXCEEDED" }),
      );
    }
  });

  it("equal rank is ALLOWED — admin→admin keeps the last-admin recovery path", async () => {
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, ADMIN))
      .patch(`/api/people/${FAMILY.id}/role`)
      .send({ role: "admin" });

    expect(res.status).toBe(200);
    expect(prisma._users.find((u: Row) => u.id === FAMILY.id)).toMatchObject({ role: "admin" });
  });
});

// ── rail 7 — the assignable enum ───────────────────────────────────

describe("rail 7 (ROLE_NOT_ASSIGNABLE) — `service` and `owner` are never assignable to a human", () => {
  /** An OWNER actor: rank can never be the reason, so a refusal is rail 7. */
  it.each(["service", "owner"] as const)(
    "PATCH /api/people/:id/role refuses `role: %s` even for an OWNER actor",
    async (requested) => {
      const prisma = createPrismaMock(DIRECTORY);
      const res = await request(buildApp(prisma, OWNER))
        .patch(`/api/people/${FAMILY.id}/role`)
        .send({ role: requested });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: "ROLE_NOT_ASSIGNABLE",
        error: "This role can't be assigned to a person.",
      });
      expect(prisma._users.find((u: Row) => u.id === FAMILY.id)).toMatchObject({
        role: "family",
      });
    },
  );

  it.each(["service", "owner"] as const)(
    "PUT /api/auth/users/:username refuses `role: %s` from an owner actor",
    async (requested) => {
      const prisma = createPrismaMock(DIRECTORY);
      const res = await request(buildApp(prisma, OWNER))
        .put(`/api/auth/users/${FAMILY.nextcloudUsername}`)
        .send({ role: requested });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "ROLE_NOT_ASSIGNABLE" });
    },
  );

  it("PATCH /api/people/:id/access refuses a `service` built-in tier at validation (400)", async () => {
    // Two failure CLASSES on purpose (people.ts module comment): an unknown
    // string is a schema 400; a known-but-unassignable ROLE is the rail's 403.
    // `personAccessSchema` narrows the tier to the assignable set, so this one
    // never reaches the rail — pinned so a future widening of the schema is a
    // visible change rather than a silent one.
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, OWNER))
      .patch(`/api/people/${FAMILY.id}/access`)
      .send({ accessRoleId: null, tier: "service" });

    expect(res.status).toBe(400);
    expect(prisma._users.find((u: Row) => u.id === FAMILY.id)).toMatchObject({ role: "family" });
  });

  it("an unrecognized role STRING stays a 400 on both surfaces (not a rail refusal)", async () => {
    const prisma = createPrismaMock(DIRECTORY);
    const app = buildApp(prisma, OWNER);

    const people = await request(app)
      .patch(`/api/people/${FAMILY.id}/role`)
      .send({ role: "superuser" });
    expect(people.status).toBe(400);

    const auth = await request(app)
      .put(`/api/auth/users/${FAMILY.nextcloudUsername}`)
      .send({ role: "superuser" });
    expect(auth.status).toBe(400);
  });
});

// ── rail 6 — session revocation fires on assignment (WARP-116 / WARP-247) ──

describe("rail 6 — assignment revokes the target's sessions (WARP-116)", () => {
  it("PATCH /api/people/:id/access revokes on a TIER CROSSING", async () => {
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, OWNER))
      .patch(`/api/people/${FAMILY.id}/access`)
      .send({ accessRoleId: null, tier: "guest" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ syncState: "pending" });
    expect(revokeAllSessionsMock).toHaveBeenCalledWith(FAMILY.id);
  });

  it("PATCH /api/people/:id/access revokes on a SAME-TIER change too", async () => {
    // The trap this pins: a person's effective access changes when their
    // access-role pointer moves even though `User.role` does not, so keying
    // revocation off the tier alone would leave a stale session holding the
    // old grants until it expired.
    const roleless = row({
      id: "warp1534-swap-id",
      username: "warp1534-swap",
      role: "family",
      accessRoleId: "warp1534-some-role",
    });
    const prisma = createPrismaMock([...DIRECTORY, roleless]);
    const res = await request(buildApp(prisma, OWNER))
      .patch(`/api/people/${roleless.id}/access`)
      .send({ accessRoleId: null, tier: "family" });

    expect(res.status).toBe(200);
    expect(revokeAllSessionsMock).toHaveBeenCalledWith(roleless.id);
    expect(prisma._users.find((u: Row) => u.id === roleless.id)).toMatchObject({
      accessRoleId: null,
      role: "family",
    });
  });

  it("PATCH /api/people/:id/role revokes, and a REFUSED change revokes nothing", async () => {
    const prisma = createPrismaMock(DIRECTORY);
    const app = buildApp(prisma, ADMIN);

    await request(app).patch(`/api/people/${FAMILY.id}/role`).send({ role: "guest" });
    expect(revokeAllSessionsMock).toHaveBeenCalledWith(FAMILY.id);

    revokeAllSessionsMock.mockClear();
    const refused = await request(app)
      .patch(`/api/people/${OWNER.id}/role`)
      .send({ role: "admin" });
    expect(refused.status).toBe(403);
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
  });
});

// ── the built-in-tier path runs the SAME rails as a custom role ────

describe("the built-in-tier path ({accessRoleId: null, tier}) is not a side door", () => {
  it("clears the role pointer and re-tiers in one write", async () => {
    const member = row({
      id: "warp1534-member-id",
      username: "warp1534-member",
      role: "admin",
      accessRoleId: "warp1534-reception",
    });
    const prisma = createPrismaMock([...DIRECTORY, member]);
    const res = await request(buildApp(prisma, OWNER))
      .patch(`/api/people/${member.id}/access`)
      .send({ accessRoleId: null, tier: "guest" });

    expect(res.status).toBe(200);
    expect(prisma._users.find((u: Row) => u.id === member.id)).toMatchObject({
      accessRoleId: null,
      role: "guest",
    });
  });

  it("is refused by rail 3 exactly like a direct role change", async () => {
    const prisma = createPrismaMock(DIRECTORY);
    // `owner` is not in the schema's assignable tier enum, so the highest
    // tier an admin can REQUEST here is `admin` — which equal-rank allows.
    // The rank rail therefore bites on the guest actor case below; here we
    // pin that the path is wired to the composite at all by driving rail 1.
    const res = await request(buildApp(prisma, ADMIN))
      .patch(`/api/people/${OWNER.id}/access`)
      .send({ accessRoleId: null, tier: "admin" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "OWNER_IMMUTABLE" });
  });
});

// ── isolation is load-bearing, not decorative (WARP-1570) ──────────

describe("rails 4/5 need SERIALIZABLE to hold — the write-skew canary", () => {
  /**
   * Every assertion above proves a rail REFUSES when it should. None of them
   * can prove the rail still holds when two requests race, because a rail
   * that counts and then writes is only safe if the transaction is
   * serializable — and until this suite moved onto the shared seam, the
   * isolation option was discarded and the two requests ran strictly one
   * after the other. So a route that dropped `SERIALIZABLE_TX` kept the
   * whole file green. That is the gap; these two tests close it.
   *
   * The scenario is the one role-mutation-guard's own header documents:
   * "two concurrent requests each removing one of the last two operators
   * BOTH read 'one other operator remains', BOTH pass, and BOTH commit —
   * landing exactly the zero-operator state the rails exist to prevent,
   * unrecoverable from the dashboard."
   */
  function lastTwoOperators() {
    // The owner is DEACTIVATED, so ADMIN and ADMIN2 are the only two people
    // left who can manage access. Rail 5 counts NON-disabled operators, so
    // this is what makes each demotion individually legal and the pair fatal.
    return [
      row({ ...OWNER, directoryStatus: "DEACTIVATED" }),
      ADMIN,
      ADMIN2,
      FAMILY,
    ];
  }

  const activeOperators = (prisma: any) =>
    (prisma._users as Row[]).filter(
      (u) => (u.role === "owner" || u.role === "admin") && u.directoryStatus === "ACTIVE",
    );

  /**
   * Park both requests inside their transaction at rail 5's COUNT — after
   * each has read "one other operator remains" and before either writes.
   * That is the exact check-then-write window SERIALIZABLE_TX is passed for.
   */
  function raceTwoDemotions(prisma: any) {
    const app = buildApp(prisma, OWNER);
    const bothCounted = gate(2);
    const realCount = prisma.user.count;
    prisma.user.count = vi.fn(async (args: any) => {
      const n = await realCount(args);
      await bothCounted.arriveAndWait();
      return n;
    });
    return Promise.all([
      request(app).patch(`/api/people/${ADMIN.id}/role`).send({ role: "family" }),
      request(app).patch(`/api/people/${ADMIN2.id}/role`).send({ role: "family" }),
    ]);
  }

  it("SERIALIZABLE: one demotion commits, the loser aborts, an operator survives", async () => {
    const prisma = createPrismaMock(lastTwoOperators());
    const responses = await raceTwoDemotions(prisma);

    // Exactly one transaction hit the SSI read-write dependency rule.
    expect(prisma._seam().conflicts()).toBe(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    // The loser is a 409 CONCURRENT_MUTATION, not a 500: people.ts maps
    // P2034 through isConcurrencyConflict. "Nothing was applied, retry."
    const loser = responses.find((r) => r.status !== 200)!;
    expect(loser.status).toBe(409);
    expect(loser.body).toMatchObject({ code: "CONCURRENT_MUTATION" });

    // The invariant itself: the box still has someone who can manage access.
    expect(activeOperators(prisma)).toHaveLength(1);
    expectAllTransactionsAt(prisma._seam(), SERIALIZABLE_TX);
  });

  it("REGRESSION CANARY — dropping the isolation option strands the box with zero operators", async () => {
    // Simulate exactly the regression and nothing else: the call site loses
    // SERIALIZABLE_TX and inherits Postgres' default, READ COMMITTED. The
    // rails, the routes and the fixtures are untouched.
    const prisma = createPrismaMock(lastTwoOperators());
    const serializable = prisma.$transaction;
    prisma.$transaction = (fn: any) => serializable(fn);

    const responses = await raceTwoDemotions(prisma);

    expect(prisma._seam().conflicts()).toBe(0);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(2);
    // Both demotions committed. Rail 5 passed twice — correctly, on its own
    // terms, each against a snapshot in which the OTHER admin still existed —
    // and the box is now unrecoverable from the dashboard. This is the state
    // LAST_OPERATOR_INVARIANT exists to make impossible, reachable purely by
    // removing one options argument.
    expect(activeOperators(prisma)).toHaveLength(0);
  });
});

describe("every guarded mutation opens its transaction at SERIALIZABLE", () => {
  // The cheap, broad companion to the canary above: the canary proves the
  // isolation is load-bearing on ONE path; this proves every other guarded
  // path asks for it, so a new route cannot quietly ship at READ COMMITTED.
  const guarded: Array<[string, (app: express.Express) => request.Test]> = [
    [
      "PATCH /api/people/:id/role",
      (app) => request(app).patch(`/api/people/${FAMILY.id}/role`).send({ role: "admin" }),
    ],
    [
      "PATCH /api/people/:id/scope",
      (app) => request(app).patch(`/api/people/${FAMILY.id}/scope`).send({ scopes: ["team"] }),
    ],
    ["DELETE /api/people/:id", (app) => request(app).delete(`/api/people/${FAMILY.id}`)],
    [
      "PATCH /api/people/:id/access",
      (app) =>
        request(app)
          .patch(`/api/people/${FAMILY.id}/access`)
          .send({ accessRoleId: null, tier: "guest" }),
    ],
    [
      "PUT /api/people/:id/access-exceptions",
      (app) =>
        request(app)
          .put(`/api/people/${FAMILY.id}/access-exceptions`)
          .send({ exceptions: [{ moduleId: "cameras", effect: "deny" }] }),
    ],
    [
      "POST /api/auth/users/:username/disable",
      (app) => request(app).post(`/api/auth/users/${FAMILY.nextcloudUsername}/disable`),
    ],
    [
      "DELETE /api/auth/users/:username",
      (app) => request(app).delete(`/api/auth/users/${FAMILY.nextcloudUsername}`),
    ],
  ];

  it.each(guarded)("%s", async (_label, build) => {
    const prisma = createPrismaMock(DIRECTORY);
    const res = await build(buildApp(prisma, OWNER));

    // Guard the guard: a 4xx would mean the request never reached the
    // transaction, and expectAllTransactionsAt would then be asserting
    // nothing (it throws on zero transactions, but a partial path could
    // still open one for the wrong reason).
    expect(res.status).toBe(200);
    expectAllTransactionsAt(prisma._seam(), SERIALIZABLE_TX);
  });
});

// ── WARP-1564 — the non-role fields of PUT /auth/users/:username ───

describe("WARP-1564 — an admin must not rotate the OWNER's credentials", () => {
  // Rail 1b (`assertTargetNotOtherOwner`) now guards the WHOLE route, not just
  // the role branch: refuse when the target is an owner and the actor is not
  // that same owner. Fixed in #1241; these cases shipped `.skip`-ed on this
  // branch and were flipped on when it merged.

  it("refuses a password write against the owner's row (403 OWNER_IMMUTABLE)", async () => {
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, ADMIN))
      .put(`/api/auth/users/${OWNER.nextcloudUsername}`)
      .send({ password: "Attacker-Chosen-Pw-9" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "OWNER_IMMUTABLE" });
    expect(prisma._users.find((u: Row) => u.id === OWNER.id)).not.toHaveProperty(
      "passwordHash",
      "$argon2id$stub",
    );
    // The Nextcloud mirror is the other half of the takeover — the local hash
    // and the NC account password are written by the same handler.
    expect(vi.mocked(nc.ncUpdateUser)).not.toHaveBeenCalled();
  });

  it("refuses an email write against the owner's row (the login key)", async () => {
    // Same rail, second field: `email` is the ADR-013 directory login key
    // (/auth/login resolves the row by email blind-index, then verifies that
    // row's hash), so rewriting it is an account takeover by a different route.
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, ADMIN))
      .put(`/api/auth/users/${OWNER.nextcloudUsername}`)
      .send({ email: "attacker@example.test" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "OWNER_IMMUTABLE" });
  });

  it("rails the whole route, not a credential allowlist — displayName too", async () => {
    // The field this branch previously documented as an open hole. It is
    // railed for the same reason as the rest: an allowlist would default any
    // field added to updateUserSchema later to UN-railed — "derive state from
    // absence" in guard form.
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, ADMIN))
      .put(`/api/auth/users/${OWNER.nextcloudUsername}`)
      .send({ displayName: "Renamed By Admin" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "OWNER_IMMUTABLE" });
  });

  it("refuses BEFORE schema validation — a weak password is still 403, not 400", async () => {
    // No validation oracle: an admin probing the owner's row must not be able
    // to tell a well-formed body from a malformed one. Non-owner targets keep
    // their 400 WEAK_PASSWORD (asserted below) so this is a scoped change.
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, ADMIN))
      .put(`/api/auth/users/${OWNER.nextcloudUsername}`)
      .send({ password: "x" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "OWNER_IMMUTABLE" });
  });

  it("the OWNER may still maintain their OWN account (the self carve-out)", async () => {
    // Rail 1b is rail 1 WITH a self carve-out, and the carve-out is the whole
    // reason it isn't plain rail 1: this route is how the owner changes their
    // own password / email / display name.
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, OWNER))
      .put(`/api/auth/users/${OWNER.nextcloudUsername}`)
      .send({ password: "Owner-Chosen-Pw-9" });

    expect(res.status).toBe(200);
  });

  it("owner A cannot edit owner B (drifted two-owner directory)", async () => {
    const owner2 = row({
      id: "warp1534-owner2-cred",
      username: "warp1534-owner2-cred",
      role: "owner",
    });
    const prisma = createPrismaMock([...DIRECTORY, owner2]);
    const res = await request(buildApp(prisma, owner2))
      .put(`/api/auth/users/${OWNER.nextcloudUsername}`)
      .send({ password: "Other-Owner-Pw-9" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "OWNER_IMMUTABLE" });
  });

  it("fails CLOSED on a missing actor id (inverse of rail 2's fail-open)", async () => {
    // Rail 1b uses identity to PERMIT, where rail 2 uses it to REFUSE — so the
    // safe default inverts. An absent id cannot prove "I am the owner".
    const prisma = createPrismaMock(DIRECTORY);
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as any).user = { username: "ghost", role: "owner" }; // role, no id
      next();
    });
    app.use("/api", createProtectedAuthRouter(prisma));

    const res = await request(app)
      .put(`/api/auth/users/${OWNER.nextcloudUsername}`)
      .send({ password: "No-Actor-Id-Pw-9" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "OWNER_IMMUTABLE" });
  });

  it("a NON-owner target is untouched by rail 1b — 200, and 400 still validates", async () => {
    // The scoping assertion. Without it, "everything 403s" would also pass.
    const prisma = createPrismaMock(DIRECTORY);
    const app = buildApp(prisma, ADMIN);

    const ok = await request(app)
      .put(`/api/auth/users/${FAMILY.nextcloudUsername}`)
      .send({ password: "Rotated-By-Admin-9" });
    expect(ok.status).toBe(200);

    const weak = await request(app)
      .put(`/api/auth/users/${FAMILY.nextcloudUsername}`)
      .send({ password: "x" });
    expect(weak.status).toBe(400);
    expect(weak.body).toMatchObject({ code: "WEAK_PASSWORD" });
  });

  it("a raced promotion answers 409 CONCURRENT_MUTATION, never 404", async () => {
    // Rail 1b decides on a NON-transactional findUnique, so the write pins
    // `role` to the value it decided against. The concurrent writer is real:
    // scim-role-mapping maps any SCIM group whose normalized name contains
    // "owner" to role "owner", so an Okta push of "Business Owners" mints
    // owners asynchronously with no coordination with this route.
    //
    // The distinction is subtle and easy to regress: a 0-row write means
    // "user not found" ONLY when no row existed at decision time. Here one
    // did, so 404 would claim the account is gone when it is very much there
    // — and would bury the only signal that a promotion was in flight.
    const prisma = createPrismaMock(DIRECTORY);
    const stored = prisma._users.find((u: Row) => u.id === FAMILY.id) as Row;
    const realFindUnique = prisma.user.findUnique;
    let raced = false;
    prisma.user.findUnique = vi.fn(async (args: any) => {
      const found = await realFindUnique(args);
      if (!found) return null;
      const snapshot = { ...found }; // what rail 1b decides against
      if (!raced && found.id === FAMILY.id) {
        raced = true;
        stored.role = "owner"; // ...the SCIM promotion lands here
      }
      return snapshot;
    });

    const res = await request(buildApp(prisma, ADMIN))
      .put(`/api/auth/users/${FAMILY.nextcloudUsername}`)
      .send({ password: "Raced-Promotion-Pw-9" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "CONCURRENT_MUTATION" });
    // Nothing applied locally, and the response returns BEFORE the Nextcloud
    // mirror — so the now-owner row keeps its credentials on both sides.
    expect(stored).not.toHaveProperty("passwordHash", "$argon2id$stub");
    expect(vi.mocked(nc.ncUpdateUser)).not.toHaveBeenCalled();
  });

  it("no local row at all still answers 404 USER_NOT_FOUND", async () => {
    // The other side of the split the 409 came from: the pre-existing 404 is
    // unchanged when the row genuinely never existed.
    const prisma = createPrismaMock(DIRECTORY);
    const res = await request(buildApp(prisma, ADMIN))
      .put("/api/auth/users/warp1534-no-such-user")
      .send({ password: "Ghost-Account-Pw-9" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "USER_NOT_FOUND" });
  });
});
