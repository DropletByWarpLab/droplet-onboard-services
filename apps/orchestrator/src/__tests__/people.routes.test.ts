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
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
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

// WARP-247: the role-change route revokes the target's live session RECORDS
// (revokeAllSessions, which also sweeps the WARP-116 refresh denylist) so the
// new role propagates at the next request. Mock the revoke so we can assert
// the call without standing up Redis.
const { revokeAllSessionsMock } = vi.hoisted(() => ({
  revokeAllSessionsMock: vi.fn().mockResolvedValue(0),
}));
vi.mock("../services/session.service.js", () => ({
  createSession: vi.fn(async () => ({ sid: "sid-test", evictedSids: [] })),
  checkSession: vi.fn(async () => ({ kind: "ok", record: { userId: "x", role: "family", createdAt: 0, lastSeenAt: 0 } })),
  deleteSession: vi.fn(async () => undefined),
  revokeAllSessions: revokeAllSessionsMock,
}));

// WARP-490: DELETE /people/:id now ALSO denylists the removed user's access
// tokens (immediate revocation of sid-less / already-issued tokens that the
// session-record sweep alone wouldn't catch). Mock the denylist service so we
// can assert the call without standing up Redis.
const { denylistUserMock } = vi.hoisted(() => ({
  denylistUserMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/auth-denylist.service.js", () => ({
  denylistUser: denylistUserMock,
  isUserDenied: vi.fn().mockResolvedValue(false),
}));

// WARP-1259 (T7): the role-change route syncs the box-wide `droplet-admins`
// NC group on owner/admin promote/demote through the same code path that
// already revokes sessions. Mock the NC calls so we can assert group-sync
// behavior (and its failure mode) without standing up Nextcloud.
const { ncAddUserToGroupMock, ncRemoveUserFromGroupMock } = vi.hoisted(() => ({
  ncAddUserToGroupMock: vi.fn().mockResolvedValue(undefined),
  ncRemoveUserFromGroupMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/nextcloud-groups.client.js", () => ({
  ncAddUserToGroup: ncAddUserToGroupMock,
  ncRemoveUserFromGroup: ncRemoveUserFromGroupMock,
}));
vi.mock("../services/department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic:dGVzdDp0ZXN0"),
  DROPLET_ADMINS_GROUP: "droplet-admins",
}));

