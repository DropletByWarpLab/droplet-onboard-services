/**
 * ADR-013 — invite-accept writes the argon2id hash to the directory, and
 * the invited member can then sign in via the email-keyed /auth/login.
 *
 * Context: PR #374 inverted authentication to a built-in argon2id directory
 * — /auth/login now resolves the User by email and verifies the password
 * LOCALLY against User.passwordHash (Nextcloud no longer authenticates).
 * ADR-013's stated consequence is that BOTH /auth/setup AND invite-accept
 * write the argon2id passwordHash directly. PR #374 only covered the
 * first-owner /auth/setup path; the invite-accept route
 * (POST /auth/invites/accept/:token) was flagged [High, non-blocking] in
 * that PR's review for NOT writing the hash — which lands every invited
 * member with passwordHash = null and therefore unable to sign in (login
 * fails closed when the hash is null). This test pins the fix.
 *
 * Coverage — a genuine end-to-end round-trip:
 *   1. Accepting an invite stores a real argon2id PHC string on the
 *      directory row (User.passwordHash matches /^\$argon2id\$/) — never
 *      the plaintext.
 *   2. The invited member can then authenticate via the email-keyed
 *      /auth/login using the password they chose at accept — 200, and the
 *      session JWT.sub is the SAME local User.id UUID minted at accept
 *      (WARP-485 preserved).
 *   3. A wrong password for that member is rejected with 401 — proving the
 *      stored hash actually gates login (not a vacuous pass).
 *
 * Strategy mirrors auth.directory-setup.test.ts (same NC / nc-session / jwt
 * / activity mocks, an in-memory Prisma stand-in, and a supertest-driven
 * real route). UNLIKE that test, it does NOT mock password.service: it
 * exercises the REAL argon2id hash + verify so "the invitee can
 * authenticate" is a true crypto round-trip — consistent with
 * auth.invites.test.ts, which also runs the real service for the accept
 * flow. argon2's own correctness is unit-tested in password.service.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";

// ── Config mock — must be hoisted above route imports. ──
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "legacy",
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 604800,
    DEVICE_SECRET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    REDIS_URL: "redis://localhost:6379",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
  },
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

const storeNcToken = vi.fn().mockResolvedValue(undefined);
const getNcToken = vi.fn().mockResolvedValue(null);
const deleteNcToken = vi.fn().mockResolvedValue(undefined);
const touchNcToken = vi.fn().mockResolvedValue(undefined);
const resolveNcToken = vi.fn().mockResolvedValue("test-nc-token");
vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: (...args: unknown[]) => storeNcToken(...args),
  getNcToken: (...args: unknown[]) => getNcToken(...args),
  deleteNcToken: (...args: unknown[]) => deleteNcToken(...args),
  touchNcToken: (...args: unknown[]) => touchNcToken(...args),
  resolveNcToken: (...args: unknown[]) => resolveNcToken(...args),
}));

vi.mock("../services/jwt.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/jwt.service.js")>(
    "../services/jwt.service.js",
  );
  return {
    ...actual,
    // Real signers/verifiers; neutralise the refresh denylist + rotation
    // claim so we don't reach Redis.
    denyRefreshToken: vi.fn().mockResolvedValue(undefined),
    claimRefreshRotation: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

// NOTE: password.service is deliberately NOT mocked — this test runs the
// real argon2id hash + verify so the accept→login round-trip is genuine.

import { createPublicAuthRouter, createProtectedAuthRouter } from "./auth.js";
import * as nc from "../services/nextcloud.client.js";
import { verifyAccessToken } from "../services/jwt.service.js";

// ── In-memory Prisma stand-in: user + userInvite surfaces ──
function createPrismaMock() {
  const users: any[] = [];
  const invites: any[] = [];
  let userCounter = 0;
  let inviteCounter = 0;
  const self: any = {};
  self.user = {
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const idx = users.findIndex(
        (u) =>
          (where?.nextcloudUsername !== undefined &&
            u.nextcloudUsername === where.nextcloudUsername) ||
          (where?.email !== undefined && u.email === where.email) ||
          (where?.id !== undefined && u.id === where.id) ||
          (where?.username !== undefined && u.username === where.username),
      );
      if (idx >= 0) {
        users[idx] = { ...users[idx], ...update, updatedAt: new Date() };
        return users[idx];
      }
      // Spread `...create` so whatever the route writes (incl. passwordHash)
      // lands on the row — the whole point of this test is to observe that.
      const row = {
        id: create.id ?? `u-uuid-${++userCounter}`,
        isLocal: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...create,
      };
      users.push(row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      if (where?.email !== undefined)
        return users.find((u) => u.email === where.email) ?? null;
      if (where?.nextcloudUsername !== undefined)
        return users.find((u) => u.nextcloudUsername === where.nextcloudUsername) ?? null;
      if (where?.id !== undefined) return users.find((u) => u.id === where.id) ?? null;
      if (where?.username !== undefined)
        return users.find((u) => u.username === where.username) ?? null;
      return null;
    }),
  };
  self.userInvite = {
    create: vi.fn(async ({ data }: any) => {
      if (invites.some((r) => r.token === data.token)) {
        const e: any = new Error("Unique constraint failed on token");
        e.code = "P2002";
        throw e;
      }
      const row = {
        id: `inv-${++inviteCounter}`,
        displayName: null,
        email: null,
        role: "family",
        acceptedAt: null,
        acceptedFrom: null,
        revokedAt: null,
        createdAt: new Date(),
        ...data,
      };
      invites.push(row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      if (where?.token) return invites.find((r) => r.token === where.token) ?? null;
      if (where?.id) return invites.find((r) => r.id === where.id) ?? null;
      return null;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const idx = invites.findIndex((r) => r.id === where.id || r.token === where.token);
      if (idx < 0) {
        const e: any = new Error("not found");
        e.code = "P2025";
        throw e;
      }
      invites[idx] = { ...invites[idx], ...data };
      return invites[idx];
    }),
  };
  // PR #375 — the directory /auth/login route now consults the TOTP
  // second-factor gate before issuing a session: it reads
  // `prisma.totpCredential.findUnique({ where: { userId } })` and only
  // gates when a CONFIRMED credential exists. A freshly-invited member has
  // no TOTP row, so this stub returns null and login proceeds exactly as it
  // did pre-#375 (200 round-trip). `recoveryCode` is stubbed for the same
  // reason — the gate never reaches it on the no-TOTP path, but defining the
  // delegate keeps the mock faithful to the real client surface so a future
  // edit to the gate can't 500 on an undefined delegate.
  self.totpCredential = {
    findUnique: vi.fn(async () => null),
  };
  self.recoveryCode = {
    findMany: vi.fn(async () => []),
    updateMany: vi.fn(async () => ({ count: 0 })),
  };
  self._users = users;
  self._invites = invites;
  return self;
}

type TestUser = {
  id: string;
  username: string;
  displayName: string;
  role: "owner" | "admin" | "family" | "guest";
};

function adminUser(): TestUser {
  return { id: "admin", username: "admin-issuer", displayName: "Admin", role: "owner" };
}

function buildApp(prismaMock: any, user: TestUser | null = adminUser()) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Public routes (accept-token + login) — no req.user expected.
  app.use("/api", createPublicAuthRouter(prismaMock));

  // Synthetic auth middleware for the protected create-invite route —
  // mirrors auth.invites.test.ts so we can issue an invite as an admin.
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

/** Issue an invite via the admin endpoint and return its token. */
async function issueInvite(app: express.Express, body: Record<string, unknown>) {
  const res = await request(app).post("/api/auth/invites").send(body);
  expect(res.status).toBe(200);
  return res.body.token as string;
}

