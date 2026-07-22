/**
 * Route tests for the WARP-217 invite endpoints.
 *
 * Strategy:
 *   - Build a minimal Express app that mounts the protected/public auth
 *     routers with a synthetic auth middleware in front (mirrors the
 *     pattern used in vpn.test.ts). This sidesteps the global
 *     `authMiddleware` so we can flip the caller's role per test.
 *   - In-memory Prisma stand-in for `userInvite` keeps the mock surface
 *     small and explicit.
 *   - Mock `ncCreateUser` so accept-flow tests don't try to talk to real
 *     Nextcloud, and assert it's invoked with the right groups[].
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readUserEmail } from "../services/user-directory.service.js";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";

// ── Config mock — must be hoisted above route imports. ──
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true, // we still feed req.user via test middleware
    AUTH_MODE: "password",
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 604800,
    DEVICE_SECRET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    REDIS_URL: "redis://localhost:6379",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// Stub the Nextcloud client to avoid HTTP traffic in tests.
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
    ncInstallAndCreateAdmin: vi.fn(),
    ncLoginWithCredentials: vi.fn(),
    ncDeleteAppPassword: vi.fn(),
    ncGetCurrentUser: vi.fn().mockResolvedValue({ id: "alice", displayName: "Alice", groups: [] }),
    ncCreateUser: vi.fn().mockResolvedValue(undefined),
    ncDeleteUser: vi.fn(),
    ncListUsers: vi.fn(),
    ncUpdateUser: vi.fn(),
    ncSetUserEnabled: vi.fn(),
    ncOAuth2AuthorizeUrl: vi.fn(),
    ncOAuth2ExchangeCode: vi.fn(),
    ncOAuth2RefreshToken: vi.fn(),
    NextcloudOcsError,
    NextcloudUserExistsError,
  };
});

// The session/token storage helpers — protected routes call into them
// for legacy/NC-impersonation flows. Stub to no-ops.
vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: vi.fn(),
  getNcToken: vi.fn().mockResolvedValue(null),
  deleteNcToken: vi.fn(),
  touchNcToken: vi.fn(),
  resolveNcToken: vi.fn().mockResolvedValue("test-nc-token"),
}));

vi.mock("../services/jwt.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/jwt.service.js")>(
    "../services/jwt.service.js",
  );
  return {
    ...actual,
    // Use real signers but neutralise refresh denylist + rotation claim
    denyRefreshToken: vi.fn().mockResolvedValue(undefined),
    claimRefreshRotation: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

import { createPublicAuthRouter, createProtectedAuthRouter } from "./auth.js";
import * as nc from "../services/nextcloud.client.js";

// ── In-memory userInvite + user store ──
function createPrismaMock() {
  const rows: any[] = [];
  // WARP-485 round 2: invite-accept now upserts a local User row keyed
  // by `nextcloudUsername` before signing the JWT, so the prismaMock
  // needs a minimal `user` surface for the upsert path. Other invite
  // tests don't touch `user`, so the mock stays small.
  //
  // deriveUniqueUserId (called at invite-create time) queries
  // user.findFirst to check username uniqueness — return null so the
  // first base candidate is always available.
  const userRows: any[] = [];
  const departmentRows: any[] = [];
  const inviteDepartmentRows: any[] = [];
  let userCounter = 0;
  let counter = 0;
  // WARP-490 test scaffolding: an armable one-shot barrier that holds the
  // first N invite-by-token reads until all N have arrived, then releases
  // them together. Lets a Promise.all() accept test deterministically put
  // BOTH requests past the isUsed() snapshot check (acceptedAt still null)
  // before either runs the compare-and-swap claim — the exact interleaving
  // the CAS defends against. Without it the two supertest requests
  // serialize and the second 410s on the isUsed() fast-path, never
  // exercising (or testing) the claim itself.
  let inviteReadGate:
    | { need: number; seen: number; resolvers: Array<() => void> }
    | null = null;
  return {
    rows,
    userRows,
    departmentRows,
    inviteDepartmentRows,
    armInviteReadRace(need: number) {
      inviteReadGate = { need, seen: 0, resolvers: [] };
    },
    user: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const idx = userRows.findIndex((u) => {
          if (where?.nextcloudUsername !== undefined) {
            return u.nextcloudUsername === where.nextcloudUsername;
          }
          if (where?.id !== undefined) return u.id === where.id;
          if (where?.username !== undefined) return u.username === where.username;
          return false;
        });
        if (idx >= 0) {
          userRows[idx] = { ...userRows[idx], ...update, updatedAt: new Date() };
          return userRows[idx];
        }
        const row = {
          id: create.id ?? `u-uuid-${++userCounter}`,
          username: create.username,
          displayName: create.displayName ?? create.username,
          email: create.email ?? null,
          nextcloudUsername: create.nextcloudUsername ?? null,
          role: create.role ?? "family",
          isLocal: create.isLocal ?? true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        userRows.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.nextcloudUsername !== undefined) {
          return userRows.find((u) => u.nextcloudUsername === where.nextcloudUsername) ?? null;
        }
        if (where?.id !== undefined) return userRows.find((u) => u.id === where.id) ?? null;
        if (where?.username !== undefined) return userRows.find((u) => u.username === where.username) ?? null;
        return null;
      }),
      // deriveUniqueUserId uses findFirst to check whether a candidate
      // username is already taken. Return null (not taken) so the first
      // base candidate derived from the email local-part is always used.
      findFirst: vi.fn().mockResolvedValue(null),
      // PUT /auth/users/:username writes the directory row (email/passwordHash)
      // via updateMany keyed on nextcloudUsername (ADR-013).
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (let i = 0; i < userRows.length; i += 1) {
          const u = userRows[i];
          const match =
            (where?.nextcloudUsername !== undefined && u.nextcloudUsername === where.nextcloudUsername) ||
            (where?.username !== undefined && u.username === where.username);
          if (match) {
            userRows[i] = { ...u, ...data, updatedAt: new Date() };
            count += 1;
          }
        }
        return { count };
      }),
    },
    userInvite: {
      create: vi.fn(async ({ data }: any) => {
        if (rows.some((r) => r.token === data.token)) {
          const e: any = new Error("Unique constraint failed on token");
          e.code = "P2002";
          throw e;
        }
        const row = {
          id: `inv-${++counter}`,
          displayName: null,
          email: null,
          role: "user",
          acceptedAt: null,
          acceptedFrom: null,
          revokedAt: null,
          createdAt: new Date(),
          ...data,
        };
        rows.push(row);
        // WARP-1265: handle nested departmentGrants createMany
        if (data.departmentGrants?.createMany?.data) {
          for (const grant of data.departmentGrants.createMany.data) {
            inviteDepartmentRows.push({
              id: `grant-${inviteDepartmentRows.length}`,
              inviteId: row.id,
              ...grant,
            });
          }
        }
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const row = where?.token
          ? rows.find((r) => r.token === where.token) ?? null
          : where?.id
            ? rows.find((r) => r.id === where.id) ?? null
            : null;
        // Hold token reads at the armed barrier so racing accepts both
        // observe the pre-claim (acceptedAt: null) snapshot together.
        if (inviteReadGate && where?.token) {
          await new Promise<void>((resolve) => {
            const gate = inviteReadGate!;
            gate.resolvers.push(resolve);
            gate.seen += 1;
            if (gate.seen >= gate.need) {
              inviteReadGate = null; // one-shot; later reads pass straight through
              gate.resolvers.forEach((r) => r());
            }
          });
        }
        return row;
      }),
      findMany: vi.fn(async ({ orderBy }: any = {}) => {
        const out = [...rows];
        if (orderBy?.createdAt === "desc") {
          out.sort((a, b) => +b.createdAt - +a.createdAt);
        }
        return out;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const idx = rows.findIndex((r) => r.id === where.id || r.token === where.token);
        if (idx < 0) {
          const e: any = new Error("not found");
          e.code = "P2025";
          throw e;
        }
        rows[idx] = { ...rows[idx], ...data };
        return rows[idx];
      }),
      // WARP-490: compare-and-swap claim used by the accept handler
      // (`updateMany({ where: { id, acceptedAt: null }, data: { acceptedAt } })`).
      // The body is fully synchronous (no internal await), so two racing
      // claims serialize in the event loop: whichever reaches it first
      // flips acceptedAt (count 1); the second is filtered by the
      // `acceptedAt: null` guard and returns count 0 — exactly the DB-
      // level atomicity the real Prisma updateMany provides.
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (let i = 0; i < rows.length; i += 1) {
          const r = rows[i];
          if (where?.id !== undefined && r.id !== where.id) continue;
          if (where?.token !== undefined && r.token !== where.token) continue;
          if (where?.acceptedAt === null && r.acceptedAt !== null) continue;
          rows[i] = { ...r, ...data };
          count += 1;
        }
        return { count };
      }),
    },
    // WARP-1265: mock for userInviteDepartment queries (invite create + accept)
    userInviteDepartment: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        const filtered = inviteDepartmentRows.filter((r) => {
          if (where?.inviteId) return r.inviteId === where.inviteId;
          return true;
        });
        // Include department data for each grant
        return filtered.map((grant) => {
          const dept = departmentRows.find((d) => d.id === grant.departmentId);
          return { ...grant, department: dept };
        });
      }),
    },
    // WARP-1265: mock for department queries (invite create validation)
    department: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.id) return departmentRows.find((d) => d.id === where.id) ?? null;
        return null;
      }),
    },
  };
}

type TestUser = {
  id: string;
  username: string;
  displayName: string;
  role: "owner" | "admin" | "family" | "guest";
};

function buildApp(prismaMock: any, user: TestUser | null = adminUser()) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Public routes (accept-token) — no req.user expected.
  app.use("/api", createPublicAuthRouter(prismaMock));

  // Synthetic auth middleware for protected routes — mirrors the role we
  // want for this test instead of going through the real authMiddleware.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as any).user = user;
    next();
  });
  app.use("/api", createProtectedAuthRouter(prismaMock));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "internal" });
  });
  return app;
}

function adminUser(): TestUser {
  return { id: "admin", username: "admin-issuer", displayName: "Admin", role: "owner" };
}

function familyUser(): TestUser {
  return { id: "bob", username: "bob", displayName: "Bob", role: "family" };
}

beforeEach(() => {
  vi.clearAllMocks();
  (nc.ncCreateUser as any).mockResolvedValue(undefined);
});

describe("POST /api/auth/invites — create", () => {
  it("admin can create a user invite and gets back token + URL", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      // WARP-171: the legacy wire value "user" is preserved by the
      // zod preprocessor and coerced to the canonical Role enum value
      // "family" before it lands in the DB. Existing dashboard builds
      // that haven't updated to send the canonical name keep working.
      // ADR-013: email is now required; username is derived server-side
      // from the email local-part via deriveUniqueUserId.
      .send({ email: "alice@warp.test", displayName: "Alice", role: "user" });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(res.body.url).toContain(`/invite/${res.body.token}`);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(prisma.rows[0].createdBy).toBe("admin-issuer");
    expect(prisma.rows[0].role).toBe("family");
    // Username is derived server-side from the email local-part.
    expect(prisma.rows[0].username).toBe("alice");
  });

  it("admin can create an invite with the canonical Role enum value (WARP-171)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "alice@warp.test", displayName: "Alice", role: "family" });
    expect(res.status).toBe(200);
    expect(prisma.rows[0].role).toBe("family");
    // Username is derived server-side from the email local-part.
    expect(prisma.rows[0].username).toBe("alice");
  });

  it("non-admin gets 403", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, familyUser());
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "alice@warp.test", role: "user" });
    expect(res.status).toBe(403);
  });

  it("rejects a missing email with 400 INVALID_EMAIL", async () => {
    // ADR-013: email is the only accepted invite field for identity;
    // the handler returns INVALID_EMAIL when it is absent.
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ role: "user" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_EMAIL");
  });

  it("rejects a malformed email with 400 INVALID_EMAIL", async () => {
    // A value that is not a valid RFC email must also produce INVALID_EMAIL.
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "not-an-email", role: "user" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_EMAIL");
  });

  it("rejects invalid role values", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "alice@warp.test", role: "superuser" });
    expect(res.status).toBe(400);
  });

  it("defaults TTL to 72 hours when not provided", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const before = Date.now();
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "alice@warp.test" });
    expect(res.status).toBe(200);
    const expiry = new Date(res.body.expiresAt).getTime();
    const expected = before + 72 * 60 * 60 * 1000;
    // Allow 5s slack for slow CI.
    expect(Math.abs(expiry - expected)).toBeLessThan(5_000);
  });

  it("normalizes the invite email to trim+lowercase before persisting (BLOCKER)", async () => {
    // createInviteSchema is one of the email boundaries: the email stored
    // on the invite becomes the invitee's directory login key on accept,
    // so it must already be normalized to stay consistent with the
    // email-keyed login lookup. The derived username also comes from the
    // normalized local-part.
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "  Alice@Example.COM  " });
    expect(res.status).toBe(200);
    // WARP-233: stored as a dcv1 blob — decrypt for the assertion.
    expect(readUserEmail(prisma.rows[0].email)).toBe("alice@example.com");
    // Username is derived from the normalized email local-part.
    expect(prisma.rows[0].username).toBe("alice");
  });
});

describe("GET /api/auth/invites — list", () => {
  it("admin can list invites", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    await request(app).post("/api/auth/invites").send({ email: "alice@warp.test" });
    const res = await request(app).get("/api/auth/invites");
    expect(res.status).toBe(200);
    expect(res.body.invites).toHaveLength(1);
    // Username is derived server-side from the email local-part.
    expect(res.body.invites[0].username).toBe("alice");
  });

  it("non-admin gets 403", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, familyUser());
    const res = await request(app).get("/api/auth/invites");
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/auth/invites/:token — revoke", () => {
  it("admin can revoke; subsequent public GET returns 404", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app).post("/api/auth/invites").send({ email: "alice@warp.test" });
    const token = create.body.token;

    const del = await request(app).delete(`/api/auth/invites/${token}`);
    expect(del.status).toBe(200);
    expect(del.body.revoked).toBe(true);

    const lookup = await request(app).get(`/api/auth/invites/accept/${token}`);
    expect(lookup.status).toBe(404);
  });

  it("non-admin cannot revoke", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app).post("/api/auth/invites").send({ email: "alice@warp.test" });
    const token = create.body.token;

    const otherApp = buildApp(prisma, familyUser());
    const res = await request(otherApp).delete(`/api/auth/invites/${token}`);
    expect(res.status).toBe(403);
  });

  it("404s on unknown token", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app).delete("/api/auth/invites/does-not-exist-token");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/auth/invites/accept/:token — public lookup", () => {
  it("returns metadata for a valid pending invite (no auth required)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app)
      .post("/api/auth/invites")
      // ADR-013: email required; username derived server-side.
      .send({ email: "alice@warp.test", displayName: "Alice", role: "user" });
    const token = create.body.token;

    // Public app — no req.user
    const publicApp = buildApp(prisma, null);
    const res = await request(publicApp).get(`/api/auth/invites/accept/${token}`);
    expect(res.status).toBe(200);
    // WARP-171: the persisted role is the canonical Role enum value
    // (the preprocessor coerced "user" to "family" at create time).
    // Username is derived from the email local-part server-side.
    expect(res.body).toMatchObject({
      username: "alice",
      displayName: "Alice",
      role: "family",
    });
    expect(res.body.expiresAt).toBeDefined();
    // Token MUST NOT echo back to client (defense in depth).
    expect(res.body.token).toBeUndefined();
  });

  it("404s on unknown token", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, null);
    const res = await request(app).get("/api/auth/invites/accept/nope-not-a-real-token");
    expect(res.status).toBe(404);
  });

  it("410 GONE with code=EXPIRED when past expiresAt", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app).post("/api/auth/invites").send({ email: "alice@warp.test" });
    const token = create.body.token;

    // Force expiry by reaching into the in-memory store.
    prisma.rows[0].expiresAt = new Date(Date.now() - 1000);

    const publicApp = buildApp(prisma, null);
    const res = await request(publicApp).get(`/api/auth/invites/accept/${token}`);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe("EXPIRED");
  });

  it("410 GONE with code=USED when already accepted", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app).post("/api/auth/invites").send({ email: "alice@warp.test" });
    const token = create.body.token;
    prisma.rows[0].acceptedAt = new Date();

    const publicApp = buildApp(prisma, null);
    const res = await request(publicApp).get(`/api/auth/invites/accept/${token}`);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe("USED");
  });

  it("404 when revoked (treated as unknown)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app).post("/api/auth/invites").send({ email: "alice@warp.test" });
    const token = create.body.token;
    prisma.rows[0].revokedAt = new Date();

    const publicApp = buildApp(prisma, null);
    const res = await request(publicApp).get(`/api/auth/invites/accept/${token}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/auth/invites/accept/:token — public accept", () => {
  it("creates the Nextcloud user, marks the invite accepted, sets cookies, returns user", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    // ADR-013: email required; username ("alice") is derived server-side.
    const create = await request(app)
      .post("/api/auth/invites")
      .send({ email: "alice@warp.test", displayName: "Alice Smith", role: "user" });
    const token = create.body.token;

    const publicApp = buildApp(prisma, null);
    // Password must satisfy the policy: ≥12 chars + ≥3 character classes.
    const res = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "Accept-secret123" });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      username: "alice",
      displayName: "Alice Smith",
    });

    // Nextcloud create called with no admin group for "user" role.
    expect(nc.ncCreateUser).toHaveBeenCalledTimes(1);
    const callArgs = (nc.ncCreateUser as any).mock.calls[0];
    // The derived username is stored on the invite row and passed to NC.
    expect(callArgs[1]).toBe("alice");
    expect(callArgs[2]).toBe("Accept-secret123");
    expect(callArgs[3]).toBe("Alice Smith");
    // Groups arg: empty array OR ["users"] — but NOT including "admin".
    const groups = callArgs[4] ?? [];
    expect(groups).not.toContain("admin");

    // Invite marked accepted with audit IP.
    expect(prisma.rows[0].acceptedAt).toBeInstanceOf(Date);
    expect(typeof prisma.rows[0].acceptedFrom).toBe("string");

    // Cookies set (mirror /auth/login).
    const setCookie = res.headers["set-cookie"];
    expect(Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie)).toMatch(/droplet_session=/);
  });

  it("creates an admin invitee in the admin group", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    // ADR-013: email required; username ("carla") is derived server-side.
    const create = await request(app)
      .post("/api/auth/invites")
      .send({ email: "carla@warp.test", role: "admin" });
    const token = create.body.token;

    const publicApp = buildApp(prisma, null);
    const res = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "Accept-secret123" });
    expect(res.status).toBe(200);

    const callArgs = (nc.ncCreateUser as any).mock.calls[0];
    const groups = callArgs[4] ?? [];
    expect(groups).toContain("admin");
  });

  it("rejects a password that doesn't meet the policy", async () => {
    // Policy: ≥12 chars AND ≥3 character classes (lower, upper, digit, symbol).
    // A short all-lowercase password fails both rules.
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app).post("/api/auth/invites").send({ email: "alice@warp.test" });
    const token = create.body.token;

    const publicApp = buildApp(prisma, null);
    const res = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "short" });
    expect(res.status).toBe(400);
    expect(nc.ncCreateUser).not.toHaveBeenCalled();
  });

  it("re-accepting the same token returns 410 USED", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app).post("/api/auth/invites").send({ email: "alice@warp.test" });
    const token = create.body.token;

    const publicApp = buildApp(prisma, null);
    const first = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "Accept-secret123" });
    expect(first.status).toBe(200);

    const second = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "Accept-secret123" });
    expect(second.status).toBe(410);
    expect(second.body.code).toBe("USED");
  });

  it("re-validates reserved usernames at accept time (defense in depth)", async () => {
    // Inject a row that bypassed creation validation somehow (e.g. a
    // hand-edited or pre-migration row). The accept handler still runs
    // usernameField.safeParse on the stored username and rejects invalid
    // values before any NC or DB write.
    // Use a policy-compliant password so the password gate is not what trips.
    const prisma = createPrismaMock();
    prisma.rows.push({
      id: "inv-bad",
      token: "x".repeat(43),
      username: "admin",
      displayName: null,
      email: null,
      role: "user",
      createdBy: "someone",
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      acceptedFrom: null,
      revokedAt: null,
      createdAt: new Date(),
    });
    const app = buildApp(prisma, null);
    const res = await request(app)
      .post(`/api/auth/invites/accept/${"x".repeat(43)}`)
      .send({ password: "Accept-secret123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid username/i);
    expect(nc.ncCreateUser).not.toHaveBeenCalled();
  });

  it("404s on unknown token (no info leak)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, null);
    const res = await request(app)
      .post("/api/auth/invites/accept/totally-not-real")
      .send({ password: "Accept-secret123" });
    expect(res.status).toBe(404);
  });

  it("password-too-short response carries code=INVALID_PASSWORD", async () => {
    // Policy-failing password → 400 INVALID_PASSWORD before any invite lookup.
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app).post("/api/auth/invites").send({ email: "alice@warp.test" });
    const token = create.body.token;

    const publicApp = buildApp(prisma, null);
    const res = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PASSWORD");
  });

  it("translates ncCreateUser user-exists indicator to 409 with friendly copy", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app).post("/api/auth/invites").send({ email: "alice@warp.test" });
    const token = create.body.token;

    // Simulate the user-exists path — ncCreateUser throws a typed error
    // that the route can detect without substring-sniffing.
    const { NextcloudUserExistsError } = await import("../services/nextcloud.client.js");
    (nc.ncCreateUser as any).mockRejectedValueOnce(
      new NextcloudUserExistsError("User already exists"),
    );

    const publicApp = buildApp(prisma, null);
    const res = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "Accept-secret123" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("concurrent accepts of the same token resolve to exactly one 200 + one 410 (WARP-490 CAS)", async () => {
    // Two near-simultaneous POSTs race the single-use window. Pre-490 both
    // cleared isUsed() before either write landed, so both could reach
    // ncCreateUser (double-provision risk). The compare-and-swap on
    // acceptedAt makes the claim atomic: exactly one caller wins (200 +
    // one NC user created), the other 410s WITHOUT calling Nextcloud.
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app)
      .post("/api/auth/invites")
      .send({ email: "alice@warp.test", displayName: "Alice", role: "user" });
    const token = create.body.token;

    const publicApp = buildApp(prisma, null);
    // Hold both requests at the invite read until they've BOTH observed the
    // pending (acceptedAt: null) invite, so they genuinely race the claim
    // rather than serializing through the isUsed() fast-path.
    prisma.armInviteReadRace(2);
    const [a, b] = await Promise.all([
      request(publicApp)
        .post(`/api/auth/invites/accept/${token}`)
        .send({ password: "Accept-secret123" }),
      request(publicApp)
        .post(`/api/auth/invites/accept/${token}`)
        .send({ password: "Accept-secret123" }),
    ]);

    // Exactly one winner, one loser — order is non-deterministic.
    expect([a.status, b.status].sort()).toEqual([200, 410]);
    const loser = a.status === 410 ? a : b;
    expect(loser.body.code).toBe("USED");

    // The loser never touched Nextcloud: exactly one NC user provisioned
    // across both requests, and the invite is marked accepted exactly once.
    expect(nc.ncCreateUser).toHaveBeenCalledTimes(1);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].acceptedAt).not.toBeNull();
  });
});

describe("POST /api/auth/users — admin createUser typed user-exists detection", () => {
  it("returns 409 with friendly copy when ncCreateUser throws NextcloudUserExistsError", async () => {
    // ADR-013: email is the required body field; username is derived server-side.
    // Password must satisfy the policy (≥12 chars + ≥3 classes).
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const { NextcloudUserExistsError } = await import("../services/nextcloud.client.js");
    (nc.ncCreateUser as any).mockRejectedValueOnce(
      new NextcloudUserExistsError("User already exists"),
    );

    const res = await request(app)
      .post("/api/auth/users")
      .send({
        email: "alice@warp.test",
        password: "Accept-secret123",
        displayName: "Alice",
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("does NOT translate generic NextcloudOcsError messages that merely contain '102'", async () => {
    // Defense in depth: if an unrelated error happens to mention '102' in
    // its message, we should NOT downgrade it to 409. The route must
    // discriminate by error type, not substring.
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    (nc.ncCreateUser as any).mockRejectedValueOnce(
      new Error("flap, request id 1023, please retry"),
    );

    const res = await request(app)
      .post("/api/auth/users")
      .send({
        email: "alice@warp.test",
        password: "Accept-secret123",
        displayName: "Alice",
      });
    // Falls through to the next() handler → default 500.
    expect(res.status).toBe(500);
  });

  it("happy path returns 201 status=ok", async () => {
    // Username is derived server-side from the email local-part.
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    (nc.ncCreateUser as any).mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post("/api/auth/users")
      .send({
        email: "alice@warp.test",
        password: "Accept-secret123",
        displayName: "Alice",
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: "ok", username: "alice" });
  });
});

describe("PUT /api/auth/users/:username — email normalization (BLOCKER)", () => {
  it("forwards a trim+lowercased email to Nextcloud AND the local directory row", async () => {
    const prisma = createPrismaMock();
    // ADR-013: the edit route now writes the local directory row, so the
    // edited user must exist locally (else 404). Seed it.
    prisma.userRows.push({
      id: "u-alice",
      username: "alice",
      nextcloudUsername: "alice",
      displayName: "Alice",
      email: "alice@old.test",
      passwordHash: "$argon2id$OLD",
      role: "family",
      isLocal: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = buildApp(prisma);

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ email: "  Alice@Example.COM  " });

    expect(res.status).toBe(200);
    expect(nc.ncUpdateUser).toHaveBeenCalledWith(
      "test-nc-token",
      "alice",
      "email",
      "alice@example.com",
    );
    // The normalized email is also written to the local row (the login key).
    // WARP-233: stored as a dcv1 blob — decrypt for the assertion.
    expect(readUserEmail(prisma.userRows[0].email)).toBe("alice@example.com");
  });
});

describe("POST /api/auth/invites — department grants (WARP-1265)", () => {
  const deptEngId = "550e8400-e29b-41d4-a716-446655440001";
  const deptSalesId = "550e8400-e29b-41d4-a716-446655440002";
  const householdDeptId = "550e8400-e29b-41d4-a716-446655440003";

  it("admin can create invite with department grants", async () => {
    const prisma = createPrismaMock();
    // Set up a mock active department
    prisma.departmentRows.push({
      id: deptEngId,
      name: "Engineering",
      state: "active",
      kind: "DEPARTMENT",
    });

    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({
        email: "alice@warp.test",
        displayName: "Alice",
        role: "family",
        departments: [
          { departmentId: deptEngId, right: "contributor" },
        ],
      });

    expect(res.status).toBe(200);
    expect(prisma.inviteDepartmentRows).toHaveLength(1);
    expect(prisma.inviteDepartmentRows[0]).toMatchObject({
      departmentId: deptEngId,
      right: "contributor",
    });
  });

  it("rejects invite with non-existent department (400)", async () => {
    const prisma = createPrismaMock();
    const badDeptId = "550e8400-e29b-41d4-a716-446655440099";
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({
        email: "alice@warp.test",
        departments: [
          { departmentId: badDeptId, right: "contributor" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DEPARTMENT_NOT_FOUND");
  });

  it("rejects invite with archived department (400)", async () => {
    const prisma = createPrismaMock();
    const archivedDeptId = "550e8400-e29b-41d4-a716-446655440004";
    prisma.departmentRows.push({
      id: archivedDeptId,
      name: "Old Dept",
      state: "archived",
      kind: "DEPARTMENT",
    });

    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({
        email: "alice@warp.test",
        departments: [
          { departmentId: archivedDeptId, right: "contributor" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DEPARTMENT_NOT_ACTIVE");
  });

  it("rejects invite with household department (400)", async () => {
    const prisma = createPrismaMock();
    prisma.departmentRows.push({
      id: householdDeptId,
      name: "Household",
      state: "active",
      kind: "HOUSEHOLD",
    });

    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({
        email: "alice@warp.test",
        departments: [
          { departmentId: householdDeptId, right: "contributor" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("HOUSEHOLD_NOT_INVITABLE");
  });

  it("defaults department right to contributor when not specified", async () => {
    const prisma = createPrismaMock();
    prisma.departmentRows.push({
      id: deptEngId,
      name: "Engineering",
      state: "active",
      kind: "DEPARTMENT",
    });

    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({
        email: "alice@warp.test",
        departments: [
          { departmentId: deptEngId }, // no right specified
        ],
      });

    if (res.status !== 200) {
      console.log("Response body:", res.body);
    }
    expect(res.status).toBe(200);
    expect(prisma.inviteDepartmentRows[0].right).toBe("contributor");
  });

  it("can create invite with multiple department grants", async () => {
    const prisma = createPrismaMock();
    prisma.departmentRows.push(
      { id: deptEngId, name: "Engineering", state: "active", kind: "DEPARTMENT" },
      { id: deptSalesId, name: "Sales", state: "active", kind: "DEPARTMENT" },
    );

    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({
        email: "alice@warp.test",
        departments: [
          { departmentId: deptEngId, right: "contributor" },
          { departmentId: deptSalesId, right: "reader" },
        ],
      });

    if (res.status !== 200) {
      console.log("Multiple grants response body:", res.body);
    }
    expect(res.status).toBe(200);
    expect(prisma.inviteDepartmentRows).toHaveLength(2);
    expect(prisma.inviteDepartmentRows[0]).toMatchObject({
      departmentId: deptEngId,
      right: "contributor",
    });
    expect(prisma.inviteDepartmentRows[1]).toMatchObject({
      departmentId: deptSalesId,
      right: "reader",
    });
  });
});
