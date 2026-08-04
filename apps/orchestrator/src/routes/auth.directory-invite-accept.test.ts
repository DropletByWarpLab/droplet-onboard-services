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
import { readUserEmail } from "../services/user-directory.service.js";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";

// ── Config mock — must be hoisted above route imports. ──
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "legacy",
    NEXTCLOUD_URL: "http://nextcloud.test",
    DROPLET_SHARED_FOLDER_NAME: "Household",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 604800,
    DEVICE_SECRET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    REDIS_URL: "redis://localhost:6379",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
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
    // WARP-1558: an admin-tier invite now lands its holder in
    // `droplet-admins`, which the route ensures exists first.
    ncEnsureGroup: vi.fn().mockResolvedValue(undefined),
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
      // WARP-233: the accepted row carries the blind index — login resolves it.
      if (where?.emailLookupHash !== undefined)
        return users.find((u: any) => u.emailLookupHash === where.emailLookupHash) ?? null;
      if (where?.email !== undefined)
        return users.find((u) => u.email === where.email) ?? null;
      if (where?.nextcloudUsername !== undefined)
        return users.find((u) => u.nextcloudUsername === where.nextcloudUsername) ?? null;
      if (where?.id !== undefined) return users.find((u) => u.id === where.id) ?? null;
      if (where?.username !== undefined)
        return users.find((u) => u.username === where.username) ?? null;
      return null;
    }),
    // deriveUniqueUserId queries findFirst to check username uniqueness.
    findFirst: vi.fn(async ({ where }: any) => {
      const orClauses = where?.OR ?? [];
      return (
        users.find((u) =>
          orClauses.some(
            (clause: any) =>
              (clause.username !== undefined && u.username === clause.username) ||
              (clause.nextcloudUsername !== undefined &&
                u.nextcloudUsername === clause.nextcloudUsername),
          ),
        ) ?? null
      );
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
    // WARP-490: compare-and-swap single-use claim the accept handler now uses
    // (`updateMany({ where: { id, acceptedAt: null }, data: { acceptedAt } })`)
    // BEFORE creating the Nextcloud user. The body is fully synchronous (no
    // internal await), so two racing claims serialize in the event loop:
    // whichever reaches it first flips acceptedAt (count 1); the second is
    // filtered by the `acceptedAt: null` guard and returns count 0 — exactly
    // the DB-level atomicity the real Prisma updateMany provides. Every test
    // in this file accepts a fresh (acceptedAt === null) invite, so the claim
    // wins (count 1) and the endpoint proceeds to 200; an already-accepted
    // row would fall through to count 0 and the handler's 410 USED branch.
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (let i = 0; i < invites.length; i += 1) {
        const r = invites[i];
        if (where?.id !== undefined && r.id !== where.id) continue;
        if (where?.token !== undefined && r.token !== where.token) continue;
        if (where?.acceptedAt === null && r.acceptedAt !== null) continue;
        invites[i] = { ...r, ...data };
        count += 1;
      }
      return { count };
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
  displayName: "Alice Smith",
  email: "alice@warp.test",
  role: "family",
} as const;
// Policy-compliant: ≥12 chars, 3-of-4 classes (lower, upper, digit, symbol).
const INVITE_PASSWORD = "Accept-secret123";

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

    const row = prisma._users.find((u: any) => readUserEmail(u.email) === "alice@warp.test");
    expect(row).toBeDefined();
    // The directory is the auth source of truth — accept must persist the
    // argon2id hash (same as /auth/setup), not leave it null.
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    // The hash is not the plaintext, and the plaintext never lands anywhere
    // on the row.
    expect(row.passwordHash).not.toContain(INVITE_PASSWORD);
    expect(JSON.stringify(row)).not.toContain(INVITE_PASSWORD);

    // WARP-883: the invitee (family role) is added to the household group so
    // the shared "Household" group folder mounts into their home.
    const groupsArg = (nc.ncCreateUser as any).mock.calls[0]?.[4] as string[];
    expect(groupsArg).toContain("household");
    // WARP-1558: …and NOT to droplet-admins — this invite is family-tier.
    expect(groupsArg).not.toContain("droplet-admins");
  });

  /**
   * WARP-1558 — invite-accept is a create path too, so an invite that starts
   * its holder at an admin-tier role must land them in `droplet-admins`.
   * Before this, an admin onboarded purely by invite had ADR-029 §2.5 Tier-1
   * see-all only if someone later changed their role — the same create-path
   * hole that left the .87 box's group empty.
   */
  it("an admin-role invite lands its holder in droplet-admins (ensure precedes create)", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), {
      displayName: "Morpheus",
      email: "morpheus@warp.test",
      role: "admin",
    });

    const res = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });
    expect(res.status).toBe(200);

    const groupsArg = (nc.ncCreateUser as any).mock.calls[0]?.[4] as string[];
    expect(groupsArg).toContain("droplet-admins");
    expect(nc.ncEnsureGroup).toHaveBeenCalledWith("droplet-admins");
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

  it("rejects a weak accept password with 400 INVALID_PASSWORD", async () => {
    // A password that is long enough (≥8 chars) but fails the 3-of-4 class
    // policy must return 400 with code INVALID_PASSWORD so the dashboard
    // can surface the policy hint.
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), { ...INVITE });

    const res = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "weakpassword" }); // all-lowercase, no digits/symbols

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PASSWORD");
  });
});

