/**
 * WARP-1527 / ADR-032 §5 (RBAC v2 T3) — /api/access/roles CRUD + assign.
 *
 * Contract-pins the T8 dashboard wire shapes (apps/web-dashboard/src/lib/
 * api.ts + types.ts, WARP-1532): { roles } / { role } / { syncState },
 * duplicate via POST { sourceRoleId }, archive via PATCH { state }, delete
 * blocked while in use (members OR pending invites — the carried WARP-1527
 * obligation), BigInts as strings, server-derived slugs, authoritative §9
 * re-clamps, and every mutation through the T2 guard rails + Activity.
 *
 * Harness mirrors people-invite.route.test.ts: real router + real guard
 * service behind a synthetic req.user; in-memory Prisma stub; leaf effect
 * modules (sessions / NC / reconciler / activity) mocked.
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

const { recordActivityMock, revokeAllSessionsMock, kickReconcileMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
  revokeAllSessionsMock: vi.fn().mockResolvedValue(0),
  kickReconcileMock: vi.fn(),
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
vi.mock("../services/department-reconciler.service.js", () => ({
  kickReconcile: kickReconcileMock,
}));

import { createAccessRouter } from "./access.js";
import { SERIALIZABLE_TX } from "../services/role-mutation-guard.service.js";
import {
  createTransactionSeam,
  expectAllTransactionsAt,
  gate,
} from "../__tests__/helpers/prisma-tx-harness.js";

// ── in-memory prisma stub ──────────────────────────────────────────

interface RoleSeed {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  startingPoint: "admin" | "family" | "guest";
  state?: string;
  storageQuotaBytes?: bigint | null;
  maxUploadSizeMb?: number | null;
  llmDailyMessageCap?: number | null;
  cloudModelsAllowed?: boolean;
  mayOperateLocks?: boolean;
  featureGrants?: Array<{ moduleId: string; level: string }>;
  toolGrants?: Array<{ domain: string; level: string }>;
  connectorGrants?: Array<{ provider: string; level: string }>;
}

interface UserSeed {
  id: string;
  username: string;
  displayName?: string;
  role: string;
  nextcloudUsername?: string | null;
  directoryStatus?: string;
  accessRoleId?: string | null;
  usagePolicy?: { storageQuotaBytes: bigint | null } | null;
}

interface InviteSeed {
  id: string;
  email?: string | null;
  username: string;
  accessRoleId: string | null;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
  expiresAt: Date;
}

function createPrismaMock(seed: { roles?: RoleSeed[]; users?: UserSeed[]; invites?: InviteSeed[] } = {}) {
  const roles = new Map<string, any>();
  const users = new Map<string, any>();
  const invites = new Map<string, any>();
  let nextRoleId = 1;

  for (const r of seed.roles ?? []) {
    roles.set(r.id, {
      description: null,
      state: "active",
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      createdBy: "seed",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      updatedAt: new Date("2026-07-01T00:00:00Z"),
      featureGrants: [],
      toolGrants: [],
      connectorGrants: [],
      ...r,
    });
  }
  for (const u of seed.users ?? []) {
    users.set(u.id, {
      displayName: u.username,
      nextcloudUsername: null,
      directoryStatus: "ACTIVE",
      accessRoleId: null,
      usagePolicy: null,
      ...u,
    });
  }
  for (const i of seed.invites ?? []) {
    invites.set(i.id, { email: null, acceptedAt: null, revokedAt: null, ...i });
  }

  const roleWithMeta = (row: any) => ({
    ...row,
    featureGrants: row.featureGrants.map((g: any) => ({ ...g })),
    toolGrants: row.toolGrants.map((g: any) => ({ ...g })),
    connectorGrants: row.connectorGrants.map((g: any) => ({ ...g })),
    _count: { users: [...users.values()].filter((u) => u.accessRoleId === row.id).length },
  });

  // WARP-1570: the transaction seam is SHARED (__tests__/helpers/
  // prisma-tx-harness.ts), not hand-rolled here. It records every call's
  // options argument — the argument the old stub dropped entirely, which is
  // what let bare `prisma.$transaction(fn)` calls ship green (review T1); a
  // READ COMMITTED transaction is invisible to Postgres SSI, so it silently
  // defeats the isolation on the serializable paths it races. It also
  // snapshots/restores the stores so a throw inside the callback ROLLS
  // BACK, like a real interactive transaction: without that no test could
  // prove atomicity, and partial writes survived a refusal unnoticed.
  const seam = createTransactionSeam({
    client: () => self,
    stores: { roles, users, invites },
  });

  const self: any = {
    _roles: () => roles,
    _users: () => users,
    _invites: () => invites,
    _seam: () => seam,
    $transaction: seam.$transaction,
    accessRole: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        let out = [...roles.values()];
        if (where?.slug?.startsWith !== undefined) {
          out = out.filter((r) => r.slug.startsWith(where.slug.startsWith));
        }
        return out.map(roleWithMeta);
      }),
      findUnique: vi.fn(async ({ where: { id } }: any) => {
        const row = roles.get(id);
        return row ? roleWithMeta(row) : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = data.id ?? `role-${nextRoleId++}`;
        const row = {
          description: null,
          state: "active",
          storageQuotaBytes: null,
          maxUploadSizeMb: null,
          llmDailyMessageCap: null,
          cloudModelsAllowed: false,
          mayOperateLocks: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          featureGrants: [],
          toolGrants: [],
          connectorGrants: [],
          ...data,
          id,
        };
        roles.set(id, row);
        return { ...row };
      }),
      update: vi.fn(async ({ where: { id }, data }: any) => {
        const row = roles.get(id);
        if (!row) throw new Error(`no such role ${id}`);
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      }),
      delete: vi.fn(async ({ where: { id } }: any) => {
        // Simulate onDelete Restrict — users + invites block, grants cascade.
        const blocked =
          [...users.values()].some((u) => u.accessRoleId === id) ||
          [...invites.values()].some((i) => i.accessRoleId === id);
        if (blocked) {
          const err: any = new Error("Foreign key constraint failed");
          err.code = "P2003";
          throw err;
        }
        const row = roles.get(id);
        roles.delete(id);
        return row;
      }),
    },
    accessRoleFeatureGrant: {
      deleteMany: vi.fn(async ({ where: { roleId } }: any) => {
        const row = roles.get(roleId);
        if (row) row.featureGrants = [];
        return { count: 0 };
      }),
      createMany: vi.fn(async ({ data }: any) => {
        for (const g of data) roles.get(g.roleId)?.featureGrants.push({ moduleId: g.moduleId, level: g.level });
        return { count: data.length };
      }),
    },
    accessRoleToolGrant: {
      deleteMany: vi.fn(async ({ where: { roleId } }: any) => {
        const row = roles.get(roleId);
        if (row) row.toolGrants = [];
        return { count: 0 };
      }),
      createMany: vi.fn(async ({ data }: any) => {
        for (const g of data) roles.get(g.roleId)?.toolGrants.push({ domain: g.domain, level: g.level });
        return { count: data.length };
      }),
    },
    accessRoleConnectorGrant: {
      deleteMany: vi.fn(async ({ where: { roleId } }: any) => {
        const row = roles.get(roleId);
        if (row) row.connectorGrants = [];
        return { count: 0 };
      }),
      createMany: vi.fn(async ({ data }: any) => {
        for (const g of data) roles.get(g.roleId)?.connectorGrants.push({ provider: g.provider, level: g.level });
        return { count: data.length };
      }),
    },
    user: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        let out = [...users.values()];
        if (where?.accessRoleId !== undefined) out = out.filter((u) => u.accessRoleId === where.accessRoleId);
        if (where?.id?.in !== undefined) out = out.filter((u) => where.id.in.includes(u.id));
        return out.map((u) => ({ ...u }));
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
    userInvite: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        let out = [...invites.values()];
        if (where?.accessRoleId !== undefined) out = out.filter((i) => i.accessRoleId === where.accessRoleId);
        if (where?.acceptedAt === null) out = out.filter((i) => i.acceptedAt === null);
        if (where?.revokedAt === null) out = out.filter((i) => i.revokedAt === null);
        if (where?.expiresAt?.gt !== undefined) out = out.filter((i) => i.expiresAt > where.expiresAt.gt);
        return out.map((i) => ({ ...i }));
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const i of invites.values()) {
          if (where?.accessRoleId !== undefined && i.accessRoleId !== where.accessRoleId) continue;
          if (where?.OR !== undefined) {
            const matches = where.OR.some((cond: any) => {
              if (cond.acceptedAt?.not === null) return i.acceptedAt !== null;
              if (cond.revokedAt?.not === null) return i.revokedAt !== null;
              if (cond.expiresAt?.lte !== undefined) return i.expiresAt <= cond.expiresAt.lte;
              return false;
            });
            if (!matches) continue;
          }
          Object.assign(i, data);
          count += 1;
        }
        return { count };
      }),
    },
  };
  return self;
}

function buildApp(
  prismaMock: any,
  user: { id: string; username: string; role: string } = { id: "actor-1", username: "stefan", role: "owner" },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { ...user, displayName: user.username };
    next();
  });
  app.use("/api", createAccessRouter(prismaMock));
  return app;
}

const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);

/** A well-formed T8 AccessRolePayload for POST /api/access/roles. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Reception",
    description: "Front desk",
    startingPoint: "family",
    storageQuotaBytes: "5000000000",
    maxUploadSizeMb: 100,
    llmDailyMessageCap: null,
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    featureGrants: [
      { moduleId: "files", level: "act" },
      { moduleId: "calendar", level: "view" },
    ],
    toolGrants: [{ domain: "files", level: "use" }],
    connectorGrants: [{ provider: "eaglesoft", level: "read" }],
    ...overrides,
  };
}

beforeEach(() => {
  recordActivityMock.mockClear();
  revokeAllSessionsMock.mockClear();
  kickReconcileMock.mockClear();
});

// ── transaction isolation (review B1/T1) ───────────────────────────

/** Every transaction this request opened ran at SERIALIZABLE. */
function expectAllSerializable(prisma: any) {
  expectAllTransactionsAt(prisma._seam(), SERIALIZABLE_TX);
}