// WARP-1271 (T19a): PUT/GET /people/:id/usage route through the REAL
// usage-policy.service.js, which calls these two Nextcloud client
// functions — mock them so the suite never touches a real Nextcloud.
const { ncUpdateUserMock, ncGetUserQuotaAdminMock } = vi.hoisted(() => ({
  ncUpdateUserMock: vi.fn().mockResolvedValue(undefined),
  ncGetUserQuotaAdminMock: vi.fn().mockResolvedValue({ used: 0, free: null, total: null, quota: null }),
}));
vi.mock("../services/nextcloud.client.js", () => ({
  ncUpdateUser: ncUpdateUserMock,
  ncGetUserQuotaAdmin: ncGetUserQuotaAdminMock,
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
  nextcloudUsername?: string | null;
  createdAt: Date;
  updatedAt: Date;
  // WARP-1539 — the three secret-bearing columns the People surface must
  // never serialize. Seeded on every row so a route that forwards a raw
  // Prisma row fails the leak tests instead of passing by omission.
  passwordHash?: string | null;
  emailLookupHash?: string | null;
}

/** WARP-1539 — keys that must never reach an API response. */
const SECRET_USER_FIELDS = [
  "passwordHash",
  "emailLookupHash",
  "email",
] as const;

function seedUser(over: Partial<MockUser> = {}): MockUser {
  return {
    id: over.id ?? `u-${Math.random().toString(16).slice(2, 8)}`,
    username: over.username ?? "alice",
    displayName: over.displayName ?? "Alice",
    // WARP-233: `email` is an encrypted dcv1: blob at rest, so even the
    // ciphertext is not ours to hand out.
    email: over.email ?? "dcv1:ZW5jcnlwdGVkLWVtYWls",
    role: over.role ?? "family",
    isLocal: over.isLocal ?? true,
    nextcloudUsername: over.nextcloudUsername ?? null,
    createdAt: over.createdAt ?? new Date("2026-05-25T10:00:00Z"),
    updatedAt: over.updatedAt ?? new Date("2026-05-25T10:00:00Z"),
    passwordHash:
      over.passwordHash ?? "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA",
    emailLookupHash: over.emailLookupHash ?? "hmac-sha256-blind-index",
  };
}

/**
 * Apply a Prisma `select` to a mock row (WARP-1539).
 *
 * The mock previously ignored `select` entirely and always returned the
 * whole row, which would let the leak tests below pass whether or not the
 * route actually projects its columns. Honoring it here is what makes
 * those tests real.
 */
function project(row: any, select?: Record<string, boolean>) {
  if (!row || !select) return row;
  const out: any = {};
  for (const [k, want] of Object.entries(select)) {
    if (want && k in row) out[k] = row[k];
  }
  return out;
}

function createPrismaMock(initialRows: MockUser[] = []) {
  const rows = new Map<string, MockUser>(initialRows.map((u) => [u.id, u]));
  const scopeBindings = new Map<string, Set<string>>();
  const usagePolicies = new Map<string, any>();
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
      findMany: vi.fn(async ({ select }: { select?: any } = {}) => {
        return [...rows.values()]
          .sort((a, b) => +a.createdAt - +b.createdAt)
          .map((r) => project(r, select));
      }),
      findUnique: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { id: string };
          select?: any;
        }) => {
          return project(rows.get(where.id) ?? null, select);
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
          select,
        }: {
          where: { id: string };
          data: Partial<MockUser>;
          select?: any;
        }) => {
          const existing = rows.get(where.id);
          if (!existing) {
            const err: any = new Error("not found");
            err.code = "P2025";
            throw err;
          }
          const merged = { ...existing, ...data, updatedAt: new Date() };
          rows.set(where.id, merged);
          return project(merged, select);
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
    // WARP-1271 (T19a): per-user usage settings.
    userUsagePolicy: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
        return usagePolicies.get(where.userId) ?? null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = usagePolicies.get(where.userId);
          const row = existing
            ? { ...existing, ...update }
            : { ...create, updatedAt: new Date() };
          usagePolicies.set(where.userId, row);
          return { ...row };
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { userId: string };
          data: Record<string, unknown>;
        }) => {
          const existing = usagePolicies.get(where.userId);
          if (!existing) throw new Error(`no policy for ${where.userId}`);
          const row = { ...existing, ...data };
          usagePolicies.set(where.userId, row);
          return { ...row };
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
  revokeAllSessionsMock.mockClear();
  denylistUserMock.mockClear();
  ncAddUserToGroupMock.mockClear();
  ncRemoveUserFromGroupMock.mockClear();
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
    // WARP-237: the role-change business emit must NOT fire on a denied
    // request, but requireRole now emits a single "Access denied"
    // policy-violation row.
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", what: "Access denied" }),
    );
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
    expect(revokeAllSessionsMock).toHaveBeenCalledTimes(1);
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u1");
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
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
  });
});