describe("Fix B — invite-accept upsert refreshes email on the UPDATE path (re-acceptance)", () => {
  it("overwrites a stale email on re-acceptance so the email-keyed login still resolves", async () => {
    const prisma = createPrismaMock();

    // Issue an invite with the fresh email.
    const token = await issueInvite(buildApp(prisma), {
      displayName: "Bob Re-accept",
      email: "fresh@warp.test",
      role: "family",
    });

    // The invite derives the username from the email prefix: "fresh@warp.test"
    // → nextcloudUsername "fresh". Seed an existing User row with a STALE
    // email under that same nextcloudUsername so the upsert hits the UPDATE path.
    const existingRow = {
      id: "u-existing-fresh",
      username: "fresh",
      nextcloudUsername: "fresh",
      displayName: "Fresh Old",
      email: "stale@old.test",
      passwordHash: "$argon2id$STALE-HASH",
      role: "family",
      isLocal: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prisma._users.push(existingRow);

    // ncLoginWithCredentials is called after a successful accept.
    (nc.ncLoginWithCredentials as any).mockResolvedValue({
      token: "nc-app-password",
      loginName: "fresh",
    });

    const publicApp = buildApp(prisma, null);
    const accept = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });

    expect(accept.status).toBe(200);

    // The UPDATE path must have refreshed the email column — the row should
    // now carry the invite's fresh email, not the stale one.
    const row = prisma._users.find((u: any) => u.nextcloudUsername === "fresh");
    expect(row).toBeDefined();
    expect(readUserEmail(row.email)).toBe("fresh@warp.test");
    // Verify that the old stale email is gone.
    expect(row.email).not.toBe("stale@old.test");
  });
});