/** Decode the droplet_session cookie's access JWT off a response. */
function sessionJwt(res: request.Response) {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const sessionCookie = cookies.find((c) => c?.startsWith("droplet_session="));
  if (!sessionCookie) throw new Error("droplet_session cookie not set");
  const raw = sessionCookie.split(";")[0]!.replace("droplet_session=", "");
  const decoded = verifyAccessToken(raw);
  if (!decoded) throw new Error("verifyAccessToken returned null");
  return decoded;
}

const INVITE = {
  username: "alice",
  displayName: "Alice Smith",
  email: "alice@warp.test",
  role: "family",
} as const;
const INVITE_PASSWORD = "invite-secret-pw"; // ≥ 8 chars (acceptInviteSchema)

beforeEach(() => {
  vi.clearAllMocks();
  (nc.ncCreateUser as any).mockResolvedValue(undefined);
  // After a successful LOCAL auth, login provisions a downstream NC session.
  (nc.ncLoginWithCredentials as any).mockResolvedValue({
    token: "nc-app-password",
    loginName: "alice",
  });
  storeNcToken.mockResolvedValue(undefined);
});

describe("ADR-013 — invite-accept writes the argon2id hash to the directory", () => {
  it("stores a real $argon2id$ PHC hash on the invited member's row (never the plaintext)", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), { ...INVITE });

    const res = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });
    expect(res.status).toBe(200);

    const row = prisma._users.find((u: any) => u.email === "alice@warp.test");
    expect(row).toBeDefined();
    // The directory is the auth source of truth — accept must persist the
    // argon2id hash (same as /auth/setup), not leave it null.
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    // The hash is not the plaintext, and the plaintext never lands anywhere
    // on the row.
    expect(row.passwordHash).not.toContain(INVITE_PASSWORD);
    expect(JSON.stringify(row)).not.toContain(INVITE_PASSWORD);
  });

  it("lets the invited member then sign in via the email-keyed /auth/login (true round-trip)", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), { ...INVITE });

    const publicApp = buildApp(prisma, null);
    const accept = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });
    expect(accept.status).toBe(200);
    const acceptedUserId = accept.body.user.id as string;

    // Authenticate exactly as the Aurora sign-in does: email + password.
    const login = await request(publicApp)
      .post("/api/auth/login")
      .send({ email: "alice@warp.test", password: INVITE_PASSWORD });

    expect(login.status).toBe(200);
    // Session is keyed to the SAME local UUID minted at accept (WARP-485),
    // resolved through the email-keyed directory lookup.
    const decoded = sessionJwt(login);
    expect(decoded.sub).toBe(acceptedUserId);
    expect(decoded.username).toBe("alice");
    expect(login.body.user.id).toBe(acceptedUserId);
  });

  it("rejects a wrong password for the invited member (the stored hash gates login)", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), { ...INVITE });

    const publicApp = buildApp(prisma, null);
    await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });

    const login = await request(publicApp)
      .post("/api/auth/login")
      .send({ email: "alice@warp.test", password: "the-wrong-password" });

    expect(login.status).toBe(401);
    expect(login.body.error).toBe("Invalid credentials");
    expect(login.headers["set-cookie"]).toBeUndefined();
  });
});