// ── concurrent mutation (WARP-1570) ────────────────────────────────
//
// The assertion above proves the route ASKED for SERIALIZABLE. It cannot
// prove the isolation is load-bearing — with a serial stub the second
// request always sees the first one's commit, so a route that dropped
// SERIALIZABLE_TX would keep this suite green. These two tests close that
// gap by driving both requests through the shared seam's overlapping
// transactions, gated so their interleaving is deterministic rather than
// whatever the event loop happens to order.

describe("concurrent same-name creates (WARP-1570 — isolation is load-bearing)", () => {
  /**
   * Park both requests inside their transaction, immediately after
   * deriveUniqueSlug's RANGE READ (`slug startsWith base`) and before the
   * insert into that range. That is the exact window access.ts §POST
   * documents as the reason SERIALIZABLE_TX is passed there.
   */
  function raceTwoCreates(prisma: any) {
    const app = buildApp(prisma);
    const bothRead = gate(2);
    const realFindMany = prisma.accessRole.findMany;
    prisma.accessRole.findMany = vi.fn(async (args: any) => {
      const rows = await realFindMany(args);
      if (args?.where?.slug?.startsWith !== undefined) {
        await bothRead.arriveAndWait();
      }
      return rows;
    });
    return Promise.all([
      request(app).post("/api/access/roles").send(payload({ name: "Reception" })),
      request(app).post("/api/access/roles").send(payload({ name: "Reception" })),
    ]);
  }

  it("SERIALIZABLE: exactly one create commits, the loser aborts, slugs stay unique", async () => {
    const prisma = createPrismaMock();
    const responses = await raceTwoCreates(prisma);

    // Exactly one transaction hit the SSI conflict rule.
    expect(prisma._seam().conflicts()).toBe(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);

    const slugs = [...prisma._roles().values()].map((r: any) => r.slug);
    expect(slugs).toEqual(["reception"]);
    expect(new Set(slugs).size).toBe(slugs.length);
    expectAllSerializable(prisma);

    // NOTE (handoff, not this ticket): the aborted request currently falls
    // through to `next(err)`, so the client sees a generic 500 rather than a
    // retry or a 409. Asserting "exactly one 200" instead of the loser's
    // exact status keeps this a regression guard on the INVARIANT without
    // pinning that mapping as correct.
    expect(responses.filter((r) => r.status !== 200)).toHaveLength(1);
  });

  it("REGRESSION CANARY — dropping the isolation option lets both creates commit the same slug", async () => {
    // Simulate exactly the regression: the call site loses SERIALIZABLE_TX
    // and inherits Postgres' default, READ COMMITTED. Nothing else changes.
    const prisma = createPrismaMock();
    const serializable = prisma.$transaction;
    prisma.$transaction = (fn: any) => serializable(fn);

    await raceTwoCreates(prisma);

    expect(prisma._seam().conflicts()).toBe(0);
    const slugs = [...prisma._roles().values()].map((r: any) => r.slug);
    // Both rows land on "reception" — in Postgres the @unique then 500s the
    // loser instead of handing it "reception-2". Under the OLD serial stub
    // this scenario could not be expressed at all, which is why the bare
    // `$transaction(fn)` shape shipped CI-green (WARP-1570).
    expect(slugs).toEqual(["reception", "reception"]);
    expect(new Set(slugs).size).toBeLessThan(slugs.length);
  });
});

