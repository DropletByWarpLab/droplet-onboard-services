/**
 * WARP-1527 / ADR-032 §5 (RBAC v2 T3) — the people-surface access routes:
 *
 *   PATCH /api/people/:id/access            — { accessRoleId } | { accessRoleId: null, tier }
 *   GET   /api/people/:id/effective-access  — the §3 resolver output
 *   PUT   /api/people/:id/access-exceptions — replace the (small) exception set
 *
 * Contract-pins the T8 dashboard shapes (setPersonAccess /
 * fetchEffectiveAccess / putAccessExceptions in api.ts) and the T2 guard
 * rails on both assignment paths. Harness mirrors people-invite.route.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

const {
  recordActivityMock,
  revokeAllSessionsMock,
  resolveEffectiveAccessMock,
} = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
  revokeAllSessionsMock: vi.fn().mockResolvedValue(0),
  resolveEffectiveAccessMock: vi.fn(),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));
vi.mock("../services/session.service.js", () => ({
  revokeAllSessions: revokeAllSessionsMock,
}));
vi.mock("../services/auth-denylist.service.js", () => ({
  denylistUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic-token"),
  DROPLET_ADMINS_GROUP: "droplet-admins",
}));
vi.mock("../services/nextcloud-groups.client.js", () => ({
  ncAddUserToGroup: vi.fn().mockResolvedValue(undefined),
  ncRemoveUserFromGroup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/effective-access.service.js", () => ({
  resolveEffectiveAccess: resolveEffectiveAccessMock,
}));

import { createPeopleRouter } from "./people.js";
import { SERIALIZABLE_TX } from "../services/role-mutation-guard.service.js";
import { AccessPreconditionError } from "../lib/access-precondition.js";
import {
  createTransactionSeam,
  expectAllTransactionsAt,
} from "../__tests__/helpers/prisma-tx-harness.js";
import type { ScopeName } from "../middleware/scope.js";

interface UserSeed {
  id: string;
  username: string;
  role: string;
  nextcloudUsername?: string | null;
  accessRoleId?: string | null;
}

interface RoleSeed {
  id: string;
  name: string;
  startingPoint: "admin" | "family" | "guest";
  state?: string;
}

interface ExceptionSeed {
  id: string;
  userId: string;
  moduleId: string;
  effect: "allow" | "deny";
  level: string | null;
}

function createPrismaMock(seed: {
  users?: UserSeed[];
  roles?: RoleSeed[];
  exceptions?: ExceptionSeed[];
} = {}) {
  const users = new Map<string, any>();
  const roles = new Map<string, any>();
  let exceptions: any[] = [];
  let nextExceptionId = 1;

  for (const u of seed.users ?? []) {
    users.set(u.id, { nextcloudUsername: null, accessRoleId: null, directoryStatus: "ACTIVE", ...u });
  }
  for (const r of seed.roles ?? []) roles.set(r.id, { state: "active", ...r });
  for (const x of seed.exceptions ?? []) exceptions.push({ createdAt: new Date(), ...x });

  // WARP-1570: the transaction seam is SHARED (__tests__/helpers/
  // prisma-tx-harness.ts), not hand-rolled here. It records the options
  // argument of every call (review T1: the old stub dropped it, so a bare
  // READ COMMITTED transaction shipped green — and RC transactions are
  // invisible to Postgres SSI, defeating the isolation on the serializable
  // paths they race) and snapshots/restores the stores so atomicity is
  // provable. `exceptions` is REASSIGNED by deleteMany, so it registers via
  // the accessor form — a bare reference could not see the rebinding.
  const seam = createTransactionSeam({
    client: () => self,
    stores: {
      users,
      roles,
      exceptions: {
        get: () => exceptions,
        set: (next: unknown) => {
          exceptions = next as any[];
        },
      },
    },
  });

  const self: any = {
    _users: () => users,
    _exceptions: () => exceptions,
    _seam: () => seam,
    $transaction: seam.$transaction,
    user: {
      findUnique: vi.fn(async ({ where: { id } }: any) => {
        const row = users.get(id);
        return row ? { ...row } : null;
      }),
      update: vi.fn(async ({ where: { id }, data }: any) => {
        const row = users.get(id);
        if (!row) throw new Error(`no such user ${id}`);
        Object.assign(row, data);
        return { ...row };
      }),
      count: vi.fn(async ({ where }: any = {}) => {
        return [...users.values()].filter((u) => {
          if (where?.role !== undefined) {
            if (typeof where.role === "string" && u.role !== where.role) return false;
            if (where.role?.in !== undefined && !where.role.in.includes(u.role)) return false;
          }
          if (where?.directoryStatus !== undefined && u.directoryStatus !== where.directoryStatus) return false;
          if (where?.id?.not !== undefined && u.id === where.id.not) return false;
          return true;
        }).length;
      }),
    },
    accessRole: {
      findUnique: vi.fn(async ({ where: { id } }: any) => {
        const row = roles.get(id);
        return row ? { ...row } : null;
      }),
    },
    userAccessException: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        return exceptions
          .filter((x) => where?.userId === undefined || x.userId === where.userId)
          .map((x) => ({ ...x }));
      }),
      deleteMany: vi.fn(async ({ where: { userId } }: any) => {
        const before = exceptions.length;
        exceptions = exceptions.filter((x) => x.userId !== userId);
        return { count: before - exceptions.length };
      }),
      createMany: vi.fn(async ({ data }: any) => {
        for (const row of data) {
          exceptions.push({ id: `x-${nextExceptionId++}`, createdAt: new Date(), ...row });
        }
        return { count: data.length };
      }),
    },
  };
  return self;
}

function buildApp(
  prismaMock: any,
  user: { id: string; username: string; role: string } = {
    id: "actor-1",
    username: "stefan",
    role: "owner",
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { ...user, displayName: user.username };
    next();
  });
  app.use(
    "/api",
    createPeopleRouter(prismaMock, async () => new Set<ScopeName>(["team", "exec_only"])),
  );
  return app;
}

beforeEach(() => {
  recordActivityMock.mockClear();
  revokeAllSessionsMock.mockClear();
  resolveEffectiveAccessMock.mockReset();
});

// ── transaction isolation (review B1/T1) ───────────────────────────

function expectAllSerializable(prisma: any) {
  expectAllTransactionsAt(prisma._seam(), SERIALIZABLE_TX);
}

describe("every mutating people-access route opens its transaction at SERIALIZABLE", () => {
  it("PATCH /people/:id/access", async () => {
    const prisma = createPrismaMock({
      roles: [{ id: "r1", name: "Reception", startingPoint: "family" as const }],
      users: [
        { id: "u1", username: "ana", role: "guest" },
        { id: "owner-1", username: "own", role: "owner" },
      ],
    });
    const res = await request(buildApp(prisma))
      .patch("/api/people/u1/access")
      .send({ accessRoleId: "r1" });
    expect(res.status).toBe(200);
    expectAllSerializable(prisma);
  });

  it("PUT /people/:id/access-exceptions", async () => {
    const prisma = createPrismaMock({
      users: [
        { id: "u1", username: "ana", role: "family" },
        { id: "owner-1", username: "own", role: "owner" },
      ],
    });
    const res = await request(buildApp(prisma))
      .put("/api/people/u1/access-exceptions")
      .send({ exceptions: [{ moduleId: "email", effect: "deny" }] });
    expect(res.status).toBe(200);
    expectAllSerializable(prisma);
  });
});

// ── PATCH /api/people/:id/access ───────────────────────────────────

describe("PATCH /api/people/:id/access", () => {
  const seed = {
    roles: [
      { id: "r1", name: "Reception", startingPoint: "family" as const },
      { id: "r-arch", name: "Old", startingPoint: "family" as const, state: "archived" },
    ],
    users: [
      { id: "u1", username: "ana", role: "guest" },
      { id: "owner-1", username: "own", role: "owner" },
    ],
  };

  it("assigns a custom role: accessRoleId + User.role = startingPoint, revoke, Activity, pending", async () => {
    const prisma = createPrismaMock(seed);
    const res = await request(buildApp(prisma))
      .patch("/api/people/u1/access")
      .send({ accessRoleId: "r1" });
    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe("pending");
    expect(prisma._users().get("u1").accessRoleId).toBe("r1");
    expect(prisma._users().get("u1").role).toBe("family");
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u1");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", what: "Access role assigned" }),
    );
  });

  it("assigns a BUILT-IN tier: { accessRoleId: null, tier } clears the role and re-tiers", async () => {
    const prisma = createPrismaMock({
      ...seed,
      users: [
        { id: "u1", username: "ana", role: "family", accessRoleId: "r1" },
        { id: "owner-1", username: "own", role: "owner" },
      ],
    });
    const res = await request(buildApp(prisma))
      .patch("/api/people/u1/access")
      .send({ accessRoleId: null, tier: "guest" });
    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe("pending");
    expect(prisma._users().get("u1").accessRoleId).toBeNull();
    expect(prisma._users().get("u1").role).toBe("guest");
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u1");
  });

  it("a same-tier role clear still revokes sessions (effective access changed)", async () => {
    const prisma = createPrismaMock({
      ...seed,
      users: [
        { id: "u1", username: "ana", role: "family", accessRoleId: "r1" },
        { id: "owner-1", username: "own", role: "owner" },
      ],
    });
    const res = await request(buildApp(prisma))
      .patch("/api/people/u1/access")
      .send({ accessRoleId: null, tier: "family" });
    expect(res.status).toBe(200);
    expect(prisma._users().get("u1").accessRoleId).toBeNull();
    expect(prisma._users().get("u1").role).toBe("family");
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u1");
  });

  it("400s a null accessRoleId without a tier, both-at-once, and non-assignable tiers", async () => {
    const app = buildApp(createPrismaMock(seed));
    expect((await request(app).patch("/api/people/u1/access").send({ accessRoleId: null })).status).toBe(400);
    expect(
      (await request(app).patch("/api/people/u1/access").send({ accessRoleId: "r1", tier: "guest" })).status,
    ).toBe(400);
    expect(
      (await request(app).patch("/api/people/u1/access").send({ accessRoleId: null, tier: "owner" })).status,
    ).toBe(400);
    expect(
      (await request(app).patch("/api/people/u1/access").send({ accessRoleId: null, tier: "service" })).status,
    ).toBe(400);
  });

  it("404s an unknown role or user; 409s an archived role", async () => {
    const app = buildApp(createPrismaMock(seed));
    expect((await request(app).patch("/api/people/u1/access").send({ accessRoleId: "nope" })).status).toBe(404);
    expect((await request(app).patch("/api/people/ghost/access").send({ accessRoleId: "r1" })).status).toBe(404);
    const archived = await request(app).patch("/api/people/u1/access").send({ accessRoleId: "r-arch" });
    expect(archived.status).toBe(409);
    expect(archived.body.code).toBe("ACCESS_ROLE_ARCHIVED");
  });

  // WARP-1583: BYTE-identical to the bodies routes/access.ts answers on the
  // sibling assign path, because both now come from the one definition. Two
  // surfaces can reach the same row here, and hand-copied refusal copy
  // drifting apart is exactly what WARP-1523 cost.
  it("sources its precondition bodies from the shared definition", async () => {
    const app = buildApp(createPrismaMock(seed));
    const unknownRole = await request(app)
      .patch("/api/people/u1/access")
      .send({ accessRoleId: "nope" });
    expect(unknownRole.body).toEqual(AccessPreconditionError.roleNotFound().toJSON());

    const unknownUser = await request(app)
      .patch("/api/people/ghost/access")
      .send({ accessRoleId: "r1" });
    expect(unknownUser.body).toEqual(AccessPreconditionError.userNotFound().toJSON());

    const archived = await request(app)
      .patch("/api/people/u1/access")
      .send({ accessRoleId: "r-arch" });
    expect(archived.body).toEqual(AccessPreconditionError.roleArchived().toJSON());
  });

  it("runs the T2 rails: self-action 409, owner target 403", async () => {
    const prisma = createPrismaMock({
      ...seed,
      users: [
        { id: "actor-1", username: "stefan", role: "owner" },
        { id: "owner-2", username: "other", role: "owner" },
        { id: "u1", username: "ana", role: "guest" },
      ],
    });
    const app = buildApp(prisma);
    const self = await request(app).patch("/api/people/actor-1/access").send({ accessRoleId: "r1" });
    expect(self.status).toBe(409);
    expect(self.body.code).toBe("SELF_ACTION_NOT_ALLOWED");
    const owner = await request(app).patch("/api/people/owner-2/access").send({ accessRoleId: "r1" });
    expect(owner.status).toBe(403);
    expect(owner.body.code).toBe("OWNER_IMMUTABLE");
  });
});

// ── GET /api/people/:id/effective-access ───────────────────────────

describe("GET /api/people/:id/effective-access", () => {
  it("returns the §3 resolver output verbatim", async () => {
    const sentinel = {
      tier: "family",
      features: [{ moduleId: "chat", level: "act" }],
      toolDomains: ["files"],
      locks: false,
      cloud: false,
      connectors: {},
      usage: {
        storageQuotaBytes: null,
        maxUploadSizeMb: null,
        llmDailyMessageCap: null,
        source: "default",
        sources: {
          storageQuotaBytes: "default",
          maxUploadSizeMb: "default",
          llmDailyMessageCap: "default",
        },
      },
      deptRights: [],
      exceptions: [],
    };
    resolveEffectiveAccessMock.mockResolvedValue(sentinel);
    const res = await request(buildApp(createPrismaMock())).get("/api/people/u1/effective-access");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sentinel);
    expect(resolveEffectiveAccessMock).toHaveBeenCalledWith("u1");
  });

  it("404s when the resolver reports no such user", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(null);
    const res = await request(buildApp(createPrismaMock())).get("/api/people/ghost/effective-access");
    expect(res.status).toBe(404);
  });
});

// ── PUT /api/people/:id/access-exceptions ──────────────────────────

describe("PUT /api/people/:id/access-exceptions", () => {
  const seed = {
    users: [
      { id: "u1", username: "ana", role: "family" },
      { id: "owner-1", username: "own", role: "owner" },
    ],
  };

  it("replaces the set wholesale and returns { exceptions } with ids", async () => {
    const prisma = createPrismaMock({
      ...seed,
      exceptions: [{ id: "x-old", userId: "u1", moduleId: "cameras", effect: "deny", level: null }],
    });
    const res = await request(buildApp(prisma))
      .put("/api/people/u1/access-exceptions")
      .send({
        exceptions: [
          { moduleId: "network", effect: "allow", level: "view" },
          { moduleId: "email", effect: "deny" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.exceptions).toHaveLength(2);
    const byModule = new Map(res.body.exceptions.map((x: any) => [x.moduleId, x]));
    expect(byModule.get("network")).toMatchObject({ effect: "allow", level: "view" });
    expect(byModule.get("email")).toMatchObject({ effect: "deny", level: null });
    for (const x of res.body.exceptions) expect(x.id).toBeTruthy();
    // the old row is gone from the store
    expect(prisma._exceptions().every((x: any) => x.moduleId !== "cameras")).toBe(true);
    // grantedBy carries the actor's local User.id
    expect(prisma._exceptions().every((x: any) => x.grantedBy === "actor-1")).toBe(true);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", what: "Access exception set" }),
    );
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", what: "Access exception removed" }),
    );
  });

  it("an empty list clears every exception and audits the removal only", async () => {
    const prisma = createPrismaMock({
      ...seed,
      exceptions: [{ id: "x-old", userId: "u1", moduleId: "cameras", effect: "deny", level: null }],
    });
    const res = await request(buildApp(prisma))
      .put("/api/people/u1/access-exceptions")
      .send({ exceptions: [] });
    expect(res.status).toBe(200);
    expect(res.body.exceptions).toEqual([]);
    expect(prisma._exceptions()).toHaveLength(0);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", what: "Access exception removed" }),
    );
    expect(recordActivityMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ what: "Access exception set" }),
    );
  });

  it("400s allow-without-level (the carried zod obligation), duplicates, and chat", async () => {
    const app = buildApp(createPrismaMock(seed));
    expect(
      (
        await request(app)
          .put("/api/people/u1/access-exceptions")
          .send({ exceptions: [{ moduleId: "network", effect: "allow" }] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put("/api/people/u1/access-exceptions")
          .send({
            exceptions: [
              { moduleId: "email", effect: "deny" },
              { moduleId: "email", effect: "allow", level: "view" },
            ],
          })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put("/api/people/u1/access-exceptions")
          .send({ exceptions: [{ moduleId: "chat", effect: "deny" }] })
      ).status,
    ).toBe(400);
  });

  it("runs the rails: owner target 403, self 409, unknown user 404", async () => {
    const prisma = createPrismaMock({
      users: [
        { id: "actor-1", username: "stefan", role: "owner" },
        { id: "owner-2", username: "other", role: "owner" },
        { id: "u1", username: "ana", role: "family" },
      ],
    });
    const app = buildApp(prisma);
    const body = { exceptions: [{ moduleId: "email", effect: "deny" }] };
    const owner = await request(app).put("/api/people/owner-2/access-exceptions").send(body);
    expect(owner.status).toBe(403);
    expect(owner.body.code).toBe("OWNER_IMMUTABLE");
    const self = await request(app).put("/api/people/actor-1/access-exceptions").send(body);
    expect(self.status).toBe(409);
    expect(self.body.code).toBe("SELF_ACTION_NOT_ALLOWED");
    expect((await request(app).put("/api/people/ghost/access-exceptions").send(body)).status).toBe(404);
  });

  it("family callers are refused on all three surfaces (owner/admin only)", async () => {
    const app = buildApp(createPrismaMock(seed), { id: "fam-1", username: "fam", role: "family" });
    expect((await request(app).patch("/api/people/u1/access").send({ accessRoleId: "r1" })).status).toBe(403);
    expect((await request(app).get("/api/people/u1/effective-access")).status).toBe(403);
    expect(
      (
        await request(app)
          .put("/api/people/u1/access-exceptions")
          .send({ exceptions: [] })
      ).status,
    ).toBe(403);
  });
});