describe("People surface never serializes secret columns — WARP-1539", () => {
  // The People routes used to hand back raw `prisma.user` rows. That row
  // carries three columns no client may ever see:
  //   • passwordHash    — the argon2id PHC hash (schema.prisma: "NEVER logged")
  //   • emailLookupHash — the WARP-233 HMAC-SHA256 blind index; leaking it
  //                       lets a holder confirm-by-guess which address a row
  //                       belongs to, which is the exact property the blind
  //                       index exists to protect
  //   • email           — stored as an encrypted dcv1: blob (WARP-233); the
  //                       ciphertext is not ours to hand out either
  //
  // owner/admin-only is NOT a mitigation: an admin session, an XSS on the
  // dashboard, or a proxy log now carries every user's password hash.
  const leakCases: Array<{
    name: string;
    run: (app: any) => Promise<{ status: number; body: any }>;
  }> = [
    {
      name: "GET /api/people (roster)",
      run: (app) => request(app).get("/api/people"),
    },
    {
      name: "PATCH /api/people/:id/role (no-op short-circuit)",
      // Same role as seeded → the route returns the pre-read row directly.
      run: (app) =>
        request(app).patch("/api/people/u1/role").send({ role: "family" }),
    },
    {
      name: "PATCH /api/people/:id/role (after update)",
      run: (app) =>
        request(app).patch("/api/people/u1/role").send({ role: "admin" }),
    },
    {
      // Easy one to miss: `res.json({` and `user: existing` sit on
      // separate lines here, so a single-line grep for the leak does not
      // find this route. Pinned so it cannot regress quietly.
      name: "PATCH /api/people/:id/scope",
      run: (app) =>
        request(app)
          .patch("/api/people/u1/scope")
          .send({ scopes: ["team"] }),
    },
  ];

  for (const c of leakCases) {
    it(`${c.name} omits every secret column`, async () => {
      const prisma = createPrismaMock([
        seedUser({ id: "u1", username: "alice", role: "family" }),
      ]);
      const app = buildApp(prisma);

      const res = await c.run(app);
      expect(res.status).toBe(200);

      // Assert against the serialized payload so a nested row is caught
      // too — checking Object.keys on the top level alone would miss one.
      const raw = JSON.stringify(res.body);
      for (const field of SECRET_USER_FIELDS) {
        expect(raw).not.toContain(field);
      }
      // And the values themselves must not appear under a renamed key.
      expect(raw).not.toContain("$argon2id$");
      expect(raw).not.toContain("hmac-sha256-blind-index");
      expect(raw).not.toContain("dcv1:");
    });
  }

  it("still returns the fields the dashboard actually renders", async () => {
    // The fix must be a projection, not a blanket strip — the People
    // surface stops working if id/displayName/role go missing.
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "family" }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app).get("/api/people");

    expect(res.status).toBe(200);
    expect(res.body.people[0]).toMatchObject({
      id: "u1",
      username: "alice",
      displayName: "Alice",
      role: "family",
      isLocal: true,
    });
    expect(res.body.people[0].createdAt).toBeDefined();
  });
});

describe("PATCH /api/people/:id/role — WARP-1523 ROLE_RANK cap", () => {
  // WARP-623 introduced the rank ladder for the CREATE/INVITE sites; this
  // block locks the same cap onto the role-UPDATE path. requireRole
  // ("owner","admin") only proves the caller may edit roles, not WHICH role
  // they may assign — without the cap an admin (rank 2) could promote any
  // member to owner (rank 3), a straight privilege escalation.
  it("admin promoting another user to owner → 403 ROLE_RANK_EXCEEDED, no write, no revoke, no audit row", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "family" }),
    ]);
    const app = buildApp(prisma, {
      id: "adm-id",
      username: "adm",
      role: "admin",
    });

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "owner" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_RANK_EXCEEDED");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
    // The refusal comes from the handler (past requireRole), so not even
    // the "Access denied" policy row fires — same as the invite-site cap.
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("admin assigning admin (equal rank) is ALLOWED — the cap is <=, not <, so last-admin recovery keeps working", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "family" }),
    ]);
    const app = buildApp(prisma, {
      id: "adm-id",
      username: "adm",
      role: "admin",
    });

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "admin" });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("admin");
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("owner promoting a user to owner (equal rank at the top) is ALLOWED", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "admin" }),
    ]);
    const app = buildApp(prisma); // default caller: owner

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "owner" });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("owner");
  });

  it("admin no-op re-submit of an existing owner row stays 200 (cap runs after the no-op short-circuit)", async () => {
    // The dashboard re-submits the same form on focus loss (see the no-op
    // comment in the handler). An admin with an owner's row open must not
    // start seeing spurious 403s — the cap only bites on an actual CHANGE.
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "boss", role: "owner" }),
    ]);
    const app = buildApp(prisma, {
      id: "adm-id",
      username: "adm",
      role: "admin",
    });

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "owner" });

    expect(res.status).toBe(200);
    expect(prisma.user.update).not.toHaveBeenCalled(); // no-op short-circuit
  });
});