describe("every mutating route opens its transaction at SERIALIZABLE", () => {
  // Postgres SSI only serializes transactions that are THEMSELVES
  // serializable: a READ COMMITTED transaction is invisible to conflict
  // tracking, so a bare $transaction here doesn't merely race its own
  // siblings — it defeats the isolation on the already-correct people.ts
  // paths it races (e.g. role re-tier vs PATCH /people/:id/role both
  // committing into zero remaining operators).
  const roleSeed: RoleSeed = {
    id: "r1",
    name: "Reception",
    slug: "reception",
    startingPoint: "family",
    featureGrants: [{ moduleId: "files", level: "act" }],
  };

  it("POST /access/roles (create) — slug derivation is a range-read-then-insert", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma)).post("/api/access/roles").send(payload());
    expect(res.status).toBe(200);
    expectAllSerializable(prisma);
  });

  it("POST /access/roles (duplicate)", async () => {
    const prisma = createPrismaMock({ roles: [roleSeed] });
    const res = await request(buildApp(prisma))
      .post("/api/access/roles")
      .send({ sourceRoleId: "r1" });
    expect(res.status).toBe(200);
    expectAllSerializable(prisma);
  });

  it("PATCH /access/roles/:id (plain update)", async () => {
    const prisma = createPrismaMock({ roles: [roleSeed] });
    const res = await request(buildApp(prisma))
      .patch("/api/access/roles/r1")
      .send({ name: "Front Desk" });
    expect(res.status).toBe(200);
    expectAllSerializable(prisma);
  });

  it("PATCH /access/roles/:id (re-tier loop — rails 4/5 COUNT-then-write)", async () => {
    const prisma = createPrismaMock({
      roles: [roleSeed],
      users: [
        { id: "u1", username: "ana", role: "family", accessRoleId: "r1" },
        { id: "owner-1", username: "own", role: "owner" },
      ],
    });
    const res = await request(buildApp(prisma))
      .patch("/api/access/roles/r1")
      .send({ startingPoint: "guest" });
    expect(res.status).toBe(200);
    expectAllSerializable(prisma);
  });

  it("DELETE /access/roles/:id", async () => {
    const prisma = createPrismaMock({ roles: [roleSeed] });
    const res = await request(buildApp(prisma)).delete("/api/access/roles/r1");
    expect(res.status).toBe(200);
    expectAllSerializable(prisma);
  });

  it("POST /access/roles/:id/assign — rails 4/5 COUNT-then-write", async () => {
    const prisma = createPrismaMock({
      roles: [roleSeed],
      users: [
        { id: "u1", username: "ana", role: "guest" },
        { id: "owner-1", username: "own", role: "owner" },
      ],
    });
    const res = await request(buildApp(prisma))
      .post("/api/access/roles/r1/assign")
      .send({ userIds: ["u1"] });
    expect(res.status).toBe(200);
    expectAllSerializable(prisma);
  });
});

// ── auth floor ─────────────────────────────────────────────────────

describe("route guards", () => {
  it("family callers are refused on every /api/access surface (owner/admin only)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { id: "fam-1", username: "fam", role: "family" });
    expect((await request(app).get("/api/access/roles")).status).toBe(403);
    expect((await request(app).post("/api/access/roles").send(payload())).status).toBe(403);
    expect((await request(app).patch("/api/access/roles/r1").send({ name: "x" })).status).toBe(403);
    expect((await request(app).delete("/api/access/roles/r1")).status).toBe(403);
    expect((await request(app).post("/api/access/roles/r1/assign").send({ userIds: ["u"] })).status).toBe(403);
  });
});

