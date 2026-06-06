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
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
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

import {
  createPublicAuthRouter,
  createProtectedAuthRouter,
} from "./auth.js";
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

beforeEach(() => {
  vi.clearAllMocks();
  hashPassword.mockImplementation(async (_pw: string) => "$argon2id$v=19$m=19456,t=2,p=1$bmV3c2FsdA$bmV3aGFzaA");
  verifyDummyPassword.mockResolvedValue(false);
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
