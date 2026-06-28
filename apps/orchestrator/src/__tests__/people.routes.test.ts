/**
 * WARP-455 — /api/people HTTP surface.
 *
 * Drives the router built by createPeopleRouter() through supertest,
 * with a synthetic auth middleware that stuffs req.user directly (same
 * pattern as rbac.test.ts and aps.test.ts).
 *
 * Covered here:
 *   - GET    /api/people                — owner+admin list (200/403)
 *   - GET    /api/people/permissions    — role × ability matrix, 200 for
 *                                          any authenticated principal
 *   - PATCH  /api/people/:id/role       — owner+admin (200 + recordActivity);
 *                                          family → 403
 *   - PATCH  /api/people/:id/scope      — owner+admin (200 + recordActivity);
 *                                          family → 403
 *   - DELETE /api/people/:id            — owner+admin (200 + recordActivity);
 *                                          refuses isLocal=false
 *
 * The recordActivity import is mocked so we can assert the emitter
 * shape (kind, severity, what, refs) without standing up the audit
 * recorder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

// Hoisted so the mock factory can see it (vi.mock is hoisted to the
// top of the file ahead of any top-level let/const). Same pattern the
// existing activity-routes.test.ts uses for its prisma mock.
const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

// WARP-116: the role-change route revokes the target's live sessions so the
// new role propagates immediately. Mock the revoke so we can assert the call
// without standing up Redis.
const { revokeUserSessionsMock } = vi.hoisted(() => ({
  revokeUserSessionsMock: vi.fn().mockResolvedValue(0),
}));
vi.mock("../services/jwt.service.js", () => ({
  revokeUserSessions: revokeUserSessionsMock,
}));

import { createPeopleRouter } from "../routes/people.js";
import type { ScopeName } from "../middleware/scope.js";

interface MockUser {
  id: string;
  username: string;
  displayName: string;
  email?: string | null;
  role: string;
  isLocal: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function seedUser(over: Partial<MockUser> = {}): MockUser {
  return {
    id: over.id ?? `u-${Math.random().toString(16).slice(2, 8)}`,
    username: over.username ?? "alice",
    displayName: over.displayName ?? "Alice",
    email: over.email ?? null,
    role: over.role ?? "family",
    isLocal: over.isLocal ?? true,
    createdAt: over.createdAt ?? new Date("2026-05-25T10:00:00Z"),
    updatedAt: over.updatedAt ?? new Date("2026-05-25T10:00:00Z"),
  };
}

function createPrismaMock(initialRows: MockUser[] = []) {
  const rows = new Map<string, MockUser>(initialRows.map((u) => [u.id, u]));
  const scopeBindings = new Map<string, Set<string>>();
  // $transaction interactive form: just runs the callback with `this`
  // as the tx handle. WARP-480's last-owner invariant uses this shape
  // for the count + mutate pair; same mock idiom as
  // network.schedules.test.ts and calendar-service.test.ts.
  const self: any = {};
  self.$transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => fn(self));
  return Object.assign(self, {
    rows,
    scopeBindings,
    user: {
      findMany: vi.fn(async () => {
        return [...rows.values()].sort(
          (a, b) => +a.createdAt - +b.createdAt,
        );
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return rows.get(where.id) ?? null;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<MockUser>;
        }) => {
          const existing = rows.get(where.id);
          if (!existing) {
            const err: any = new Error("not found");
            err.code = "P2025";
            throw err;
          }
          const merged = { ...existing, ...data, updatedAt: new Date() };
          rows.set(where.id, merged);
          return merged;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const existing = rows.get(where.id);
        if (!existing) {
          const err: any = new Error("not found");
          err.code = "P2025";
          throw err;
        }
        rows.delete(where.id);
        return existing;
      }),
      count: vi.fn(
        async ({ where }: { where?: { role?: string } } = {}) => {
          if (!where || where.role === undefined) {
            return rows.size;
          }
          let n = 0;
          for (const u of rows.values()) if (u.role === where.role) n += 1;
          return n;
        },
      ),
    },
    scopeBinding: {
      deleteMany: vi.fn(
        async ({ where }: { where: { userId: string; scope?: any } }) => {
          const set = scopeBindings.get(where.userId);
          if (!set) return { count: 0 };
          if (where.scope === undefined) {
            const count = set.size;
            scopeBindings.delete(where.userId);
            return { count };
          }
          return { count: 0 };
        },
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            userId: string;
            scope: string;
            grantedBy?: string | null;
          };
        }) => {
          if (!scopeBindings.has(data.userId)) {
            scopeBindings.set(data.userId, new Set());
          }
          scopeBindings.get(data.userId)!.add(data.scope);
          return { id: `sb-${Math.random()}`, ...data };
        },
      ),
      // The scope-rewrite transaction inserts the new bindings in one bulk
      // call (PATCH /people/:id/scope → tx.scopeBinding.createMany with
      // skipDuplicates, #644). Returns Prisma's `{ count }` batch-payload
      // shape; skipDuplicates is honoured by the backing Set.
      createMany: vi.fn(
        async ({
          data,
        }: {
          data: Array<{
            userId: string;
            scope: string;
            grantedBy?: string | null;
          }>;
          skipDuplicates?: boolean;
        }) => {
          let count = 0;
          for (const row of data) {
            if (!scopeBindings.has(row.userId)) {
              scopeBindings.set(row.userId, new Set());
            }
            const set = scopeBindings.get(row.userId)!;
            const before = set.size;
            set.add(row.scope);
            if (set.size > before) count += 1;
          }
          return { count };
        },
      ),
      findMany: vi.fn(
        async ({ where }: { where?: { userId?: string } } = {}) => {
          if (!where?.userId) return [];
          const set = scopeBindings.get(where.userId) ?? new Set();
          return [...set].map((scope) => ({
            id: `sb-${scope}`,
            userId: where.userId!,
            scope,
            grantedBy: null,
            grantedAt: new Date(),
          }));
        },
      ),
    },
  });
}

function buildApp(
  prismaMock: any,
  user: { id: string; username: string; role: string } = {
    id: "owner-id",
    username: "stefan",
    role: "owner",
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = {
      ...user,
      displayName: user.username,
    };
    next();
  });
  // WARP-455: createPeopleRouter now takes a scope loader (the second
  // RBAC axis). Every caller in this suite is owner/admin (loader
  // short-circuited) or family (rejected by requireRole before the
  // loader runs), so a fixed loader keeps every assertion intact.
  app.use(
    "/api",
    createPeopleRouter(
      prismaMock,
      async () => new Set<ScopeName>(["exec_only"]),
    ),
  );
  return app;
}

beforeEach(() => {
  recordActivityMock.mockClear();
  revokeUserSessionsMock.mockClear();
});

describe("GET /api/people", () => {
  it("returns the local directory for owner", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "family" }),
      seedUser({ id: "u2", username: "bob", role: "guest" }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app).get("/api/people");

    expect(res.status).toBe(200);
    expect(res.body.people).toHaveLength(2);
    expect(res.body.people[0]).toMatchObject({
      id: "u1",
      username: "alice",
      role: "family",
    });
  });

  it("returns 200 for admin too", async () => {
    const prisma = createPrismaMock([seedUser()]);
    const app = buildApp(prisma, {
      id: "a1",
      username: "admin1",
      role: "admin",
    });
    const res = await request(app).get("/api/people");
    expect(res.status).toBe(200);
  });

  it("returns 403 for family role", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, {
      id: "f1",
      username: "fam",
      role: "family",
    });
    const res = await request(app).get("/api/people");
    expect(res.status).toBe(403);
  });

  it("returns 403 for guest", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, {
      id: "g1",
      username: "guest1",
      role: "guest",
    });
    const res = await request(app).get("/api/people");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/people/permissions", () => {
  it("returns the role × ability matrix for an authenticated caller", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, {
      id: "f1",
      username: "fam",
      role: "family",
    });
    const res = await request(app).get("/api/people/permissions");

    expect(res.status).toBe(200);
    // Must enumerate every role at least once, so the dashboard can
    // render the table without an extra request.
    expect(res.body.permissions).toBeDefined();
    const roles = Object.keys(res.body.permissions);
    for (const r of ["owner", "admin", "family", "guest", "service"]) {
      expect(roles).toContain(r);
    }
    // Each role row carries at least one ability flag.
    for (const r of roles) {
      expect(typeof res.body.permissions[r]).toBe("object");
    }
  });

  it("is open to every authenticated principal (no requireRole gate)", async () => {
    // Even guests can read the permissions matrix — it's a UX helper
    // for the dashboard, not a privileged operation. Returning 403 here
    // would force the dashboard to special-case role rendering and is
    // explicitly NOT in the ticket AC.
    const prisma = createPrismaMock();
    const app = buildApp(prisma, {
      id: "g1",
      username: "guest1",
      role: "guest",
    });
    const res = await request(app).get("/api/people/permissions");
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/people/:id/role", () => {
  it("owner can change a user's role and emits an ActivityRow", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "family" }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "admin" });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("admin");
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u1" },
        data: expect.objectContaining({ role: "admin" }),
      }),
    );
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const recorded = recordActivityMock.mock.calls[0][0];
    // Use \"system\" kind for permission edits per the controller
    // brief; refs carries the actor + the target + the role delta.
    expect(recorded.kind).toBe("system");
    expect(recorded.refs).toMatchObject({
      actor: "stefan",
      targetUserId: "u1",
      previousRole: "family",
      nextRole: "admin",
    });
  });

  it("family role is 403'd", async () => {
    const prisma = createPrismaMock([seedUser({ id: "u1" })]);
    const app = buildApp(prisma, {
      id: "fam-id",
      username: "fam",
      role: "family",
    });

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "admin" });

    expect(res.status).toBe(403);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown role value with 400 (zod validation)", async () => {
    const prisma = createPrismaMock([seedUser({ id: "u1" })]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "superadmin" });

    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the user does not exist", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .patch("/api/people/nope/role")
      .send({ role: "admin" });
    expect(res.status).toBe(404);
  });

  it("WARP-116: revokes the target's live sessions on a real role change", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "family" }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "admin" });

    expect(res.status).toBe(200);
    // The new role must propagate immediately — revoke is keyed by the
    // target's User.id (== JWT.sub == the session-index key).
    expect(revokeUserSessionsMock).toHaveBeenCalledTimes(1);
    expect(revokeUserSessionsMock).toHaveBeenCalledWith("u1");
  });

  it("WARP-116: does NOT revoke on a no-op role re-submit", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "admin" }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "admin" });

    // No state change → no revoke (mirrors the no-op audit short-circuit).
    expect(res.status).toBe(200);
    expect(revokeUserSessionsMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/people/:id/scope", () => {
  it("owner can set scope bindings and emits an ActivityRow", async () => {
    const prisma = createPrismaMock([seedUser({ id: "u1" })]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/u1/scope")
      .send({ scopes: ["team", "finance"] });

    expect(res.status).toBe(200);
    expect(res.body.scopes).toEqual(
      expect.arrayContaining(["team", "finance"]),
    );
    expect(prisma.scopeBinding.deleteMany).toHaveBeenCalledTimes(1);
    // The rewrite re-inserts the desired set in one bulk createMany call
    // (#644 — deduped + skipDuplicates), not a per-scope create loop.
    expect(prisma.scopeBinding.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.scopeBinding.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ scope: "team" }),
          expect.objectContaining({ scope: "finance" }),
        ]),
      }),
    );
    // Data-integrity (pr-reviewer HIGH): the deleteMany + recreate pair MUST
    // run inside a single $transaction so a crash between the delete and the
    // bulk insert can't leave the user with zero scope bindings (locked out
    // of every scope-guarded route). Mirrors the PATCH /role last-owner
    // invariant transaction above.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const recorded = recordActivityMock.mock.calls[0][0];
    expect(recorded.kind).toBe("system");
    expect(recorded.refs.scopes).toEqual(
      expect.arrayContaining(["team", "finance"]),
    );
  });

  it("rolls back the deleteMany when the bulk insert fails — no zero-binding window, no ActivityRow", async () => {
    const prisma = createPrismaMock([seedUser({ id: "u1" })]);
    const app = buildApp(prisma);

    // Make the bulk scopeBinding.createMany reject mid-rewrite (e.g. a
    // transient DB error). Because it runs inside the same $transaction as
    // the deleteMany, the throw rolls the delete back too — the user never
    // observes a zero-binding window — and the gated audit emit is skipped.
    prisma.scopeBinding.createMany.mockRejectedValue(
      new Error("insert failed"),
    );

    const res = await request(app)
      .patch("/api/people/u1/scope")
      .send({ scopes: ["team", "finance"] });

    expect(res.status).toBe(500);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.scopeBinding.deleteMany).toHaveBeenCalledTimes(1);
    // The audit emit is gated behind transaction success, so a failed
    // rewrite produces no ActivityRow. On real Postgres the deleteMany
    // is rolled back too, so the user never observes zero bindings; the
    // passthrough mock can only prove the ordering + the gated emit.
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("rejects an empty scopes array with 400 (force at least one binding)", async () => {
    // Clearing every binding is a delete-style operation that
    // belongs on DELETE /people/:id/scope (not in this ticket).
    // Setting zero scopes via PATCH is almost certainly a UX bug —
    // 400 prevents accidentally locking a user out by sending []
    // when they meant ["team"].
    const prisma = createPrismaMock([seedUser({ id: "u1" })]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/u1/scope")
      .send({ scopes: [] });

    expect(res.status).toBe(400);
    expect(prisma.scopeBinding.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown scope value with 400", async () => {
    const prisma = createPrismaMock([seedUser({ id: "u1" })]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/u1/scope")
      .send({ scopes: ["finance", "atomic-secrets"] });

    expect(res.status).toBe(400);
  });

  it("family is 403'd", async () => {
    const prisma = createPrismaMock([seedUser({ id: "u1" })]);
    const app = buildApp(prisma, {
      id: "fam-id",
      username: "fam",
      role: "family",
    });

    const res = await request(app)
      .patch("/api/people/u1/scope")
      .send({ scopes: ["team"] });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/people/:id", () => {
  it("owner can delete a local user and emits an ActivityRow", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", isLocal: true }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app).delete("/api/people/u1");

    expect(res.status).toBe(200);
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: "u1" } });
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const recorded = recordActivityMock.mock.calls[0][0];
    // Lifecycle events use the \"auth\" kind per the controller brief.
    expect(recorded.kind).toBe("auth");
    expect(recorded.refs.targetUserId).toBe("u1");
    expect(recorded.refs.actor).toBe("stefan");
  });

  it("refuses to delete an OCS-owned identity (isLocal=false)", async () => {
    // The User table is additive on top of Nextcloud-OCS — a mirrored
    // row should never be deleted from here (the OCS upstream owns
    // the lifecycle). 409 conveys \"state conflict\", not \"forbidden\".
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", isLocal: false }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app).delete("/api/people/u1");

    expect(res.status).toBe(409);
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("family is 403'd", async () => {
    const prisma = createPrismaMock([seedUser({ id: "u1" })]);
    const app = buildApp(prisma, {
      id: "fam-id",
      username: "fam",
      role: "family",
    });
    const res = await request(app).delete("/api/people/u1");
    expect(res.status).toBe(403);
  });

  it("returns 404 when the user is unknown", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app).delete("/api/people/nope");
    expect(res.status).toBe(404);
  });
});

/**
 * WARP-480 — self-action invariants on /api/people mutations.
 *
 * Two guards layered on top of WARP-455's requireRole("owner","admin"):
 *
 *   1. SELF_ACTION_NOT_ALLOWED — the caller may never PATCH or DELETE
 *      their own row. Owners must use ownership-transfer; admins must
 *      go through re-invite. A self-edit on the people surface is
 *      almost always a misclick that ends in lockout.
 *
 *   2. LAST_OWNER_INVARIANT — at least one user with role=owner must
 *      remain at all times. PATCH owner→non-owner on the only owner,
 *      and DELETE on the only owner, both refuse. Without this, an
 *      admin can demote the only owner to family and lock the
 *      household out of every owner-only route until someone hand-
 *      edits Postgres.
 *
 * Both guards return 409 Conflict (not 400 / 403) — the request is
 * well-formed and the caller IS authorized; the resource state is
 * what forbids the change. Refused calls MUST NOT emit an ActivityRow:
 * the audit log is reserved for actual state changes, not noise from
 * a UI that lets you click your own row.
 */