// ── list + detail ──────────────────────────────────────────────────

describe("GET /api/access/roles[/:id]", () => {
  it("returns { roles } with peopleCount, BigInt-as-string, and grant arrays", async () => {
    const prisma = createPrismaMock({
      roles: [
        {
          id: "r1",
          name: "Reception",
          slug: "reception",
          startingPoint: "family",
          storageQuotaBytes: 5_000_000_000n,
          featureGrants: [{ moduleId: "files", level: "act" }],
        },
      ],
      users: [{ id: "u1", username: "ana", role: "family", accessRoleId: "r1" }],
    });
    const res = await request(buildApp(prisma)).get("/api/access/roles");
    expect(res.status).toBe(200);
    expect(res.body.roles).toHaveLength(1);
    const [role] = res.body.roles;
    expect(role.id).toBe("r1");
    expect(role.slug).toBe("reception");
    expect(role.storageQuotaBytes).toBe("5000000000");
    expect(role.peopleCount).toBe(1);
    expect(role.state).toBe("active");
    expect(role.featureGrants).toEqual([{ moduleId: "files", level: "act" }]);
    expect(role.createdAt).toBeTruthy();
    expect(role.updatedAt).toBeTruthy();
  });

  it("GET /:id returns { role }; unknown id 404s", async () => {
    const prisma = createPrismaMock({
      roles: [{ id: "r1", name: "X", slug: "x", startingPoint: "guest" }],
    });
    const ok = await request(buildApp(prisma)).get("/api/access/roles/r1");
    expect(ok.status).toBe(200);
    expect(ok.body.role.id).toBe("r1");
    expect(ok.body.role.peopleCount).toBe(0);
    const missing = await request(buildApp(prisma)).get("/api/access/roles/nope");
    expect(missing.status).toBe(404);
  });
});

// ── create ─────────────────────────────────────────────────────────

describe("POST /api/access/roles (create)", () => {
  it("creates the role: server-derived slug, §9 re-clamp, connector clamp, locks auto-off, Activity", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma))
      .post("/api/access/roles")
      .send(
        payload({
          name: "  Front Desk!  ",
          // over-floor on a family starting point → server re-clamps to view
          featureGrants: [{ moduleId: "network", level: "manage" }],
          // read_write only legal on admin-based roles (O-2) → clamps to read
          connectorGrants: [{ provider: "eaglesoft", level: "read_write" }],
          // locks without a smart_home grant → forced false
          mayOperateLocks: true,
        }),
      );
    expect(res.status).toBe(200);
    expect(res.body.role.name).toBe("Front Desk!");
    expect(res.body.role.slug).toBe("front-desk");
    expect(res.body.role.featureGrants).toEqual([{ moduleId: "network", level: "view" }]);
    expect(res.body.role.connectorGrants).toEqual([{ provider: "eaglesoft", level: "read" }]);
    expect(res.body.role.mayOperateLocks).toBe(false);
    expect(res.body.role.peopleCount).toBe(0);
    expect(res.body.syncState).toBe("synced");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", what: "Access role created" }),
    );
  });

  it("keeps mayOperateLocks when smart_home IS granted; stores BigInt from the string boundary", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma))
      .post("/api/access/roles")
      .send(
        payload({
          mayOperateLocks: true,
          featureGrants: [{ moduleId: "smart_home", level: "act" }],
          storageQuotaBytes: "9000000000",
        }),
      );
    expect(res.status).toBe(200);
    expect(res.body.role.mayOperateLocks).toBe(true);
    expect(res.body.role.storageQuotaBytes).toBe("9000000000");
    const stored = prisma._roles().get(res.body.role.id);
    expect(stored.storageQuotaBytes).toBe(9_000_000_000n);
  });

  // WARP-1578 — the Guest floor at create time. O-2's read floor is
  // family-and-UP; erp.ts enforces the "and-up" half at the consumption site,
  // so a connector grant on a Guest-based role is inert by construction. The
  // builder disables the option with the reason (never hides it), and the
  // server drops it — the client is never trusted, and the roles list must
  // not advertise reach that does not exist.
  it("drops connector grants on a Guest-based role at create (WARP-1578)", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma))
      .post("/api/access/roles")
      .send(
        payload({
          startingPoint: "guest",
          connectorGrants: [
            { provider: "eaglesoft", level: "read" },
            { provider: "eaglesoft-api", level: "read_write" },
          ],
        }),
      );
    expect(res.status).toBe(200);
    expect(res.body.role.connectorGrants).toEqual([]);
    // …and nothing was persisted, so a later resolve cannot resurrect them.
    expect(prisma._roles().get(res.body.role.id).connectorGrants).toEqual([]);
  });

  it("keeps them on a Family-based role — the floor is a floor, not a ban (WARP-1578)", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma))
      .post("/api/access/roles")
      .send(payload({ startingPoint: "family" }));
    expect(res.status).toBe(200);
    expect(res.body.role.connectorGrants).toEqual([{ provider: "eaglesoft", level: "read" }]);
  });

  it("uniquifies a colliding slug with a numeric suffix", async () => {
    const prisma = createPrismaMock({
      roles: [{ id: "r1", name: "Reception", slug: "reception", startingPoint: "family" }],
    });
    const res = await request(buildApp(prisma)).post("/api/access/roles").send(payload());
    expect(res.status).toBe(200);
    expect(res.body.role.slug).toBe("reception-2");
  });

  it("400s owner/service starting points, fractional BigInt strings, erp tool grants, chat feature rows", async () => {
    const app = buildApp(createPrismaMock());
    expect((await request(app).post("/api/access/roles").send(payload({ startingPoint: "owner" }))).status).toBe(400);
    expect((await request(app).post("/api/access/roles").send(payload({ startingPoint: "service" }))).status).toBe(400);
    expect((await request(app).post("/api/access/roles").send(payload({ storageQuotaBytes: "12.5" }))).status).toBe(400);
    expect((await request(app).post("/api/access/roles").send(payload({ storageQuotaBytes: "-5" }))).status).toBe(400);
    expect(
      (await request(app).post("/api/access/roles").send(payload({ toolGrants: [{ domain: "erp", level: "use" }] })))
        .status,
    ).toBe(400);
    expect(
      (await request(app).post("/api/access/roles").send(payload({ featureGrants: [{ moduleId: "chat", level: "act" }] })))
        .status,
    ).toBe(400);
  });
});

