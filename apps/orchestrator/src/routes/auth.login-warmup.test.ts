/**
 * WARP-1954 — silent model warm-up on login.
 *
 * The local chat model loads lazily on the first completion, so after an
 * idle unload (or a reboot) the first chat answer of the day eats the full
 * cold-load latency. WARP-1041/1772 already ship a debounced,
 * runtime-agnostic (Ollama + DMR) `warmDefaultModel()` — but until now it
 * only fired at orchestrator startup, on pull-complete, and from the setup
 * wizard. This file covers the new trigger: a COMPLETED `POST /auth/login`
 * fires it fire-and-forget, so the model is resident by the time the user
 * reaches chat. Covered:
 *
 *   • A successful login fires exactly one warm-up (strictly after the
 *     response — setImmediate — so login latency never includes the load).
 *   • Failed logins (wrong password, unknown email, wrong TOTP) fire
 *     nothing: the warm-up must never become a pre-auth probe surface.
 *   • A rejecting warm-up implementation never surfaces to the login
 *     response (the `.catch` guard on the fire-and-forget call).
 *
 * Harness mirrors auth.login-throttle.test.ts (real route via supertest,
 * NC client + password.service + activity mocked, stateful in-memory cache
 * double, in-memory Prisma mock) + a mocked model-readiness.service.
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
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// The unit under test: the login route must call this exactly once per
// COMPLETED login, and never await it on the response path.
const warmDefaultModel = vi.hoisted(() =>
  vi.fn(async (): Promise<void> => undefined),
);
vi.mock("../services/model-readiness.service.js", () => ({
  warmDefaultModel: () => warmDefaultModel(),
}));

// Stateful in-memory cache double — createSession / the login backoff need
// real get/set/del/incr semantics, not a null stub.
const cacheStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown) => {
    cacheStore.set(key, value);
  }),
  cacheDel: vi.fn(async (key: string) => {
    cacheStore.delete(key);
  }),
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

// TOTP second factor: default to a WRONG code so the wrong-TOTP case is a
// completed-password / failed-second-factor login (must not warm).
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

vi.mock("pino", () => ({
  default: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createPublicAuthRouter } from "./auth.js";

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

/** The warm-up rides a setImmediate strictly after res.json — flush the
 *  macrotask queue before asserting on the spy. */
async function flushWarmTrigger(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
  verifyDummyPassword.mockResolvedValue(false);
  warmDefaultModel.mockImplementation(async () => undefined);
});

describe("WARP-1954 — POST /auth/login model warm-up", () => {
  it("fires exactly one warm-up after a completed login", async () => {
    verifyPassword.mockResolvedValue(true);
    const app = buildApp(createPrismaMock([stefan]));

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "correct" });
    expect(res.status).toBe(200);

    await flushWarmTrigger();
    expect(warmDefaultModel).toHaveBeenCalledTimes(1);
  });

  it("never warms on a wrong password", async () => {
    verifyPassword.mockResolvedValue(false);
    const app = buildApp(createPrismaMock([stefan]));

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "wrong" });
    expect(res.status).toBe(401);

    await flushWarmTrigger();
    expect(warmDefaultModel).not.toHaveBeenCalled();
  });

  it("never warms on an unknown email (no pre-auth probe surface)", async () => {
    verifyPassword.mockResolvedValue(false);
    const app = buildApp(createPrismaMock([stefan]));

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@warp.test", password: "whatever" });
    expect(res.status).toBe(401);

    await flushWarmTrigger();
    expect(warmDefaultModel).not.toHaveBeenCalled();
  });

  it("never warms when the second factor fails (password ok, TOTP wrong)", async () => {
    verifyPassword.mockResolvedValue(true);
    verifyTotpCode.mockResolvedValue(false);
    const app = buildApp(
      createPrismaMock([stefan], {
        userId: stefan.id,
        confirmedAt: new Date(),
        secretEnc: "enc",
      }),
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "correct", totp: "000000" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOTP_REQUIRED");

    await flushWarmTrigger();
    expect(warmDefaultModel).not.toHaveBeenCalled();
  });

  it("a rejecting warm-up never surfaces to the login response", async () => {
    verifyPassword.mockResolvedValue(true);
    warmDefaultModel.mockImplementation(async () => {
      throw new Error("runtime unreachable");
    });
    const app = buildApp(createPrismaMock([stefan]));

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "correct" });
    expect(res.status).toBe(200);
    expect(res.body.user?.username).toBe("stefan");

    await flushWarmTrigger();
    expect(warmDefaultModel).toHaveBeenCalledTimes(1);
  });
});