describe("WARP-480 self-action invariants", () => {
  it("PATCH /api/people/:id/role on self → 409 SELF_ACTION_NOT_ALLOWED, no ActivityRow", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "owner-id", username: "stefan", role: "owner" }),
      // Keep a second owner so this case fails on the self-action
      // guard, NOT on the last-owner invariant.
      seedUser({ id: "owner-2", username: "romain", role: "owner" }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/owner-id/role")
      .send({ role: "family" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SELF_ACTION_NOT_ALLOWED");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("PATCH /api/people/:id/scope on self → 409 SELF_ACTION_NOT_ALLOWED, no ActivityRow", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "owner-id", username: "stefan", role: "owner" }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/owner-id/scope")
      .send({ scopes: ["finance"] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SELF_ACTION_NOT_ALLOWED");
    expect(prisma.scopeBinding.deleteMany).not.toHaveBeenCalled();
    expect(prisma.scopeBinding.createMany).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("DELETE /api/people/:id on self → 409 SELF_ACTION_NOT_ALLOWED, no ActivityRow", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "owner-id", username: "stefan", role: "owner" }),
      // Second owner present so the refusal comes from the self-guard,
      // not the last-owner invariant.
      seedUser({ id: "owner-2", username: "romain", role: "owner" }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app).delete("/api/people/owner-id");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SELF_ACTION_NOT_ALLOWED");
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("PATCH owner→family on the only remaining owner → 409 LAST_OWNER_INVARIANT, no ActivityRow", async () => {
    // Admin actor tries to demote the sole owner. Self-guard does NOT
    // fire (different ids); requireRole passes (admin is allowed); the
    // last-owner check is the only thing standing in the way.
    const prisma = createPrismaMock([
      seedUser({ id: "owner-id", username: "stefan", role: "owner" }),
      seedUser({ id: "admin-id", username: "sam", role: "admin" }),
    ]);
    const app = buildApp(prisma, {
      id: "admin-id",
      username: "sam",
      role: "admin",
    });

    const res = await request(app)
      .patch("/api/people/owner-id/role")
      .send({ role: "family" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LAST_OWNER_INVARIANT");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("DELETE on the only remaining owner → 409 LAST_OWNER_INVARIANT, no ActivityRow", async () => {
    // Admin actor tries to remove the sole owner row.
    const prisma = createPrismaMock([
      seedUser({ id: "owner-id", username: "stefan", role: "owner" }),
      seedUser({ id: "admin-id", username: "sam", role: "admin" }),
    ]);
    const app = buildApp(prisma, {
      id: "admin-id",
      username: "sam",
      role: "admin",
    });

    const res = await request(app).delete("/api/people/owner-id");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LAST_OWNER_INVARIANT");
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("DELETE one of two owners → 200 (last-owner invariant only fires at count <= 1)", async () => {
    // Positive case: two owners exist, an admin can remove one of
    // them. Proves the invariant is gated on `count <= 1`, not on
    // \"target row is an owner\" — otherwise we couldn't ever
    // off-board an owner who is no longer with the household.
    const prisma = createPrismaMock([
      seedUser({ id: "owner-1", username: "stefan", role: "owner" }),
      seedUser({ id: "owner-2", username: "romain", role: "owner" }),
      seedUser({ id: "admin-id", username: "sam", role: "admin" }),
    ]);
    const app = buildApp(prisma, {
      id: "admin-id",
      username: "sam",
      role: "admin",
    });

    const res = await request(app).delete("/api/people/owner-2");

    expect(res.status).toBe(200);
    expect(prisma.user.delete).toHaveBeenCalledWith({
      where: { id: "owner-2" },
    });
    // Happy path DOES emit an ActivityRow — only refused calls are
    // silent. Asserting this here keeps a future refactor from
    // accidentally swallowing the audit on the positive path.
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0][0].refs.targetUserId).toBe(
      "owner-2",
    );
  });
});