// WARP-1051 — session-role mapping must not diverge by account-creation
// path. /auth/login uses the raw User.role, and the refresh path re-derives
// from the DB row (WARP-116), so the old accept-time admin→owner promotion
// gave an invited admin an "owner" session that silently downgraded to
// "admin" at the first token rotation — and let an admin-minted admin
// invite yield an owner session, defeating the ROLE_RANK_EXCEEDED guard.
// The invite's canonical role is now the session role on every path.
describe("WARP-1051 — invite-accept session role matches the canonical invite role", () => {
  it("an admin invite mints an 'admin' session (not 'owner') and role survives re-login", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), {
      displayName: "Morpheus",
      email: "morpheus@warp.test",
      role: "admin",
    });

    const publicApp = buildApp(prisma, null);
    const accept = await request(publicApp)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });

    expect(accept.status).toBe(200);
    // Response body and the minted access JWT agree: admin, not owner.
    expect(accept.body.user.role).toBe("admin");
    expect(sessionJwt(accept).role).toBe("admin");
    // The DB row carries the canonical role too.
    const row = prisma._users.find(
      (u: any) => readUserEmail(u.email) === "morpheus@warp.test",
    );
    expect(row.role).toBe("admin");

    // Convergence: a normal /auth/login for the same account yields the
    // SAME session role the accept path minted.
    (nc.ncLoginWithCredentials as any).mockResolvedValue({
      token: "nc-app-password",
      loginName: "morpheus",
    });
    const login = await request(publicApp)
      .post("/api/auth/login")
      .send({ email: "morpheus@warp.test", password: INVITE_PASSWORD });
    expect(login.status).toBe(200);
    expect(sessionJwt(login).role).toBe("admin");
  });

  it("a PRE-EXISTING owner invite row still mints an 'owner' session (accept passthrough unchanged)", async () => {
    // WARP-1526 fixture note: POST /auth/invites can no longer MINT an
    // owner invite (403 ROLE_NOT_ASSIGNABLE — invites only assign
    // {admin, family, guest}), so this spec seeds the invite row directly:
    // rows created before the narrowing landed can still be pending in the
    // DB, and the WARP-1051 contract — accept grants the invite's CANONICAL
    // role as the session role, no silent remapping — must keep holding
    // for them. The accept path itself is untouched by WARP-1526.
    const prisma = createPrismaMock();
    const token = "legacy-owner-invite-token";
    await prisma.userInvite.create({
      data: {
        token,
        displayName: "Trinity",
        email: "trinity@warp.test",
        username: "trinity",
        role: "owner",
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        createdBy: "admin-issuer",
      },
    });

    const accept = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });

    expect(accept.status).toBe(200);
    expect(accept.body.user.role).toBe("owner");
    expect(sessionJwt(accept).role).toBe("owner");
  });

  it("a guest invite still mints a 'guest' session", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), {
      displayName: "Mouse",
      email: "mouse@warp.test",
      role: "guest",
    });

    const accept = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });

    expect(accept.status).toBe(200);
    expect(accept.body.user.role).toBe("guest");
    expect(sessionJwt(accept).role).toBe("guest");
  });
});

describe("invite-accept auto-login provisions the Nextcloud session token", () => {
  // The accept handler auto-logs the invitee in ("same shape as
  // /api/auth/login") and it holds the plaintext password it just gave
  // ncCreateUser — so it must ALSO seed the per-user NC app-password the
  // way /auth/login does. Without this, the invitee's first session has no
  // Redis-stored NC credential: every file tool the AI chat dispatches
  // (read_file, list_files, ...) returns AUTH_REQUIRED and the Files app
  // 401s until they log out and back in.
  it("mints an NC app-password with the chosen password and stores it under the local UUID", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), { ...INVITE });

    const accept = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });
    expect(accept.status).toBe(200);
    const acceptedUserId = accept.body.user.id as string;

    expect(nc.ncLoginWithCredentials).toHaveBeenCalledWith("alice", INVITE_PASSWORD);
    // Keyed by the local User.id UUID (WARP-485), same TTL as /auth/login.
    expect(storeNcToken).toHaveBeenCalledWith(acceptedUserId, "nc-app-password", 604800);
  });

  it("still accepts (200, session minted) when NC session provisioning fails — fail-open like /auth/login", async () => {
    const prisma = createPrismaMock();
    const token = await issueInvite(buildApp(prisma), { ...INVITE });

    (nc.ncLoginWithCredentials as any).mockRejectedValueOnce(new Error("nextcloud is down"));

    const accept = await request(buildApp(prisma, null))
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: INVITE_PASSWORD });

    expect(accept.status).toBe(200);
    expect(sessionJwt(accept).username).toBe("alice");
    expect(storeNcToken).not.toHaveBeenCalled();
  });
});