describe("PATCH /api/people/:id/role — WARP-1259 droplet-admins NC sync", () => {
  it("promote family -> admin adds to droplet-admins", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "family", nextcloudUsername: "alice" }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "admin" });

    expect(res.status).toBe(200);
    expect(ncAddUserToGroupMock).toHaveBeenCalledTimes(1);
    expect(ncAddUserToGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "alice",
      "droplet-admins",
    );
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalled();
  });

  it("promote admin -> owner adds to droplet-admins (still admin-tier)", async () => {
    // admin -> owner: both are admin-tier, so this is NOT a tier crossing
    // and must NOT touch the NC group.
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "admin", nextcloudUsername: "alice" }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "owner" });

    expect(res.status).toBe(200);
    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalled();
  });

  it("demote admin -> family removes from droplet-admins", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "admin", nextcloudUsername: "alice" }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "family" });

    expect(res.status).toBe(200);
    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledTimes(1);
    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "alice",
      "droplet-admins",
    );
    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
  });

  it("skips the NC call entirely when the user has no nextcloudUsername", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "family", nextcloudUsername: null }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "admin" });

    expect(res.status).toBe(200);
    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
  });

  it("role change still succeeds (non-blocking) when the NC group sync throws", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", role: "family", nextcloudUsername: "alice" }),
    ]);
    const app = buildApp(prisma);
    ncAddUserToGroupMock.mockRejectedValueOnce(new Error("nc unreachable"));

    const res = await request(app)
      .patch("/api/people/u1/role")
      .send({ role: "admin" });

    // The role mutation itself must not fail just because NC is down.
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("admin");
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
    // WARP-490 — deletion hard-revokes the removed user's live credentials:
    // session records swept AND access tokens denylisted for the token TTL.
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u1");
    expect(denylistUserMock).toHaveBeenCalledWith("u1", expect.any(Number));
  });

  it("does NOT revoke or denylist when the delete is refused (self / last-owner / OCS-owned)", async () => {
    // A refused delete must leave the target's sessions untouched — otherwise
    // a rejected self-delete or last-owner attempt would still log the owner
    // out of their own box.
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", isLocal: false }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app).delete("/api/people/u1");

    expect(res.status).toBe(409);
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
    expect(denylistUserMock).not.toHaveBeenCalled();
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

// ── WARP-1271 (T19a): PUT/GET /api/people/:id/usage ───────────────────

describe("PUT /api/people/:id/usage", () => {
  beforeEach(() => {
    ncUpdateUserMock.mockClear().mockResolvedValue(undefined);
    ncGetUserQuotaAdminMock.mockClear();
  });

  it("owner+admin can upsert a target's usage policy (family → 403)", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", nextcloudUsername: "alice" }),
    ]);
    const familyApp = buildApp(prisma, {
      id: "fam-id",
      username: "fam",
      role: "family",
    });
    const denied = await request(familyApp)
      .put("/api/people/u1/usage")
      .send({ storageQuotaBytes: "1000000" });
    // requireRole rejects before the handler runs.
    expect(denied.status).toBe(403);

    const ownerApp = buildApp(prisma);
    const allowed = await request(ownerApp)
      .put("/api/people/u1/usage")
      .send({ storageQuotaBytes: "1000000" });
    expect(allowed.status).toBe(200);
    expect(allowed.body.policy.storageQuotaBytes).toBe("1000000");
    expect(allowed.body.policy.quotaSyncState).toBe("synced");
    expect(ncUpdateUserMock).toHaveBeenCalledWith(
      "basic:dGVzdDp0ZXN0",
      "alice",
      "quota",
      "1000000 B",
    );
  });

  it("400 when the body has neither field", async () => {
    const prisma = createPrismaMock([seedUser({ id: "u1" })]);
    const app = buildApp(prisma);
    const res = await request(app).put("/api/people/u1/usage").send({});
    expect(res.status).toBe(400);
  });

  it("400 on a malformed storageQuotaBytes (not a digit string)", async () => {
    const prisma = createPrismaMock([seedUser({ id: "u1" })]);
    const app = buildApp(prisma);
    const res = await request(app)
      .put("/api/people/u1/usage")
      .send({ storageQuotaBytes: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("404 for an unknown target user", async () => {
    const prisma = createPrismaMock([]);
    const app = buildApp(prisma);
    const res = await request(app)
      .put("/api/people/ghost/usage")
      .send({ maxUploadSizeMb: 100 });
    expect(res.status).toBe(404);
  });

  it("NC pushdown failure still returns 200 with quotaSyncState=failed (reconciler retries)", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", nextcloudUsername: "alice" }),
    ]);
    ncUpdateUserMock.mockRejectedValueOnce(new Error("nc unreachable"));
    const app = buildApp(prisma);
    const res = await request(app)
      .put("/api/people/u1/usage")
      .send({ storageQuotaBytes: "500" });
    expect(res.status).toBe(200);
    expect(res.body.policy.quotaSyncState).toBe("failed");
  });

  it("storageQuotaBytes: null clears the limit (pushes OCS 'none')", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", nextcloudUsername: "alice" }),
    ]);
    const app = buildApp(prisma);
    const res = await request(app)
      .put("/api/people/u1/usage")
      .send({ storageQuotaBytes: null });
    expect(res.status).toBe(200);
    expect(res.body.policy.storageQuotaBytes).toBeNull();
    expect(ncUpdateUserMock).toHaveBeenCalledWith(
      "basic:dGVzdDp0ZXN0",
      "alice",
      "quota",
      "none",
    );
  });
});

