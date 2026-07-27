/**
 * WARP-485 round 2 — JWT-path UUID normalization.
 *
 * Round 1 fixed the OCS auth path so `req.user.id` is the local
 * `User.id` UUID after middleware runs (see
 * `apps/orchestrator/src/__tests__/auth.req-user-id.test.ts`). Round 2
 * extends the same shape to the JWT *signing* path — login, refresh,
 * and invite-accept now resolve the local User row by
 * `nextcloudUsername` BEFORE feeding `signAccessToken({ id })`, and
 * fail-closed with 401 `USER_NOT_PROVISIONED` when no row matches.
 *
 * Coverage:
 *   1. /auth/login → JWT.sub === localUser.id UUID (not NC username).
 *   2. /auth/login + no local User row → 401 USER_NOT_PROVISIONED.
 *   3. /auth/login → NC token stored under the UUID key (not NC username).
 *   4. /auth/refresh → JWT.sub stays UUID across rotation; missing User → 401.
 *   5. /auth/invites/accept → JWT.sub is the newly-provisioned local UUID.
 *   6. /auth/logout → NC token deleted by UUID key.
 *
 * Strategy: drive the real route handlers via supertest. Mock the
 * Nextcloud client (no live OCS in tests), neutralise the Redis
 * denylist + rotation claim, and stub the nc-session helpers so we
 * can assert the key they're called with.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "password",
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
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
    ncInstallAndCreateAdmin: vi.fn(),
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

// Capture every NC-token store/fetch call so we can assert the key shape.
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
    // Use real signers but neutralise the Redis-backed bits.
    denyRefreshToken: vi.fn().mockResolvedValue(undefined),
    claimRefreshRotation: vi.fn().mockResolvedValue(true),
  };
});

// ADR-013: login now verifies locally against the argon2id directory.
// Mock the password.service boundary so these WARP-485 JWT-shape tests
// (which only use login as a setup step to mint a session) don't need a
// real hash — verifyPassword returns true for the seeded rows.
const verifyPassword = vi.fn().mockResolvedValue(true);
const verifyDummyPassword = vi.fn().mockResolvedValue(false);
vi.mock("../services/password.service.js", () => ({
  verifyPassword: (...args: unknown[]) => verifyPassword(...args),
  verifyDummyPassword: (...args: unknown[]) => verifyDummyPassword(...args),
  hashPassword: vi.fn().mockResolvedValue("$argon2id$mock"),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

// WARP-247 — this suite exercises token SHAPE across rotation, not session
// lifecycle (that's auth.refresh-session.test.ts / session.service.test.ts).
// Mock the session layer to a live record so refresh rotates.
const countLiveSessions = vi.fn(
  async (_userId: string): Promise<number | null> => 0,
);
vi.mock("../services/session.service.js", () => ({
  createSession: vi.fn(async () => ({ sid: "sid-jwt-uuid-suite", evictedSids: [] })),
  checkSession: vi.fn(async () => ({
    kind: "ok",
    record: { userId: "any", role: "family", createdAt: 0, lastSeenAt: 0 },
  })),
  deleteSession: vi.fn(async () => undefined),
  countLiveSessions: (...args: unknown[]) => countLiveSessions(...(args as [string])),
  revokeAllSessions: vi.fn(async () => 0),
}));

import { createPublicAuthRouter, createProtectedAuthRouter } from "./auth.js";
import * as nc from "../services/nextcloud.client.js";
import {
  verifyAccessToken,
  signAccessToken,
  signRefreshToken,
  denyRefreshToken,
} from "../services/jwt.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";

// ── In-memory User + Invite mock (sync layout with auth.invites.test.ts) ──
interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  nextcloudUsername: string | null;
  passwordHash: string | null;
  role: string;
  isLocal: boolean;
  // ADR-013 SCIM soft-deactivation. Optional in the mock so existing ACTIVE
  // fixtures (which omit it) read as not-deactivated.
  directoryStatus?: "ACTIVE" | "DEACTIVATED";
  createdAt: Date;
  updatedAt: Date;
}

function createPrismaMock(seed: UserRow[] = []) {
  const users: UserRow[] = [...seed];
  const invites: any[] = [];
  let inviteCounter = 0;
  const self: any = {};
  // WARP-1570: shared seam (auth.ts opens its guard rails with
  // SERIALIZABLE_TX — the old stub could not see the option at all).
  const seam = createTransactionSeam({
    client: () => self,
    stores: { users, invites },
  });
  self.$transaction = seam.$transaction;
  self._seam = () => seam;
  // PR #375 — login checks for an enabled TOTP factor post-password. These
  // UUID-shape fixtures have none, so the delegate returns null (gate skipped).
  self.totpCredential = {
    findUnique: vi.fn(async () => null),
  };
  self.user = {
    // WARP-233 pre-backfill fallback probe from findUserByEmail: plaintext
    // equality on rows without a blind index.
    findFirst: vi.fn(async ({ where }: { where: any }) =>
      users.find((u: any) => u.email === where.email) ?? null,
    ),
    findUnique: vi.fn(async ({ where }: { where: any }) => {
      if (where.email !== undefined) {
        return users.find((u) => u.email === where.email) ?? null;
      }
      if (where.nextcloudUsername !== undefined) {
        return users.find((u) => u.nextcloudUsername === where.nextcloudUsername) ?? null;
      }
      if (where.id !== undefined) {
        return users.find((u) => u.id === where.id) ?? null;
      }
      if (where.username !== undefined) {
        return users.find((u) => u.username === where.username) ?? null;
      }
      return null;
    }),
    create: vi.fn(async ({ data }: { data: any }) => {
      const row: UserRow = {
        id: data.id ?? `u-uuid-${users.length + 1}`,
        username: data.username,
        displayName: data.displayName ?? data.username,
        email: data.email ?? null,
        nextcloudUsername: data.nextcloudUsername ?? null,
        passwordHash: data.passwordHash ?? null,
        role: data.role ?? "family",
        isLocal: data.isLocal ?? true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      users.push(row);
      return row;
    }),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existingIdx = users.findIndex((u) => {
        if (where.nextcloudUsername !== undefined) {
          return u.nextcloudUsername === where.nextcloudUsername;
        }
        if (where.username !== undefined) return u.username === where.username;
        if (where.id !== undefined) return u.id === where.id;
        return false;
      });
      if (existingIdx >= 0) {
        users[existingIdx] = { ...users[existingIdx]!, ...update, updatedAt: new Date() };
        return users[existingIdx];
      }
      const row: UserRow = {
        id: create.id ?? `u-uuid-${users.length + 1}`,
        username: create.username,
        displayName: create.displayName ?? create.username,
        email: create.email ?? null,
        nextcloudUsername: create.nextcloudUsername ?? null,
        passwordHash: create.passwordHash ?? null,
        role: create.role ?? "family",
        isLocal: create.isLocal ?? true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      users.push(row);
      return row;
    }),
  };
  self.userInvite = {
    create: vi.fn(async ({ data }: any) => {
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
      if (idx < 0) throw Object.assign(new Error("not found"), { code: "P2025" });
      invites[idx] = { ...invites[idx], ...data };
      return invites[idx];
    }),
    // WARP-490: compare-and-swap single-use claim the accept handler runs
    // BEFORE ncCreateUser (`updateMany({ where: { id, acceptedAt: null },
    // data: { acceptedAt } })`). The seeded invite here is fresh
    // (acceptedAt === null), so the claim wins (count 1) and the endpoint
    // proceeds to mint the local UUID + 200. Mirrors the real Prisma
    // updateMany atomicity: the `acceptedAt: null` guard filters an
    // already-accepted row down to count 0 (the handler's 410 USED branch).
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
  self._users = users;
  self._invites = invites;
  return self;
}

function buildApp(prismaMock: any) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", createPublicAuthRouter(prismaMock));
  // For /auth/logout we need to feed req.user manually because that
  // route lives on the protected router and runs after authMiddleware
  // in production. Use a stub middleware to mirror that.
  app.use((req: any, _res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const payload = verifyAccessToken(authHeader.slice(7));
      if (payload) {
        req.user = {
          id: payload.sub,
          username: payload.username,
          displayName: payload.displayName,
          role: payload.role,
        };
      }
    }
    next();
  });
  app.use("/api", createProtectedAuthRouter(prismaMock));
  return app;
}

function decodeAccessTokenFromResponse(res: request.Response): {
  sub: string;
  username: string;
  role: string;
} {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const sessionCookie = cookies.find((c) => c?.startsWith("droplet_session="));
  if (!sessionCookie) throw new Error("droplet_session cookie not set");
  const raw = sessionCookie.split(";")[0]!.replace("droplet_session=", "");
  const decoded = verifyAccessToken(raw);
  if (!decoded) throw new Error("verifyAccessToken returned null on issued token");
  return { sub: decoded.sub, username: decoded.username, role: decoded.role };
}

beforeEach(() => {
  vi.clearAllMocks();
  storeNcToken.mockResolvedValue(undefined);
  getNcToken.mockResolvedValue(null);
  deleteNcToken.mockResolvedValue(undefined);
  touchNcToken.mockResolvedValue(undefined);
  countLiveSessions.mockResolvedValue(0);
});

// ADR-013 inverted the login auth model (Nextcloud-OCS → local argon2id
// directory). These two tests preserve the WARP-485 round-2 anti-
// regression contract — JWT.sub / NC-store key must be the local User.id
// UUID — but now drive login through the new email + argon2id path. The
// full ADR-013 login behavior (anti-enumeration, NC-as-provisioning,
// wrong-password / unknown-email parity) lives in
// `auth.directory-login.test.ts`; we do not duplicate it here.
describe("WARP-485 round 2 — JWT login path (ADR-013 directory)", () => {
  it("signs the access token with the local User.id UUID, NOT the username", async () => {
    // Local directory row already exists with an argon2id hash.
    const localUser: UserRow = {
      id: "u-uuid-stefan-7777",
      username: "stefan-cruceru",
      displayName: "Stefan Cruceru",
      email: "stefan@warp.test",
      nextcloudUsername: "stefan-cruceru",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$seed$seed",
      role: "owner",
      isLocal: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = createPrismaMock([localUser]);
    verifyPassword.mockResolvedValueOnce(true);

    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "hunter22hunter22" });

    expect(res.status).toBe(200);
    // The canonical anti-regression assertion: JWT.sub is the UUID.
    const decoded = decodeAccessTokenFromResponse(res);
    expect(decoded.sub).toBe("u-uuid-stefan-7777");
    expect(decoded.sub).not.toBe("stefan-cruceru");
    // Username keeps the human-readable handle for display.
    expect(decoded.username).toBe("stefan-cruceru");
    expect(decoded.role).toBe("owner");

    // Response body mirrors the same shape (the dashboard reads it directly).
    expect(res.body.user.id).toBe("u-uuid-stefan-7777");
    expect(res.body.user.username).toBe("stefan-cruceru");
  });

  it("stores the downstream NC token keyed by local User.id UUID, not by username", async () => {
    const localUser: UserRow = {
      id: "u-uuid-romain-8888",
      username: "romain",
      displayName: "Romain",
      email: "romain@warp.test",
      nextcloudUsername: "romain",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$seed$seed",
      role: "owner",
      isLocal: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = createPrismaMock([localUser]);
    verifyPassword.mockResolvedValueOnce(true);

    // Downstream provisioning returns an app-password to stash for WebDAV.
    (nc.ncLoginWithCredentials as any).mockResolvedValueOnce({
      token: "nc-token-for-romain",
      loginName: "romain",
    });

    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "romain@warp.test", password: "hunter22hunter22" });

    expect(res.status).toBe(200);
    expect(storeNcToken).toHaveBeenCalledTimes(1);
    // First positional arg is the userId we store under. Must be the UUID.
    const [storedUserId, storedToken] = storeNcToken.mock.calls[0]!;
    expect(storedUserId).toBe("u-uuid-romain-8888");
    expect(storedUserId).not.toBe("romain");
    expect(storedToken).toBe("nc-token-for-romain");
  });
});

describe("WARP-485 round 2 — JWT refresh path", () => {
  it("rotation keeps JWT.sub as the local User.id UUID", async () => {
    const localUser: UserRow = {
      id: "u-uuid-rotate-1234",
      username: "rotator",
      displayName: "Rotator",
      email: "rotator@warp.test",
      nextcloudUsername: "rotator",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$seed$seed",
      role: "family",
      isLocal: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = createPrismaMock([localUser]);
    verifyPassword.mockResolvedValueOnce(true);
    (nc.ncLoginWithCredentials as any).mockResolvedValueOnce({
      token: "nc-token",
      loginName: "rotator",
    });

    const app = buildApp(prisma);

    // Step 1: log in to get a real refresh-token cookie issued by the
    // production signRefreshToken (the round-1 fix already lives in
    // signAccessToken, but we need to ride end-to-end here).
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "rotator@warp.test", password: "hunter22hunter22" });
    expect(login.status).toBe(200);
    const refreshCookie = (login.headers["set-cookie"] as unknown as string[])
      .find((c) => c.startsWith("droplet_refresh="))
      ?.split(";")[0];
    expect(refreshCookie).toBeDefined();

    // Step 2: hit /auth/refresh with the cookie and decode the new access JWT.
    const refresh = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", refreshCookie!);
    expect(refresh.status).toBe(200);

    const decoded = decodeAccessTokenFromResponse(refresh);
    expect(decoded.sub).toBe("u-uuid-rotate-1234");
    expect(decoded.sub).not.toBe("rotator");

    // touchNcToken extended the cache entry under the UUID key, not
    // the NC username — confirms the round-2 fix wired the refresh
    // path through too.
    expect(touchNcToken).toHaveBeenCalledTimes(1);
    expect(touchNcToken.mock.calls[0]![0]).toBe("u-uuid-rotate-1234");
  });

  it("refuses /auth/refresh with 401 when the local User row has since been deleted", async () => {
    // The user logged in, got a refresh cookie, then an owner removed
    // them from /api/people while the cookie was still in flight. The
    // refresh must fail closed instead of issuing a new access JWT
    // for a vanished identity.
    const localUser: UserRow = {
      id: "u-uuid-removed-9999",
      username: "soon-removed",
      displayName: "Soon Removed",
      email: "soon-removed@warp.test",
      nextcloudUsername: "soon-removed",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$seed$seed",
      role: "family",
      isLocal: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = createPrismaMock([localUser]);
    verifyPassword.mockResolvedValueOnce(true);
    (nc.ncLoginWithCredentials as any).mockResolvedValueOnce({
      token: "nc-token",
      loginName: "soon-removed",
    });

    const app = buildApp(prisma);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "soon-removed@warp.test", password: "hunter22hunter22" });
    expect(login.status).toBe(200);
    const refreshCookie = (login.headers["set-cookie"] as unknown as string[])
      .find((c) => c.startsWith("droplet_refresh="))
      ?.split(";")[0];

    // Simulate the row being deleted between login and refresh.
    prisma._users.length = 0;

    const refresh = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", refreshCookie!);
    expect(refresh.status).toBe(401);
    expect(refresh.body).toMatchObject({ code: "USER_NOT_PROVISIONED" });
  });

  it("denylists the BODY-supplied refresh token (ADR-008 mobile) on the no-User branch", async () => {
    // Regression for the pr-reviewer finding: ADR-008 native clients POST the
    // refresh token in the JSON body, not a cookie. On the !localUser error
    // branch the deny call used refreshTokenCookie — null for body clients — so
    // `denyRefreshToken(null)` threw internally and the token was NEVER revoked.
    // It must denylist the BODY token (refreshTokenInput) instead.
    const prisma = createPrismaMock([]); // no rows → !localUser branch
    // A structurally valid refresh token for a subject with no local row.
    const bodyToken = signRefreshToken({
      id: "u-uuid-ghost-0001",
      username: "ghost",
      displayName: "Ghost",
      role: "family",
      // WARP-247 — carry a sid so the refresh session-gate (checkSession
      // mocked → ok) passes through to the WARP-485 no-User branch this test
      // actually exercises, rather than short-circuiting on a sid-less token.
      sid: "sid-jwt-uuid-suite",
    });

    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: bodyToken }); // body only, NO cookie

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "USER_NOT_PROVISIONED" });
    // The fix: the body token is what gets denylisted, never a null cookie.
    expect(denyRefreshToken).toHaveBeenCalledWith(bodyToken);
    expect(denyRefreshToken).not.toHaveBeenCalledWith(null);
  });

  it("refuses /auth/refresh with 401 when the local User row is directory-DEACTIVATED (ADR-013)", async () => {
    // The user offboarded (SCIM active:false → DEACTIVATED) after the refresh
    // token was issued. A row-existence check alone would still mint fresh
    // credentials; the DEACTIVATED gate must fail it closed — parity with the
    // /auth/login, SSO, and WebAuthn paths — and burn the presented token.
    const localUser: UserRow = {
      id: "u-uuid-deact-2468",
      username: "deactivated-user",
      displayName: "Deactivated User",
      email: "deactivated@warp.test",
      nextcloudUsername: "deactivated-user",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$seed$seed",
      role: "family",
      isLocal: true,
      directoryStatus: "DEACTIVATED",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = createPrismaMock([localUser]);
    const refreshToken = signRefreshToken({
      id: "u-uuid-deact-2468",
      username: "deactivated-user",
      displayName: "Deactivated User",
      role: "family",
      // WARP-247 — carry a sid so the refresh session-gate passes through to
      // the DEACTIVATED gate this test exercises (checkSession mocked → ok).
      sid: "sid-jwt-uuid-suite",
    });

    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "USER_NOT_PROVISIONED" });
    // Row still exists (it's deactivated, not deleted) yet the token is burned.
    expect(denyRefreshToken).toHaveBeenCalledWith(refreshToken);
  });
});

describe("WARP-485 round 2 — JWT invite-accept path", () => {
  it("signs the access token with the provisioned local User.id UUID", async () => {
    // The invite-accept flow creates a Nextcloud user and (post round-2)
    // a matching local User row keyed by `nextcloudUsername`. The JWT
    // issued by the auto-login must carry the local UUID, not the
    // invite's username string.
    const prisma = createPrismaMock([]);

    // Seed an invite directly so we don't need to drive the admin
    // create-invite endpoint inside this test.
    const token = "x".repeat(43);
    prisma._invites.push({
      id: "inv-test",
      token,
      username: "fresh-invitee",
      displayName: "Fresh Invitee",
      email: null,
      role: "family",
      createdBy: "owner",
      acceptedAt: null,
      acceptedFrom: null,
      revokedAt: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const app = buildApp(prisma);
    // Password must satisfy the policy: ≥12 chars + ≥3 character classes
    // (lowercase, uppercase, digit, symbol). "longenoughpw" fails — only 1 class.
    const res = await request(app)
      .post(`/api/auth/invites/accept/${token}`)
      .send({ password: "Accept-secret123" });

    expect(res.status).toBe(200);

    // The local User row was upserted with nextcloudUsername=invite.username
    // — the round-2 contract.
    const created = prisma._users.find((u: UserRow) => u.nextcloudUsername === "fresh-invitee");
    expect(created).toBeDefined();
    expect(created!.username).toBe("fresh-invitee");
    expect(created!.role).toBe("family");

    const decoded = decodeAccessTokenFromResponse(res);
    expect(decoded.sub).toBe(created!.id);
    expect(decoded.sub).not.toBe("fresh-invitee"); // not the username string
    expect(decoded.username).toBe("fresh-invitee");
    expect(decoded.role).toBe("family");
  });
});

describe("pr-reviewer hardening — auth audit IP ignores a forged X-Forwarded-For", () => {
  it("does not record the client-controlled leftmost XFF as the audit ip", async () => {
    // callerIpFromReq now returns req.ip (forge-resistant under trust proxy),
    // not the raw leftmost X-Forwarded-For entry. A credential-stuffing client
    // could otherwise attribute every failed attempt to an arbitrary IP,
    // defeating IP-based triage. Drive the audited wrong-password path and
    // assert the attacker's forged XFF never lands in the audit row.
    const localUser: UserRow = {
      id: "u-uuid-xff-1357",
      username: "xff-victim",
      displayName: "XFF Victim",
      email: "xff@warp.test",
      nextcloudUsername: "xff-victim",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$seed$seed",
      role: "family",
      isLocal: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = createPrismaMock([localUser]);
    verifyPassword.mockResolvedValueOnce(false); // wrong password → denyInvalid

    const FORGED = "203.0.113.7"; // attacker-chosen; must never be trusted
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", `${FORGED}, 10.1.1.1`)
      .send({ email: "xff@warp.test", password: "definitely-wrong-pw" });

    expect(res.status).toBe(401);
    expect(recordActivity).toHaveBeenCalledTimes(1);
    const arg = (recordActivity as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // The forged leftmost XFF must not appear anywhere in the audit row.
    expect(arg.refs.ip).not.toBe(FORGED);
    expect(String(arg.sub)).not.toContain(FORGED);
  });
});

describe("WARP-485 round 2 — logout NC token key shape", () => {
  it("fetches and deletes the NC token by local User.id UUID, not NC username", async () => {
    const localUser: UserRow = {
      id: "u-uuid-logout-5555",
      username: "logout-user",
      displayName: "Logout User",
      email: "logout-user@warp.test",
      nextcloudUsername: "logout-user",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$seed$seed",
      role: "family",
      isLocal: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = createPrismaMock([localUser]);

    const accessToken = signAccessToken({
      id: "u-uuid-logout-5555",
      username: "logout-user",
      displayName: "Logout User",
      role: "family",
    });

    // Pretend an NC token is sitting in Redis under the UUID key.
    getNcToken.mockResolvedValueOnce("nc-app-password-to-revoke");

    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(getNcToken).toHaveBeenCalledWith("u-uuid-logout-5555");
    expect(deleteNcToken).toHaveBeenCalledWith("u-uuid-logout-5555");
    expect(nc.ncDeleteAppPassword).toHaveBeenCalledWith("nc-app-password-to-revoke");
  });

  // The NC app-password is a PER-USER credential: one Redis slot shared by
  // every device session. Logging out on one device must not break file
  // routes and the chat agent's file tools (read_file → AUTH_REQUIRED) on
  // the user's other still-live sessions.
  it("keeps the NC token when the user still has other live sessions", async () => {
    const localUser: UserRow = {
      id: "u-uuid-logout-6666",
      username: "logout-user-2",
      displayName: "Logout User 2",
      email: "logout-user-2@warp.test",
      nextcloudUsername: "logout-user-2",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$seed$seed",
      role: "family",
      isLocal: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = createPrismaMock([localUser]);

    const accessToken = signAccessToken({
      id: "u-uuid-logout-6666",
      username: "logout-user-2",
      displayName: "Logout User 2",
      role: "family",
    });

    // Another device's session record is still live after this one is dropped.
    countLiveSessions.mockResolvedValueOnce(1);

    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(countLiveSessions).toHaveBeenCalledWith("u-uuid-logout-6666");
    // The shared credential is left untouched — not even looked up.
    expect(getNcToken).not.toHaveBeenCalled();
    expect(nc.ncDeleteAppPassword).not.toHaveBeenCalled();
    expect(deleteNcToken).not.toHaveBeenCalled();
  });

  it("revokes when the live-session count is unknown (fail toward the security invariant)", async () => {
    const localUser: UserRow = {
      id: "u-uuid-logout-7777",
      username: "logout-user-3",
      displayName: "Logout User 3",
      email: "logout-user-3@warp.test",
      nextcloudUsername: "logout-user-3",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$seed$seed",
      role: "family",
      isLocal: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = createPrismaMock([localUser]);

    const accessToken = signAccessToken({
      id: "u-uuid-logout-7777",
      username: "logout-user-3",
      displayName: "Logout User 3",
      role: "family",
    });

    countLiveSessions.mockResolvedValueOnce(null);
    getNcToken.mockResolvedValueOnce("nc-app-password-orphaned");

    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(nc.ncDeleteAppPassword).toHaveBeenCalledWith("nc-app-password-orphaned");
    expect(deleteNcToken).toHaveBeenCalledWith("u-uuid-logout-7777");
  });
});
