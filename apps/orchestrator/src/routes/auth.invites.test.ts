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
  const userRows: any[] = [];
  let userCounter = 0;
  let counter = 0;
  return {
    rows,
    userRows,
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
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.token) return rows.find((r) => r.token === where.token) ?? null;
        if (where?.id) return rows.find((r) => r.id === where.id) ?? null;
        return null;
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
      .send({ username: "alice", displayName: "Alice", role: "user" });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(res.body.url).toContain(`/invite/${res.body.token}`);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(prisma.rows[0].createdBy).toBe("admin-issuer");
    expect(prisma.rows[0].role).toBe("family");
  });

  it("admin can create an invite with the canonical Role enum value (WARP-171)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ username: "alice", displayName: "Alice", role: "family" });
    expect(res.status).toBe(200);
    expect(prisma.rows[0].role).toBe("family");
  });

  it("non-admin gets 403", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, familyUser());
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ username: "alice", role: "user" });
    expect(res.status).toBe(403);
  });

  it("rejects reserved usernames (admin, root)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    for (const u of ["admin", "root", "ROOT"]) {
      const res = await request(app)
        .post("/api/auth/invites")
        .send({ username: u, role: "user" });
      expect(res.status).toBe(400);
    }
  });

  it("rejects invalid role values", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ username: "alice", role: "superuser" });
    expect(res.status).toBe(400);
  });

  it("defaults TTL to 72 hours when not provided", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const before = Date.now();
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ username: "alice" });
    expect(res.status).toBe(200);
    const expiry = new Date(res.body.expiresAt).getTime();
    const expected = before + 72 * 60 * 60 * 1000;
    // Allow 5s slack for slow CI.
    expect(Math.abs(expiry - expected)).toBeLessThan(5_000);
  });

  it("rejects username failing the regex", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ username: "has spaces", role: "user" });
    expect(res.status).toBe(400);
  });

  it("normalizes the invite email to trim+lowercase before persisting (BLOCKER)", async () => {
    // createInviteSchema is one of the email boundaries: the email stored
    // on the invite becomes the invitee's directory login key on accept,
    // so it must already be normalized to stay consistent with the
    // email-keyed login lookup.
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/invites")
      .send({ username: "alice", email: "  Alice@Example.COM  " });
    expect(res.status).toBe(200);
    expect(prisma.rows[0].email).toBe("alice@example.com");
  });
});

describe("GET /api/auth/invites — list", () => {
  it("admin can list invites", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    await request(app).post("/api/auth/invites").send({ username: "alice" });
    const res = await request(app).get("/api/auth/invites");
    expect(res.status).toBe(200);
    expect(res.body.invites).toHaveLength(1);
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
    const create = await request(app).post("/api/auth/invites").send({ username: "alice" });
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
    const create = await request(app).post("/api/auth/invites").send({ username: "alice" });
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
      .send({ username: "alice", displayName: "Alice", role: "user" });
    const token = create.body.token;

    // Public app — no req.user
    const publicApp = buildApp(prisma, null);
    const res = await request(publicApp).get(`/api/auth/invites/accept/${token}`);
    expect(res.status).toBe(200);
    // WARP-171: the persisted role is the canonical Role enum value
    // (the preprocessor coerced "user" to "family" at create time).
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
    const create = await request(app).post("/api/auth/invites").send({ username: "alice" });
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
    const create = await request(app).post("/api/auth/invites").send({ username: "alice" });
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
    const create = await request(app).post("/api/auth/invites").send({ username: "alice" });
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
    const create = await request(app)
      .post("/api/auth/invites")
      .send({ username: "alice", displayName: "Alice Smith", role: "user" });
    const token = create.body.token;

    const publicApp = buildApp(prisma, null);
    const res = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "longenoughpw" });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      username: "alice",
      displayName: "Alice Smith",
    });

    // Nextcloud create called with no admin group for "user" role.
    expect(nc.ncCreateUser).toHaveBeenCalledTimes(1);
    const callArgs = (nc.ncCreateUser as any).mock.calls[0];
    expect(callArgs[1]).toBe("alice");
    expect(callArgs[2]).toBe("longenoughpw");
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
    const create = await request(app)
      .post("/api/auth/invites")
      .send({ username: "carla", role: "admin" });
    const token = create.body.token;

    const publicApp = buildApp(prisma, null);
    const res = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "longenoughpw" });
    expect(res.status).toBe(200);

    const callArgs = (nc.ncCreateUser as any).mock.calls[0];
    const groups = callArgs[4] ?? [];
    expect(groups).toContain("admin");
  });

  it("rejects password shorter than 8 chars", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app).post("/api/auth/invites").send({ username: "alice" });
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
    const create = await request(app).post("/api/auth/invites").send({ username: "alice" });
    const token = create.body.token;

    const publicApp = buildApp(prisma, null);
    const first = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "longenoughpw" });
    expect(first.status).toBe(200);

    const second = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "anotherpw" });
    expect(second.status).toBe(410);
    expect(second.body.code).toBe("USED");
  });

  it("re-validates reserved usernames at accept time (defense in depth)", async () => {
    // Inject a row that bypassed creation validation somehow.
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
      .send({ password: "longenoughpw" });
    expect(res.status).toBe(400);
    expect(nc.ncCreateUser).not.toHaveBeenCalled();
  });

  it("404s on unknown token (no info leak)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, null);
    const res = await request(app)
      .post("/api/auth/invites/accept/totally-not-real")
      .send({ password: "longenoughpw" });
    expect(res.status).toBe(404);
  });

  it("password-too-short response carries code=INVALID_PASSWORD", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const create = await request(app).post("/api/auth/invites").send({ username: "alice" });
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
    const create = await request(app).post("/api/auth/invites").send({ username: "alice" });
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
      .send({ password: "longenoughpw" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });
});

describe("POST /api/auth/users — admin createUser typed user-exists detection", () => {
  it("returns 409 with friendly copy when ncCreateUser throws NextcloudUserExistsError", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const { NextcloudUserExistsError } = await import("../services/nextcloud.client.js");
    (nc.ncCreateUser as any).mockRejectedValueOnce(
      new NextcloudUserExistsError("User already exists"),
    );

    const res = await request(app)
      .post("/api/auth/users")
      .send({
        username: "alice",
        password: "longenoughpw",
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
        username: "alice",
        password: "longenoughpw",
        displayName: "Alice",
      });
    // Falls through to the next() handler → default 500.
    expect(res.status).toBe(500);
  });

  it("happy path returns 201 status=ok", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    (nc.ncCreateUser as any).mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post("/api/auth/users")
      .send({
        username: "alice",
        password: "longenoughpw",
        displayName: "Alice",
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: "ok", username: "alice" });
  });
});

describe("PUT /api/auth/users/:username — email normalization (BLOCKER)", () => {
  it("forwards a trim+lowercased email to Nextcloud (updateUserSchema boundary)", async () => {
    const prisma = createPrismaMock();
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
  });
});
