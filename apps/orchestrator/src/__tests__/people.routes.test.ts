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

import { createPeopleRouter } from "../routes/people.js";

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
  return {
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
  };
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
  app.use("/api", createPeopleRouter(prismaMock));
  return app;
}

beforeEach(() => {
  recordActivityMock.mockClear();
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
    expect(prisma.scopeBinding.create).toHaveBeenCalledTimes(2);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const recorded = recordActivityMock.mock.calls[0][0];
    expect(recorded.kind).toBe("system");
    expect(recorded.refs.scopes).toEqual(
      expect.arrayContaining(["team", "finance"]),
    );
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
