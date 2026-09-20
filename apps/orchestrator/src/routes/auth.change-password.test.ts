/**
 * WARP-824 — POST /auth/change-password + the must-change signal on
 * /auth/login and /auth/me.
 *
 * A user created by an admin with a temporary password carries an explicit
 * `User.mustChangePassword` flag. This file covers the self-remediation path:
 *
 *   • POST /auth/login returns `user.mustChangePassword` so the dashboard can
 *     redirect to the change-password screen.
 *   • GET  /auth/me returns the FRESH flag (read from the row, not the JWT) so
 *     a hard refresh still knows the user is gated.
 *   • POST /auth/change-password verifies the current password, enforces the
 *     shared password policy on the new one, writes a fresh argon2id hash, and
 *     CLEARS the flag — after which the gate lets the user through.
 *
 * Harness mirrors auth.totp-login-gate.test.ts (public router via supertest;
 * NC client / nc-session / password.service / jwt / activity mocked; in-memory
 * Prisma mock) and auth.directory-adduser.test.ts (protected router for the
 * authenticated change-password call behind a synthetic req.user).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "legacy",
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// Stateful in-memory cache double — the change-password backoff (PR #549
// follow-up) needs real get/set/del semantics, not a null stub.
const cacheStore = vi.hoisted(() => new Map<string, unknown>());
// When flipped to true, cacheIncr models the real Redis-error path: the
// production signature is `cacheIncr(key, ttlSeconds): Promise<number | null>`
// (cache.service.ts) and it returns `null` on a Redis outage, which auth.ts
// treats as fail-open at the lockout write. Tests can force that branch
// without it being dark.
const cacheState = vi.hoisted(() => ({ incrReturnsNull: false }));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown) => {
    cacheStore.set(key, value);
  }),
  cacheDel: vi.fn(async (key: string) => {
    cacheStore.delete(key);
  }),
  // Faithful to the real contract: cacheIncr(key, ttlSeconds) -> number | null.
  // Default behavior increments an in-memory counter (so the lockout reaches
  // 429); when cacheState.incrReturnsNull is set, it returns null to model a
  // Redis error so the fail-open branch (auth.ts: `if (next === null) return`)
  // is exercised rather than dark. ttlSeconds is accepted to match the real
  // signature even though the in-memory store ignores expiry.
  cacheIncr: vi.fn(async (key: string, _ttlSeconds: number): Promise<number | null> => {
    if (cacheState.incrReturnsNull) return null;
    const next = ((cacheStore.get(key) as number) ?? 0) + 1;
    cacheStore.set(key, next);
    return next;
  }),
}));

vi.mock("../services/nextcloud.client.js", () => ({
  ncCheckSetupRequired: vi.fn(),
  ncInstallAndCreateAdmin: vi.fn().mockResolvedValue(undefined),
  ncLoginWithCredentials: vi.fn().mockResolvedValue({ token: "nc", loginName: "x" }),
  ncDeleteAppPassword: vi.fn().mockResolvedValue(undefined),
  ncGetCurrentUser: vi.fn(),
  ncCreateUser: vi.fn().mockResolvedValue(undefined),
  ncDeleteUser: vi.fn(),
  ncListUsers: vi.fn(),
  ncUpdateUser: vi.fn().mockResolvedValue(undefined),
  ncSetUserEnabled: vi.fn(),
  ncOAuth2AuthorizeUrl: vi.fn(),
  ncOAuth2ExchangeCode: vi.fn(),
  ncOAuth2RefreshToken: vi.fn(),
  NextcloudUserExistsError: class extends Error {},
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: vi.fn().mockResolvedValue(undefined),
  getNcToken: vi.fn().mockResolvedValue(null),
  deleteNcToken: vi.fn().mockResolvedValue(undefined),
  touchNcToken: vi.fn().mockResolvedValue(undefined),
  resolveNcToken: vi.fn().mockResolvedValue("tok"),
}));

const hashPassword = vi.fn(async (_pw: string) => "$argon2id$v=19$m=19456,t=2,p=1$bmV3c2FsdA$bmV3aGFzaA");
const verifyPassword = vi.fn();
const verifyDummyPassword = vi.fn().mockResolvedValue(false);
vi.mock("../services/password.service.js", () => ({
  hashPassword: (...a: unknown[]) => hashPassword(...(a as [string])),
  verifyPassword: (...a: unknown[]) => verifyPassword(...a),
  verifyDummyPassword: (...a: unknown[]) => verifyDummyPassword(...a),
}));

vi.mock("../services/totp.service.js", () => ({
  verifyTotpCode: vi.fn(),
  generateTotpEnrollment: vi.fn(),
  encryptTotpSecret: vi.fn(),
  decryptTotpSecret: vi.fn(),
  TOTP_ISSUER: "Droplet",
}));

vi.mock("../services/recovery.service.js", () => ({
  findMatchingRecoveryCodeHash: vi.fn(),
  generateRecoveryCodes: vi.fn(),
  RECOVERY_CODE_COUNT: 10,
}));

vi.mock("../services/jwt.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/jwt.service.js")>(
    "../services/jwt.service.js",
  );
  return { ...actual, denyRefreshToken: vi.fn(), claimRefreshRotation: vi.fn().mockResolvedValue(true) };
});

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

// WARP-247 — credential change must revoke every OTHER session.
const revokeAllSessions = vi.fn(
  async (_userId?: string, _opts?: { exceptSid?: string }) => 2,
);
vi.mock("../services/session.service.js", () => ({
  createSession: vi.fn(async () => ({ sid: "sid-cp-test", evictedSids: [] })),
  checkSession: vi.fn(async () => ({
    kind: "ok",
    record: { userId: "u-kid", role: "family", createdAt: 0, lastSeenAt: 0 },
  })),
  deleteSession: vi.fn(async () => undefined),
  revokeAllSessions: (...a: unknown[]) =>
    revokeAllSessions(...(a as [string, { exceptSid?: string }])),
}));

import {
  createPublicAuthRouter,
  createProtectedAuthRouter,
  passwordChangeBackoffSeconds,
  callerIpFromReq,
} from "./auth.js";
import { authRateLimit, sensitiveRateLimit, standardRateLimit } from "../middleware/rate-limit.js";
import { recordActivity } from "../services/activity.singleton.js";
import type { Role } from "../services/jwt.service.js";

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  nextcloudUsername: string | null;
  passwordHash: string | null;
  role: string;
  isLocal: boolean;
  directoryStatus: string;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function createPrismaMock(seed: UserRow[]) {
  const users = [...seed];
  const self: any = {};
  self.user = {
    findUnique: vi.fn(async ({ where, select }: any) => {
      let row: UserRow | undefined;
      if (where.email !== undefined) row = users.find((u) => u.email === where.email);
      else if (where.id !== undefined) row = users.find((u) => u.id === where.id);
      if (!row) return null;
      if (select) {
        const out: any = {};
        for (const k of Object.keys(select)) out[k] = (row as any)[k];
        return out;
      }
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = users.find((u) => u.id === where.id);
      if (!row) throw new Error("row not found");
      Object.assign(row, data);
      return row;
    }),
    findFirst: vi.fn(async () => null),
  };
  self.user.findFirst = vi.fn(async ({ where }: { where: any }) =>
    users.find((u) => u.email === where.email) ?? null,
  );
  self.totpCredential = { findUnique: vi.fn(async () => null) };
  self.recoveryCode = { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) };
  self._users = users;
  return self;
}

function row(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "u-kid",
    username: "kid",
    displayName: "Kid",
    email: "kid@warp.test",
    nextcloudUsername: "kid",
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$b2xkc2FsdA$b2xkaGFzaA",
    role: "family",
    isLocal: true,
    directoryStatus: "ACTIVE",
    mustChangePassword: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function publicApp(prismaMock: any) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", createPublicAuthRouter(prismaMock));
  return app;
}

function protectedApp(prismaMock: any, sessionUser: any) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = sessionUser;
    next();
  });
  app.use("/api", createProtectedAuthRouter(prismaMock));
  return app;
}

const session = (over: Partial<{ id: string; role: Role }> = {}) => ({
  id: over.id ?? "u-kid",
  username: "kid",
  displayName: "Kid",
  role: over.role ?? ("family" as Role),
});

// CodeQL js/missing-rate-limiting sweep — the routes under test now carry the
// shared express-rate-limit presets (module singletons, MemoryStore keyed on
// req.ip). Every request in this file comes from supertest's loopback, which the
// limiter keys as "127.0.0.1" (`::ffff:127.0.0.1` from
// __tests__/supertest-loopback.setup.ts is IPv4-mapped, so ipKeyGenerator
// collapses it to the v4 form), so the file as a whole would exhaust the 20/min
// auth budget. Reset that one bucket before each test; no single test sends
// more than the budget, and the Redis lockouts under test are untouched.
const RATE_LIMIT_TEST_KEY = "127.0.0.1";

beforeEach(() => {
  authRateLimit.resetKey(RATE_LIMIT_TEST_KEY);
  sensitiveRateLimit.resetKey(RATE_LIMIT_TEST_KEY);
  standardRateLimit.resetKey(RATE_LIMIT_TEST_KEY);

  vi.clearAllMocks();
  cacheStore.clear();
  cacheState.incrReturnsNull = false;
  hashPassword.mockImplementation(async (_pw: string) => "$argon2id$v=19$m=19456,t=2,p=1$bmV3c2FsdA$bmV3aGFzaA");
  verifyDummyPassword.mockResolvedValue(false);
  // WARP-247 — clearAllMocks wipes the call log; restore the default return.
  revokeAllSessions.mockResolvedValue(2);
});

describe("login surfaces the must-change signal", () => {
  it("returns user.mustChangePassword=true for a temp-password user", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    const prisma = createPrismaMock([row({ mustChangePassword: true })]);
    const res = await request(publicApp(prisma))
      .post("/api/auth/login")
      .send({ email: "kid@warp.test", password: "temp" });

    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(true);
  });

  it("returns user.mustChangePassword=false for a normal user", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    const prisma = createPrismaMock([row({ id: "u-own", email: "own@warp.test", mustChangePassword: false })]);
    const res = await request(publicApp(prisma))
      .post("/api/auth/login")
      .send({ email: "own@warp.test", password: "pw" });

    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(false);
  });
});

describe("GET /auth/me surfaces the FRESH must-change signal", () => {
  it("returns mustChangePassword=true from the row, not the JWT claim", async () => {
    const prisma = createPrismaMock([row({ mustChangePassword: true })]);
    const res = await request(protectedApp(prisma, session()))
      .get("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(true);
  });

  it("returns mustChangePassword=false once the flag is cleared", async () => {
    const prisma = createPrismaMock([row({ mustChangePassword: false })]);
    const res = await request(protectedApp(prisma, session()))
      .get("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(false);
  });
});

describe("POST /auth/change-password", () => {
  it("verifies the current password, writes a new argon2id hash, and CLEARS the flag", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    const prisma = createPrismaMock([row({ mustChangePassword: true })]);
    const res = await request(protectedApp(prisma, session()))
      .post("/api/auth/change-password")
      .send({ currentPassword: "Temp-secret123", newPassword: "Brand-new-secret123" });

    expect(res.status).toBe(200);
    // current password was verified against the stored hash
    expect(verifyPassword).toHaveBeenCalledWith(
      "$argon2id$v=19$m=19456,t=2,p=1$b2xkc2FsdA$b2xkaGFzaA",
      "Temp-secret123",
    );
    // new password was hashed (never stored plaintext)
    expect(hashPassword).toHaveBeenCalledWith("Brand-new-secret123");
    const stored = prisma._users.find((u: UserRow) => u.id === "u-kid");
    expect(stored.passwordHash).toBe("$argon2id$v=19$m=19456,t=2,p=1$bmV3c2FsdA$bmV3aGFzaA");
    // the gate flag is cleared
    expect(stored.mustChangePassword).toBe(false);
    expect(JSON.stringify(stored)).not.toContain("Brand-new-secret123");
  });

  it("rejects a wrong current password with 400 INVALID_PASSWORD and does NOT clear the flag", async () => {
    verifyPassword.mockResolvedValueOnce(false);
    const prisma = createPrismaMock([row({ mustChangePassword: true })]);
    const res = await request(protectedApp(prisma, session()))
      .post("/api/auth/change-password")
      .send({ currentPassword: "wrong", newPassword: "Brand-new-secret123" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PASSWORD");
    expect(hashPassword).not.toHaveBeenCalled();
    const stored = prisma._users.find((u: UserRow) => u.id === "u-kid");
    expect(stored.mustChangePassword).toBe(true);
    // hash untouched
    expect(stored.passwordHash).toBe("$argon2id$v=19$m=19456,t=2,p=1$b2xkc2FsdA$b2xkaGFzaA");
  });

  it("rejects a weak new password with 400 WEAK_PASSWORD before any write", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    const prisma = createPrismaMock([row({ mustChangePassword: true })]);
    const res = await request(protectedApp(prisma, session()))
      .post("/api/auth/change-password")
      .send({ currentPassword: "Temp-secret123", newPassword: "weak" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WEAK_PASSWORD");
    expect(hashPassword).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated call with 401", async () => {
    const prisma = createPrismaMock([row()]);
    // No req.user populated.
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createProtectedAuthRouter(prisma));
    const res = await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: "Temp-secret123", newPassword: "Brand-new-secret123" });

    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("400s when the new password equals the current one (no-op change is not a real rotation)", async () => {
    verifyPassword.mockResolvedValue(true);
    const prisma = createPrismaMock([row({ mustChangePassword: true })]);
    const res = await request(protectedApp(prisma, session()))
      .post("/api/auth/change-password")
      .send({ currentPassword: "Same-secret123", newPassword: "Same-secret123" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SAME_PASSWORD");
    const stored = prisma._users.find((u: UserRow) => u.id === "u-kid");
    expect(stored.mustChangePassword).toBe(true);
  });
});

describe("POST /auth/change-password — current-password oracle hardening (PR #549 follow-up)", () => {
  it("answers INVALID_PASSWORD (never SAME_PASSWORD) when the current password is wrong, even if current === new", async () => {
    // Ordering half of the finding: SAME_PASSWORD must only ever be computed
    // for a caller who has PROVEN the current password. Before the fix this
    // request returned SAME_PASSWORD without running verifyPassword at all.
    verifyPassword.mockResolvedValue(false);
    const prisma = createPrismaMock([row()]);
    const res = await request(protectedApp(prisma, session()))
      .post("/api/auth/change-password")
      .send({ currentPassword: "Guess-secret123", newPassword: "Guess-secret123" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PASSWORD");
    expect(verifyPassword).toHaveBeenCalled();
  });

  it("locks with 429 TOO_MANY_ATTEMPTS after repeated wrong current passwords", async () => {
    verifyPassword.mockResolvedValue(false);
    const prisma = createPrismaMock([row()]);
    const app = protectedApp(prisma, session());

    // Free tier (5) + 1 — the 6th wrong attempt sets the first lock.
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post("/api/auth/change-password")
        .send({ currentPassword: `Wrong-secret-${i}23`, newPassword: "Brand-new-secret123" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_PASSWORD");
    }

    const locked = await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: "Wrong-final-secret123", newPassword: "Brand-new-secret123" });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("TOO_MANY_ATTEMPTS");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    // The locked request never reached the verifier — no extra oracle sample.
    expect(verifyPassword).toHaveBeenCalledTimes(6);
  });

  it("fails open (never 429) when the failure-counter store errors", async () => {
    // Models a Redis outage: cacheIncr returns null (cache.service.ts contract),
    // so recordPasswordChangeFailure returns early without writing a lock
    // (auth.ts: `if (next === null) return`). The lockout must degrade open —
    // a backing-store failure must not hard-lock a legitimate user out of their
    // own password change.
    cacheState.incrReturnsNull = true;
    verifyPassword.mockResolvedValue(false);
    const prisma = createPrismaMock([row()]);
    const app = protectedApp(prisma, session());

    // Far past the free tier + lock threshold — with a healthy store this would
    // be a 429 by the 7th attempt; with the store erroring it stays 400 forever.
    for (let i = 0; i < 9; i++) {
      const res = await request(app)
        .post("/api/auth/change-password")
        .send({ currentPassword: `Wrong-secret-${i}23`, newPassword: "Brand-new-secret123" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_PASSWORD");
    }
  });

  it("a successful verify clears the failure counter", async () => {
    const prisma = createPrismaMock([row()]);
    const app = protectedApp(prisma, session());

    // 5 wrong attempts — still inside the free tier, no lock yet.
    verifyPassword.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/auth/change-password")
        .send({ currentPassword: `Wrong-secret-${i}23`, newPassword: "Brand-new-secret123" });
    }

    // Correct password → rotation succeeds and the counter resets.
    verifyPassword.mockResolvedValue(true);
    const ok = await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: "Temp-secret123", newPassword: "Brand-new-secret123" });
    expect(ok.status).toBe(200);

    // One more wrong attempt starts from a CLEAN count (1 of 5) — were the
    // counter not cleared this would be failure #6 and set a lock.
    verifyPassword.mockResolvedValue(false);
    await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: "Wrong-again-secret123", newPassword: "Other-new-secret123" });

    verifyPassword.mockResolvedValue(true);
    const after = await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: "Brand-new-secret123", newPassword: "Another-new-secret123" });
    expect(after.status).toBe(200);
  });
});

describe("auth audit caller IP (WARP-456) — spoof resistance", () => {
  it("records the proxy-resolved IP in the audit row, never the client-supplied X-Forwarded-For", async () => {
    // `trust proxy` is not set on this test app, so Express must ignore the
    // forged header entirely; before the fix callerIpFromReq read the
    // LEFTMOST X-Forwarded-For entry — i.e. whatever the caller claimed.
    verifyPassword.mockResolvedValue(true);
    const prisma = createPrismaMock([row()]);
    const res = await request(protectedApp(prisma, session()))
      .post("/api/auth/change-password")
      .set("X-Forwarded-For", "6.6.6.6")
      .send({ currentPassword: "Temp-secret123", newPassword: "Brand-new-secret123" });

    expect(res.status).toBe(200);
    const call = vi.mocked(recordActivity).mock.calls.at(-1)?.[0] as any;
    expect(call).toBeDefined();
    expect(call.sub).not.toBe("6.6.6.6");
    expect(call.refs.ip).not.toBe("6.6.6.6");
  });

  it("callerIpFromReq prefers proxy-aware req.ip and falls back to the socket address", () => {
    const spoofed = {
      headers: { "x-forwarded-for": "6.6.6.6, 10.0.0.1" },
      ip: "192.168.20.5",
      socket: { remoteAddress: "172.18.0.9" },
    } as any;
    expect(callerIpFromReq(spoofed)).toBe("192.168.20.5");

    const noIp = { headers: {}, ip: undefined, socket: { remoteAddress: "172.18.0.9" } } as any;
    expect(callerIpFromReq(noIp)).toBe("172.18.0.9");
  });
});

describe("passwordChangeBackoffSeconds — pure schedule", () => {
  it("forgives the free tier, then escalates and caps", () => {
    expect(passwordChangeBackoffSeconds(0)).toBe(0);
    expect(passwordChangeBackoffSeconds(5)).toBe(0);
    expect(passwordChangeBackoffSeconds(6)).toBe(30);
    expect(passwordChangeBackoffSeconds(7)).toBe(60);
    expect(passwordChangeBackoffSeconds(8)).toBe(120);
    expect(passwordChangeBackoffSeconds(9)).toBe(300);
    expect(passwordChangeBackoffSeconds(10)).toBe(900);
    expect(passwordChangeBackoffSeconds(100)).toBe(900);
  });
});

describe("WARP-247 — change-password revokes other sessions", () => {
  it("revokes all sessions EXCEPT the current sid and audits it", async () => {
    const prisma = createPrismaMock([row()]);
    verifyPassword.mockResolvedValueOnce(true);
    const app = protectedApp(prisma, {
      id: "u-kid",
      username: "kid",
      displayName: "Kid",
      role: "family",
      sid: "sid-current-device",
    });

    const res = await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: "temp-Password-1!", newPassword: "brand-New-Password-9!" });

    expect(res.status).toBe(200);
    expect(revokeAllSessions).toHaveBeenCalledWith("u-kid", {
      exceptSid: "sid-current-device",
    });
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auth",
        refs: expect.objectContaining({
          outcome: "sessions_revoked",
          reason: "password_change",
          userId: "u-kid",
          revoked: 2,
        }),
        actor: { type: "user", id: "u-kid" },
      }),
    );
  });

  it("does NOT revoke anything when the current password check fails", async () => {
    const prisma = createPrismaMock([row()]);
    verifyPassword.mockResolvedValueOnce(false);
    const app = protectedApp(prisma, {
      id: "u-kid", username: "kid", displayName: "Kid", role: "family", sid: "sid-x",
    });

    const res = await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: "wrong", newPassword: "brand-New-Password-9!" });

    expect(res.status).toBe(400);
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });
});