// ── duplicate ──────────────────────────────────────────────────────

describe("POST /api/access/roles (duplicate via sourceRoleId)", () => {
  it("copies the grant set with a fresh server-derived name/slug", async () => {
    const prisma = createPrismaMock({
      roles: [
        {
          id: "r1",
          name: "Reception",
          slug: "reception",
          startingPoint: "family",
          storageQuotaBytes: 1_000n,
          cloudModelsAllowed: true,
          featureGrants: [{ moduleId: "files", level: "act" }],
          toolGrants: [{ domain: "files", level: "use" }],
          connectorGrants: [{ provider: "eaglesoft", level: "read" }],
        },
      ],
    });
    const res = await request(buildApp(prisma)).post("/api/access/roles").send({ sourceRoleId: "r1" });
    expect(res.status).toBe(200);
    expect(res.body.role.id).not.toBe("r1");
    expect(res.body.role.name).toBe("Reception (copy)");
    expect(res.body.role.slug).toBe("reception-copy");
    expect(res.body.role.startingPoint).toBe("family");
    expect(res.body.role.storageQuotaBytes).toBe("1000");
    expect(res.body.role.cloudModelsAllowed).toBe(true);
    expect(res.body.role.featureGrants).toEqual([{ moduleId: "files", level: "act" }]);
    expect(res.body.role.toolGrants).toEqual([{ domain: "files", level: "use" }]);
    expect(res.body.role.connectorGrants).toEqual([{ provider: "eaglesoft", level: "read" }]);
    expect(res.body.role.peopleCount).toBe(0);
  });

  it("404s an unknown sourceRoleId", async () => {
    const res = await request(buildApp(createPrismaMock())).post("/api/access/roles").send({ sourceRoleId: "nope" });
    expect(res.status).toBe(404);
  });
});

// ── update / archive ───────────────────────────────────────────────

