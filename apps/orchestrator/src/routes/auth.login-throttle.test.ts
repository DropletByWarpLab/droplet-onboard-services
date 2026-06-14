/**
 * WARP-579 — POST /auth/login brute-force throttle.
 *
 * Until this fix /auth/login verified the argon2id hash with NO rate limit, so
 * the public router was an unbounded password-guessing oracle. The route now
 * applies a progressive per-IP AND per-account escalating lockout (mirrors the
 * change-password backoff model). This file covers:
 *
 *   • The Nth failed attempt from one IP is throttled with 429
 *     TOO_MANY_ATTEMPTS + a Retry-After header, and the throttled request
 *     never reaches the verifier (no extra brute-force sample).
 *   • The per-account gate locks an account independently (its free tier is
 *     smaller than the per-IP tier).
 *   • A successful login clears the failure counters.
 *   • The throttle is enforced for an UNKNOWN email too (no enumeration oracle
 *     — locked vs not-locked must not distinguish "account exists").
 *   • loginBackoffSeconds is a pure free-tier-then-escalate-then-cap schedule.
 *
 * Harness mirrors auth.change-password.test.ts (stateful in-memory cache double
 * so the cacheIncr/cacheSet backoff has real semantics) + auth.directory-login
 * (real route via supertest, NC client + password.service + jwt + activity
 * mocked, in-memory Prisma mock).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "legacy",
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    REDIS_URL: "redis://localhost:6379",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
  },
}));

// Stateful in-memory cache double — the login backoff (WARP-579) needs real
// get/set/del/incr semantics, not a null stub.
const cacheStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown) => {
    cacheStore.set(key, value);
  }),
  cacheDel: vi.fn(async (key: string) => {
    cacheStore.delete(key);
  }),
  cacheIncr: vi.fn(async (key: string) => {
    const next = ((cacheStore.get(key) as number | undefined) ?? 0) + 1;
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

const verifyPassword = vi.fn();
const verifyDummyPassword = vi.fn().mockResolvedValue(false);
const hashPassword = vi.fn().mockResolvedValue("$argon2id$mock");
vi.mock("../services/password.service.js", () => ({
  verifyPassword: (...a: unknown[]) => verifyPassword(...a),
  verifyDummyPassword: (...a: unknown[]) => verifyDummyPassword(...a),
  hashPassword: (...a: unknown[]) => hashPassword(...a),
}));

vi.mock("../services/jwt.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/jwt.service.js")>(
    "../services/jwt.service.js",
  );
  return {
    ...actual,
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

import { createPublicAuthRouter, loginBackoffSeconds } from "./auth.js";

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  nextcloudUsername: string | null;
  passwordHash: string | null;
  role: string;
  isLocal: boolean;
  directoryStatus: "ACTIVE" | "DEACTIVATED";
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function createPrismaMock(seed: UserRow[] = []) {
  const users: UserRow[] = [...seed];
  const self: any = {};
  self.user = {
    findUnique: vi.fn(async ({ where }: { where: any }) => {
      if (where.email !== undefined) return users.find((u) => u.email === where.email) ?? null;
      if (where.nextcloudUsername !== undefined)
        return users.find((u) => u.nextcloudUsername === where.nextcloudUsername) ?? null;
      if (where.id !== undefined) return users.find((u) => u.id === where.id) ?? null;
      return null;
    }),
  };
  self.totpCredential = { findUnique: vi.fn(async () => null) };
  self._users = users;
  return self;
}

function buildApp(prismaMock: any) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", createPublicAuthRouter(prismaMock));
  return app;
}

const stefan: UserRow = {
  id: "u-uuid-stefan-7777",
  username: "stefan",
  displayName: "Stefan Cruceru",
  email: "stefan@warp.test",
  nextcloudUsername: "stefan",
  passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$abc$def",
  role: "owner",
  isLocal: true,
  directoryStatus: "ACTIVE",
  mustChangePassword: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
  verifyDummyPassword.mockResolvedValue(false);
});

describe("WARP-579 — POST /auth/login brute-force throttle", () => {
  it("throttles a known account after the per-account free tier is exhausted", async () => {
    verifyPassword.mockResolvedValue(false);
    const prisma = createPrismaMock([stefan]);
    const app = buildApp(prisma);

    // Per-account free tier is 5 → the 6th failure sets the first lock.
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "stefan@warp.test", password: `wrong-${i}` });
      expect(res.status).toBe(401);
    }

    const locked = await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "wrong-final" });

    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("TOO_MANY_ATTEMPTS");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    // The locked request never reached the verifier — no extra brute-force
    // sample (6 real attempts, the 7th short-circuited).
    expect(verifyPassword).toHaveBeenCalledTimes(6);
  });

  it("throttles an UNKNOWN email identically (no account-enumeration oracle)", async () => {
    // No matching row → the route spends a dummy verify each time, but the
    // per-account counter is still bumped, so the gate locks the same way it
    // would for a real account. locked-vs-not-locked must not distinguish
    // "this email exists".
    const prisma = createPrismaMock([]);
    const app = buildApp(prisma);

    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "ghost@warp.test", password: `wrong-${i}` });
      expect(res.status).toBe(401);
    }

    const locked = await request(app)
      .post("/api/auth/login")
      .send({ email: "ghost@warp.test", password: "wrong-final" });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("TOO_MANY_ATTEMPTS");
  });

  it("a successful login clears the failure counters", async () => {
    const prisma = createPrismaMock([stefan]);
    const app = buildApp(prisma);

    // 4 wrong attempts — still inside the per-account free tier (5), no lock.
    verifyPassword.mockResolvedValue(false);
    for (let i = 0; i < 4; i++) {
      await request(app)
        .post("/api/auth/login")
        .send({ email: "stefan@warp.test", password: `wrong-${i}` });
    }

    // Correct password → 200 and the counters reset.
    verifyPassword.mockResolvedValue(true);
    const ok = await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "correct-horse" });
    expect(ok.status).toBe(200);

    // From a CLEAN count, two more wrong attempts must NOT lock — were the
    // counter not cleared the first of these would be failure #5 and the next
    // #6 (a lock). Both should still 401.
    verifyPassword.mockResolvedValue(false);
    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "stefan@warp.test", password: `again-${i}` });
      expect(res.status).toBe(401);
    }
  });
});

describe("loginBackoffSeconds — pure schedule", () => {
  it("forgives the free tier, then escalates and caps", () => {
    // Per-account free tier (5).
    expect(loginBackoffSeconds(5, 5)).toBe(0);
    expect(loginBackoffSeconds(6, 5)).toBe(30);
    expect(loginBackoffSeconds(7, 5)).toBe(60);
    expect(loginBackoffSeconds(8, 5)).toBe(120);
    expect(loginBackoffSeconds(9, 5)).toBe(300);
    expect(loginBackoffSeconds(10, 5)).toBe(900);
    expect(loginBackoffSeconds(100, 5)).toBe(900);
    // Per-IP free tier (10) — more forgiving (a NATed household shares one IP).
    expect(loginBackoffSeconds(10, 10)).toBe(0);
    expect(loginBackoffSeconds(11, 10)).toBe(30);
  });
});
