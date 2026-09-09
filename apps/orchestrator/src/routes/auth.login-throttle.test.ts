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
import { createHash } from "node:crypto";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

// CodeQL js/missing-rate-limiting sweep — POST /auth/login now carries the
// shared `authRateLimit` preset (express-rate-limit, keyed on req.ip). This
// file tests the Redis-backed WARP-579 lockout underneath it, and one case
// ("caller IP cannot be resolved") deliberately strips req.ip, which
// express-rate-limit answers with an error (500 here, no error handler)
// before the handler can log the per-IP warning under test. Swap the presets
// for pass-throughs in this file only; middleware/rate-limit.test.ts covers
// the limiter itself and the other auth route files exercise the real one.
vi.mock("../middleware/rate-limit.js", () => {
  const passThrough = Object.assign(
    (_req: unknown, _res: unknown, next: () => void) => next(),
    { resetKey: () => undefined },
  );
  return {
    authRateLimit: passThrough,
    sensitiveRateLimit: passThrough,
    standardRateLimit: passThrough,
  };
});

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "legacy",
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    REDIS_URL: "redis://localhost:6379",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
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
  // cacheIncr is a true fixed-window counter (finding 5); the in-memory double
  // doesn't model TTL expiry, so the window semantics are a no-op here — the
  // counter semantics under test (escalating lockout) are what we exercise.
  cacheIncr: vi.fn(async (key: string, _ttl?: number) => {
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

// TOTP second-factor: verifyTotpCode is the gate the finding-1 brute-force
// targets. Default to a wrong code (false) so each attempt is a 2FA failure.
const verifyTotpCode = vi.fn().mockResolvedValue(false);
vi.mock("../services/totp.service.js", () => ({
  TOTP_ISSUER: "Droplet",
  generateTotpEnrollment: vi.fn(),
  encryptTotpSecret: vi.fn(),
  decryptTotpSecret: vi.fn(() => "JBSWY3DPEHPK3PXP"),
  verifyTotpCode: (...a: unknown[]) => verifyTotpCode(...a),
}));

vi.mock("../services/recovery.service.js", () => ({
  generateRecoveryCodes: vi.fn(),
  findMatchingRecoveryCodeHash: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

// Capture logger.warn so finding 3 (per-IP gate inactive when the caller IP is
// unresolved) can assert the degraded state is observable. pino is the only
// logger the auth route constructs at module load.
const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("pino", () => ({
  default: () => ({
    info: vi.fn(),
    warn: loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createPublicAuthRouter, loginBackoffSeconds } from "./auth.js";

/** sha256 hex of the normalized login email — the account key namespace must
 *  hash the email (finding 4), never interpolate it as plaintext. */
function accountFailsKey(email: string): string {
  const hashed = createHash("sha256").update(email).digest("hex");
  return `ratelimit:login:account:fails:${hashed}`;
}

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

function createPrismaMock(
  seed: UserRow[] = [],
  totpCred: { userId: string; confirmedAt: Date | null; secretEnc: string } | null = null,
) {
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
    // WARP-233 pre-backfill fallback probe from findUserByEmail: plaintext
    // equality on rows without a blind index.
    findFirst: vi.fn(async ({ where }: { where: any }) =>
      users.find((u: any) => u.email === where.email) ?? null,
    ),
  };
  self.totpCredential = {
    findUnique: vi.fn(async ({ where }: { where: any }) =>
      totpCred && totpCred.userId === where.userId ? totpCred : null,
    ),
  };
  self.recoveryCode = {
    findMany: vi.fn(async () => []),
    updateMany: vi.fn(async () => ({ count: 0 })),
  };
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

  // ── Finding 1 — TOTP brute-force must accrue toward the same lockout ──────
  it("repeated wrong-TOTP-after-correct-password attempts accrue toward lockout and eventually 429", async () => {
    // Password is ALWAYS correct; the user has TOTP enabled; every code is wrong.
    verifyPassword.mockResolvedValue(true);
    verifyTotpCode.mockResolvedValue(false);
    const prisma = createPrismaMock([stefan], {
      userId: stefan.id,
      confirmedAt: new Date(),
      secretEnc: "enc",
    });
    const app = buildApp(prisma);

    // Per-account free tier is 5 → the 6th wrong-TOTP attempt arms the lock.
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "stefan@warp.test", password: "correct-horse", totp: `00000${i}` });
      // The password is right but the second factor fails → 401 TOTP_REQUIRED.
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("TOTP_REQUIRED");
    }

    // The 7th attempt is throttled at the gate BEFORE any verify work — the
    // wrong-TOTP attempts accrued toward the same lockout that guards the
    // password gate, so the attacker cannot spin through ~10^6 codes for free.
    const locked = await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "correct-horse", totp: "999999" });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("TOO_MANY_ATTEMPTS");
    // 6 real password verifies — the throttled 7th short-circuited before verify.
    expect(verifyPassword).toHaveBeenCalledTimes(6);

    // A fully-successful login (right password AND right code) still clears the
    // account counter so a legit user isn't held under a stale lock — prove a
    // fresh wrong-TOTP run after success starts from zero (would otherwise be
    // already-locked).
    cacheStore.clear();
    verifyTotpCode.mockResolvedValueOnce(true);
    const ok = await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "correct-horse", totp: "123456" });
    expect(ok.status).toBe(200);
    // Account counter cleared on full success: 5 more wrong-TOTP attempts stay
    // inside the free tier (no lock yet).
    verifyTotpCode.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "stefan@warp.test", password: "correct-horse", totp: `11111${i}` });
      expect(res.status).toBe(401);
    }
  });

  // ── Finding 2 — one account's success must not zero the shared-IP gate ────
  it("a successful login for account A does NOT reset the per-IP counter throttling account B on the same IP", async () => {
    const attacker: UserRow = {
      ...stefan,
      id: "u-uuid-attacker-9999",
      username: "mallory",
      email: "mallory@warp.test",
      nextcloudUsername: "mallory",
    };
    const prisma = createPrismaMock([attacker]);
    const app = buildApp(prisma);

    // Credential-stuffing spray: 9 failures against 9 DISTINCT victim emails
    // from the shared NAT IP. Distinct emails keep every per-ACCOUNT counter at
    // 1 (well under the account free tier of 5), so ONLY the per-IP counter
    // climbs. Per-IP free tier is 10 → no lock yet (the IP counter is at 9).
    verifyPassword.mockResolvedValue(false);
    for (let i = 0; i < 9; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: `victim-${i}@warp.test`, password: "spray" });
      expect(res.status).toBe(401);
    }

    // The attacker logs into their OWN account from the same IP. Pre-fix this
    // wiped the shared per-IP counter; now it must only clear the attacker's
    // ACCOUNT keys and leave the per-IP failure state intact.
    verifyPassword.mockResolvedValue(true);
    const ownLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "mallory@warp.test", password: "attacker-correct" });
    expect(ownLogin.status).toBe(200);

    // Two more distinct-email failures → IP counter reaches 11, arming the
    // per-IP lock; the NEXT attempt is throttled. (If the attacker's success
    // had zeroed the IP counter, the IP count would be 2 here and never lock.)
    verifyPassword.mockResolvedValue(false);
    for (let i = 9; i < 11; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: `victim-${i}@warp.test`, password: "spray" });
      expect(res.status).toBe(401);
    }

    const throttled = await request(app)
      .post("/api/auth/login")
      .send({ email: "victim-final@warp.test", password: "spray" });
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe("TOO_MANY_ATTEMPTS");
  });

  // ── Finding 4 — account Redis key is the sha256 hash, not plaintext email ─
  it("uses the sha256-hashed account key, never the plaintext email", async () => {
    verifyPassword.mockResolvedValue(false);
    const prisma = createPrismaMock([stefan]);
    const app = buildApp(prisma);

    await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "wrong" });

    const keys = [...cacheStore.keys()];
    // The hashed fails key exists…
    expect(keys).toContain(accountFailsKey("stefan@warp.test"));
    // …and the plaintext email never appears in ANY Redis key.
    expect(keys.some((k) => k.includes("stefan@warp.test"))).toBe(false);
  });
});

// ── Finding 3 — per-IP gate inactive when the caller IP is unresolved ──────
describe("WARP-579 — per-IP throttle observability when caller IP is null", () => {
  it("logs a warning when the caller IP cannot be resolved", async () => {
    verifyPassword.mockResolvedValue(false);
    const prisma = createPrismaMock([stefan]);

    // Build an app whose requests carry no resolvable IP: disable trust proxy
    // and strip req.ip / socket.remoteAddress so callerIpFromReq → undefined.
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use((req, _res, nextFn) => {
      Object.defineProperty(req, "ip", { value: undefined, configurable: true });
      Object.defineProperty(req, "socket", {
        value: { remoteAddress: undefined },
        configurable: true,
      });
      nextFn();
    });
    app.use("/api", createPublicAuthRouter(prisma));

    loggerWarn.mockClear();
    await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "wrong" });

    // Exactly one warn fired for this request, naming the inactive per-IP gate.
    const ipGateWarn = loggerWarn.mock.calls.find((call) =>
      JSON.stringify(call).toLowerCase().includes("per-ip"),
    );
    expect(ipGateWarn).toBeDefined();
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