describe("GET /api/people/:id/usage", () => {
  beforeEach(() => {
    ncGetUserQuotaAdminMock.mockClear();
  });

  it("owner+admin can read a target's usage (family → 403)", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", nextcloudUsername: "alice" }),
    ]);
    ncGetUserQuotaAdminMock.mockResolvedValue({
      used: 4_200_000,
      free: null,
      total: null,
      quota: null,
    });

    const familyApp = buildApp(prisma, {
      id: "fam-id",
      username: "fam",
      role: "family",
    });
    const denied = await request(familyApp).get("/api/people/u1/usage");
    expect(denied.status).toBe(403);

    const ownerApp = buildApp(prisma);
    const res = await request(ownerApp).get("/api/people/u1/usage");
    expect(res.status).toBe(200);
    expect(res.body.policy).toBeNull(); // never set
    expect(res.body.usedBytes).toBe("4200000");
  });

  it("degrades to usedBytes:null when the NC quota read fails", async () => {
    const prisma = createPrismaMock([
      seedUser({ id: "u1", username: "alice", nextcloudUsername: "alice" }),
    ]);
    ncGetUserQuotaAdminMock.mockRejectedValue(new Error("nc down"));
    const app = buildApp(prisma);
    const res = await request(app).get("/api/people/u1/usage");
    expect(res.status).toBe(200);
    expect(res.body.usedBytes).toBeNull();
  });

  it("404 for an unknown target user", async () => {
    const prisma = createPrismaMock([]);
    const app = buildApp(prisma);
    const res = await request(app).get("/api/people/ghost/usage");
    expect(res.status).toBe(404);
  });
});