describe("PATCH /api/access/roles/:id", () => {
  const baseRole: RoleSeed = {
    id: "r1",
    name: "Reception",
    slug: "reception",
    startingPoint: "family",
    featureGrants: [{ moduleId: "files", level: "act" }],
  };

  it("renames without touching the slug (slug is a stable server-owned identifier)", async () => {
    const prisma = createPrismaMock({ roles: [baseRole] });
    const res = await request(buildApp(prisma)).patch("/api/access/roles/r1").send({ name: "Front Desk" });
    expect(res.status).toBe(200);
    expect(res.body.role.name).toBe("Front Desk");
    expect(res.body.role.slug).toBe("reception");
    expect(res.body.syncState).toBe("synced");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", what: "Access role updated" }),
    );
  });

  it("archives via { state: 'archived' } with its own Activity string", async () => {
    const prisma = createPrismaMock({ roles: [baseRole] });
    const res = await request(buildApp(prisma)).patch("/api/access/roles/r1").send({ state: "archived" });
    expect(res.status).toBe(200);
    expect(res.body.role.state).toBe("archived");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", what: "Access role archived" }),
    );
  });

  it("a startingPoint change re-tiers every member in the same transaction + revokes their sessions", async () => {
    const prisma = createPrismaMock({
      roles: [baseRole],
      users: [
        { id: "u1", username: "ana", role: "family", accessRoleId: "r1" },
        { id: "u2", username: "bo", role: "family", accessRoleId: "r1" },
        { id: "owner-1", username: "own", role: "owner" },
      ],
    });
    const res = await request(buildApp(prisma)).patch("/api/access/roles/r1").send({ startingPoint: "guest" });
    expect(res.status).toBe(200);
    expect(res.body.role.startingPoint).toBe("guest");
    expect(res.body.syncState).toBe("pending");
    expect(prisma._users().get("u1").role).toBe("guest");
    expect(prisma._users().get("u2").role).toBe("guest");
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u1");
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u2");
  });

  it("re-tiers a member assigned DURING the change — the membership is read inside the transaction", async () => {
    // B2 regression. The old code snapshotted members before the tx, so
    // anyone assigned in the window kept User.role at the OLD, higher tier
    // while startingPoint moved down — layer-1 requireRole then honours the
    // stale admin tier forever, with nothing to reconcile it.
    const prisma = createPrismaMock({
      roles: [{ ...baseRole, startingPoint: "admin" }],
      users: [
        { id: "u1", username: "ana", role: "admin", accessRoleId: "r1" },
        { id: "owner-1", username: "own", role: "owner" },
        { id: "admin-keeper", username: "keeper", role: "admin" },
      ],
    });
    // Land the concurrent assignment at a point that DISCRIMINATES the two
    // orderings: inside the transaction, on the first grant write — which
    // happens AFTER the old code's pre-tx membership snapshot but BEFORE
    // the new code's in-tx membership read. Old code → u2-late is missed
    // and keeps role "admin"; new code → it is re-tiered.
    const realDeleteMany = prisma.accessRoleFeatureGrant.deleteMany;
    prisma.accessRoleFeatureGrant.deleteMany = vi.fn(async (args: any) => {
      const out = await realDeleteMany(args);
      if (!prisma._users().has("u2-late")) {
        prisma._users().set("u2-late", {
          id: "u2-late",
          username: "late",
          displayName: "Late",
          role: "admin",
          nextcloudUsername: null,
          directoryStatus: "ACTIVE",
          accessRoleId: "r1",
          usagePolicy: null,
        });
      }
      return out;
    });

    const res = await request(buildApp(prisma))
      .patch("/api/access/roles/r1")
      .send({ startingPoint: "family" });

    expect(res.status).toBe(200);
    expect(prisma._users().get("u1").role).toBe("family");
    // the late arrival is re-tiered too — no stale admin left behind
    expect(prisma._users().get("u2-late").role).toBe("family");
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u2-late");
  });

  it("does not emit a 'Role changed: X → X' audit row for a member already at the target tier", async () => {
    // Rider: the post-effect loop used to run the full tier-change runner
    // for every member, so a member already sitting at the target tier got
    // an audit row claiming family → family. They still get revoked.
    const prisma = createPrismaMock({
      roles: [{ ...baseRole, startingPoint: "admin" }],
      users: [
        // drifted: holds the admin-based role but is already family
        { id: "u1", username: "ana", role: "family", accessRoleId: "r1" },
        { id: "owner-1", username: "own", role: "owner" },
        { id: "admin-keeper", username: "keeper", role: "admin" },
      ],
    });
    const res = await request(buildApp(prisma))
      .patch("/api/access/roles/r1")
      .send({ startingPoint: "family" });
    expect(res.status).toBe(200);
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u1");
    expect(recordActivityMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ what: "Role changed" }),
    );
  });

  it("re-clamps stored grants when the starting point drops below their floor", async () => {
    const prisma = createPrismaMock({
      roles: [
        {
          id: "r1",
          name: "Ops",
          slug: "ops",
          startingPoint: "admin",
          featureGrants: [{ moduleId: "network", level: "manage" }],
          connectorGrants: [{ provider: "eaglesoft", level: "read_write" }],
        },
      ],
    });
    const res = await request(buildApp(prisma)).patch("/api/access/roles/r1").send({ startingPoint: "family" });
    expect(res.status).toBe(200);
    expect(res.body.role.featureGrants).toEqual([{ moduleId: "network", level: "view" }]);
    expect(res.body.role.connectorGrants).toEqual([{ provider: "eaglesoft", level: "read" }]);
  });

  // WARP-1530 (T6) verification pin: O-2's "Read & write grants are only
  // selectable on Admin-based roles" must hold on the DIRECT patch path too,
  // not just at create and on a startingPoint drop. A Family-based role can
  // never end up holding read_write, so T6's connector wiring has nothing to
  // re-check at request time.
  it("caps a read_write connector grant to read when patched onto a Family-based role (O-2)", async () => {
    const prisma = createPrismaMock({ roles: [baseRole] });
    const res = await request(buildApp(prisma))
      .patch("/api/access/roles/r1")
      .send({ connectorGrants: [{ provider: "eaglesoft", level: "read_write" }] });
    expect(res.status).toBe(200);
    expect(res.body.role.startingPoint).toBe("family");
    expect(res.body.role.connectorGrants).toEqual([{ provider: "eaglesoft", level: "read" }]);
  });

  // WARP-1578 — the Guest floor. O-2's read floor is family-and-UP, and
  // erp.ts enforces the "and-up" half at the consumption site, so a connector
  // grant saved on a Guest-based role can NEVER take effect. Storing it lets
  // an operator save something that silently does nothing, and makes the
  // roles list claim a reach that does not exist. Dropped here, on every
  // write path, exactly like the read_write cap above it.
  it("drops connector grants on a Guest-based role — they can never take effect (WARP-1578)", async () => {
    const prisma = createPrismaMock({ roles: [baseRole] });
    const res = await request(buildApp(prisma))
      .patch("/api/access/roles/r1")
      .send({
        startingPoint: "guest",
        connectorGrants: [{ provider: "eaglesoft", level: "read" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.role.startingPoint).toBe("guest");
    expect(res.body.role.connectorGrants).toEqual([]);
  });

  it("…and drops STORED ones when the starting point drops to Guest (WARP-1578)", async () => {
    const prisma = createPrismaMock({
      roles: [
        {
          ...baseRole,
          connectorGrants: [{ provider: "eaglesoft", level: "read" }],
        },
      ],
    });
    const res = await request(buildApp(prisma))
      .patch("/api/access/roles/r1")
      .send({ startingPoint: "guest" });
    expect(res.status).toBe(200);
    expect(res.body.role.connectorGrants).toEqual([]);
  });

  it("keeps read_write on an Admin-based role (the cap is a floor, not a ban)", async () => {
    const prisma = createPrismaMock({
      roles: [{ ...baseRole, startingPoint: "admin" }],
    });
    const res = await request(buildApp(prisma))
      .patch("/api/access/roles/r1")
      .send({ connectorGrants: [{ provider: "eaglesoft", level: "read_write" }] });
    expect(res.status).toBe(200);
    expect(res.body.role.connectorGrants).toEqual([
      { provider: "eaglesoft", level: "read_write" },
    ]);
  });

  it("refuses a startingPoint change when the actor holds the role (self-action rail)", async () => {
    const prisma = createPrismaMock({
      roles: [baseRole],
      users: [{ id: "actor-1", username: "stefan", role: "family", accessRoleId: "r1" }],
    });
    const res = await request(buildApp(prisma)).patch("/api/access/roles/r1").send({ startingPoint: "guest" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SELF_ACTION_NOT_ALLOWED");
    expect(prisma._users().get("actor-1").role).toBe("family");
    // ATOMICITY: the rail now fires INSIDE the transaction, after the role
    // row and its grants were already rewritten — the rollback must undo
    // them, or the role keeps a startingPoint its members never received.
    expect(prisma._roles().get("r1").startingPoint).toBe("family");
    expect(prisma._roles().get("r1").featureGrants).toEqual([
      { moduleId: "files", level: "act" },
    ]);
  });

  it("refuses demoting the role that holds the last active operators (last-operator invariant)", async () => {
    const prisma = createPrismaMock({
      roles: [{ ...baseRole, startingPoint: "admin" }],
      users: [{ id: "u1", username: "ana", role: "admin", accessRoleId: "r1" }],
    });
    const res = await request(buildApp(prisma)).patch("/api/access/roles/r1").send({ startingPoint: "family" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LAST_OPERATOR_INVARIANT");
    // ATOMICITY: same window — the role update + grant rewrite precede the
    // in-tx invariant, so a refusal must leave the row untouched.
    expect(prisma._roles().get("r1").startingPoint).toBe("admin");
    expect(prisma._roles().get("r1").featureGrants).toEqual([
      { moduleId: "files", level: "act" },
    ]);
    expect(prisma._users().get("u1").role).toBe("admin");
  });

  it("a set/changed storage default with members kicks the reconciler → syncState pending", async () => {
    const prisma = createPrismaMock({
      roles: [baseRole],
      users: [{ id: "u1", username: "ana", role: "family", accessRoleId: "r1" }],
    });
    const res = await request(buildApp(prisma))
      .patch("/api/access/roles/r1")
      .send({ storageQuotaBytes: "7000000000" });
    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe("pending");
    expect(kickReconcileMock).toHaveBeenCalledTimes(1);
    expect(prisma._roles().get("r1").storageQuotaBytes).toBe(7_000_000_000n);
  });

  it("a CLEARED storage default does not fabricate an NC push — it surfaces retainedQuotaCount", async () => {
    const prisma = createPrismaMock({
      roles: [{ ...baseRole, storageQuotaBytes: 5_000_000_000n }],
      users: [
        // keeps role default until edited (no person quota)
        { id: "u1", username: "ana", role: "family", accessRoleId: "r1" },
        // has a person-level quota — their row lifecycle owns pushes
        {
          id: "u2",
          username: "bo",
          role: "family",
          accessRoleId: "r1",
          usagePolicy: { storageQuotaBytes: 1_000n },
        },
      ],
    });
    const res = await request(buildApp(prisma)).patch("/api/access/roles/r1").send({ storageQuotaBytes: null });
    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe("synced");
    expect(res.body.retainedQuotaCount).toBe(1);
    expect(kickReconcileMock).not.toHaveBeenCalled();
    expect(prisma._roles().get("r1").storageQuotaBytes).toBeNull();
  });

  it("404s an unknown role id", async () => {
    const res = await request(buildApp(createPrismaMock())).patch("/api/access/roles/nope").send({ name: "X" });
    expect(res.status).toBe(404);
  });
});

// ── delete (carried obligation: ANY referencing invite row) ────────

describe("DELETE /api/access/roles/:id", () => {
  const roleSeed: RoleSeed = { id: "r1", name: "Reception", slug: "reception", startingPoint: "family" };

  it("blocks while members hold the role — reassign-first payload lists them", async () => {
    const prisma = createPrismaMock({
      roles: [roleSeed],
      users: [{ id: "u1", username: "ana", displayName: "Ana", role: "family", accessRoleId: "r1" }],
    });
    const res = await request(buildApp(prisma)).delete("/api/access/roles/r1");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCESS_ROLE_IN_USE");
    expect(res.body.members).toEqual([{ id: "u1", username: "ana", displayName: "Ana" }]);
    expect(prisma._roles().has("r1")).toBe(true);
  });

  it("blocks on a PENDING invite — listed in the reassign-first payload", async () => {
    const prisma = createPrismaMock({
      roles: [roleSeed],
      invites: [
        { id: "inv-1", username: "newhire", email: "new@acme.co", accessRoleId: "r1", expiresAt: FUTURE },
      ],
    });
    const res = await request(buildApp(prisma)).delete("/api/access/roles/r1");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCESS_ROLE_IN_USE");
    expect(res.body.pendingInvites).toEqual([
      { id: "inv-1", username: "newhire", email: "new@acme.co" },
    ]);
    expect(prisma._invites().get("inv-1").accessRoleId).toBe("r1");
  });

  it("releases NON-pending invite rows (accepted/revoked/expired) inside the delete transaction", async () => {
    const prisma = createPrismaMock({
      roles: [roleSeed],
      invites: [
        { id: "inv-a", username: "was-accepted", accessRoleId: "r1", acceptedAt: PAST, expiresAt: FUTURE },
        { id: "inv-r", username: "was-revoked", accessRoleId: "r1", revokedAt: PAST, expiresAt: FUTURE },
        { id: "inv-e", username: "expired", accessRoleId: "r1", expiresAt: PAST },
      ],
    });
    const res = await request(buildApp(prisma)).delete("/api/access/roles/r1");
    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe("synced");
    expect(prisma._roles().has("r1")).toBe(false);
    expect(prisma._invites().get("inv-a").accessRoleId).toBeNull();
    expect(prisma._invites().get("inv-r").accessRoleId).toBeNull();
    expect(prisma._invites().get("inv-e").accessRoleId).toBeNull();
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", what: "Access role deleted" }),
    );
  });

  it("404s an unknown role id", async () => {
    expect((await request(buildApp(createPrismaMock())).delete("/api/access/roles/nope")).status).toBe(404);
  });

  // Renamed (review): the previous title claimed to prove ROLLBACK, but the
  // seed held only a pending invite — which the release filter skips on its
  // own merits — so nothing was ever written to roll back. This case proves
  // exactly what it says: the release filter is the complement of the
  // pre-check, so a raced PENDING row keeps its pointer and the FK refuses.
  it("a pending invite racing in after the pre-check keeps its pointer — the Restrict FK refuses the delete", async () => {
    const prisma = createPrismaMock({
      roles: [roleSeed],
      invites: [
        { id: "inv-raced", username: "raced", accessRoleId: "r1", expiresAt: FUTURE },
      ],
    });
    // Simulate the check→delete window: the pre-check misses the invite
    // that was written concurrently…
    prisma.userInvite.findMany.mockResolvedValueOnce([]);
    const res = await request(buildApp(prisma)).delete("/api/access/roles/r1");
    // …the release filter skips PENDING rows, the FK refuses, and the
    // caller gets the same reassign-first 409 the pre-check would give.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCESS_ROLE_IN_USE");
    expect(prisma._roles().has("r1")).toBe(true);
    expect(prisma._invites().get("inv-raced").accessRoleId).toBe("r1");
  });

  it("ROLLS BACK the non-pending invite release when the FK refuses on a raced pending row", async () => {
    // Both kinds present: the non-pending row IS released inside the
    // transaction (a real write), then the raced pending row makes the
    // delete fail. The release must not survive — otherwise a refused
    // delete has silently detached historical invites from their role.
    const prisma = createPrismaMock({
      roles: [roleSeed],
      invites: [
        { id: "inv-accepted", username: "old", accessRoleId: "r1", acceptedAt: PAST, expiresAt: FUTURE },
        { id: "inv-raced", username: "raced", accessRoleId: "r1", expiresAt: FUTURE },
      ],
    });
    prisma.userInvite.findMany.mockResolvedValueOnce([]); // pre-check misses the race
    const res = await request(buildApp(prisma)).delete("/api/access/roles/r1");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCESS_ROLE_IN_USE");
    expect(prisma._roles().has("r1")).toBe(true);
    // the raced pending row was never touched…
    expect(prisma._invites().get("inv-raced").accessRoleId).toBe("r1");
    // …and the released non-pending row is back to pointing at the role.
    expect(prisma._invites().get("inv-accepted").accessRoleId).toBe("r1");
    expect(recordActivityMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ what: "Access role deleted" }),
    );
  });
});

// ── assign ─────────────────────────────────────────────────────────

describe("POST /api/access/roles/:id/assign", () => {
  const roleSeed: RoleSeed = { id: "r1", name: "Reception", slug: "reception", startingPoint: "family" };

  it("assigns the role: sets accessRoleId + User.role from startingPoint, revokes sessions, audits", async () => {
    const prisma = createPrismaMock({
      roles: [roleSeed],
      users: [
        { id: "u1", username: "ana", role: "guest" },
        { id: "owner-1", username: "own", role: "owner" },
      ],
    });
    const res = await request(buildApp(prisma))
      .post("/api/access/roles/r1/assign")
      .send({ userIds: ["u1"] });
    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe("pending");
    expect(prisma._users().get("u1").accessRoleId).toBe("r1");
    expect(prisma._users().get("u1").role).toBe("family");
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u1");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", what: "Access role assigned" }),
    );
  });

  it("refuses an archived role (409), self-assignment (409), and an owner target (403)", async () => {
    const prisma = createPrismaMock({
      roles: [
        { ...roleSeed },
        { id: "r2", name: "Old", slug: "old", startingPoint: "family", state: "archived" },
      ],
      users: [
        { id: "actor-1", username: "stefan", role: "owner" },
        { id: "owner-2", username: "other-owner", role: "owner" },
        { id: "u1", username: "ana", role: "family" },
      ],
    });
    const app = buildApp(prisma);
    const archived = await request(app).post("/api/access/roles/r2/assign").send({ userIds: ["u1"] });
    expect(archived.status).toBe(409);
    expect(archived.body.code).toBe("ACCESS_ROLE_ARCHIVED");
    const self = await request(app).post("/api/access/roles/r1/assign").send({ userIds: ["actor-1"] });
    expect(self.status).toBe(409);
    expect(self.body.code).toBe("SELF_ACTION_NOT_ALLOWED");
    const owner = await request(app).post("/api/access/roles/r1/assign").send({ userIds: ["owner-2"] });
    expect(owner.status).toBe(403);
    expect(owner.body.code).toBe("OWNER_IMMUTABLE");
  });

  it("404s when any target user is missing; assignment is all-or-nothing", async () => {
    const prisma = createPrismaMock({
      roles: [roleSeed],
      users: [{ id: "u1", username: "ana", role: "guest" }],
    });
    const res = await request(buildApp(prisma))
      .post("/api/access/roles/r1/assign")
      .send({ userIds: ["u1", "ghost"] });
    expect(res.status).toBe(404);
    expect(prisma._users().get("u1").accessRoleId).toBeNull();
  });

  it("an already-assigned target is a quiet no-op → syncState synced, nothing revoked", async () => {
    const prisma = createPrismaMock({
      roles: [roleSeed],
      users: [{ id: "u1", username: "ana", role: "family", accessRoleId: "r1" }],
    });
    const res = await request(buildApp(prisma))
      .post("/api/access/roles/r1/assign")
      .send({ userIds: ["u1"] });
    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe("synced");
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});
