/**
 * PR #375 — POST /auth/login TOTP/recovery gate.
 *
 * After the ADR-012 argon2id password verify passes, if the user has TOTP
 * ENABLED (TotpCredential.confirmedAt non-null) the login must require a
 * valid second factor — a TOTP code OR an unused recovery code — BEFORE
 * issuing the session cookie. A missing/invalid second factor returns a
 * distinguishable 401 (code: TOTP_REQUIRED) so the dashboard can prompt
 * for the code; no cookies are set.
 *
 * Users WITHOUT TOTP enabled are unaffected (no second factor demanded).
 *
 * Strategy mirrors auth.directory-login.test.ts: real route via supertest,
 * NC client / nc-session / password.service / jwt / activity mocked, the
 * TOTP + recovery services mocked at their module boundary, in-memory
 * Prisma mock extended with totpCredential + recoveryCode delegates.
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

vi.mock("../services/nextcloud.client.js", () => ({
  ncCheckSetupRequired: vi.fn(),
  ncInstallAndCreateAdmin: vi.fn().mockResolvedValue(undefined),
  ncLoginWithCredentials: vi.fn().mockResolvedValue({ token: "nc", loginName: "x" }),
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
  NextcloudUserExistsError: class extends Error {},
}));

const storeNcToken = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: (...a: unknown[]) => storeNcToken(...a),
  getNcToken: vi.fn().mockResolvedValue(null),
  deleteNcToken: vi.fn().mockResolvedValue(undefined),
  touchNcToken: vi.fn().mockResolvedValue(undefined),
  resolveNcToken: vi.fn().mockResolvedValue("tok"),
}));

const verifyPassword = vi.fn();
const verifyDummyPassword = vi.fn().mockResolvedValue(false);
vi.mock("../services/password.service.js", () => ({
  verifyPassword: (...a: unknown[]) => verifyPassword(...a),
  verifyDummyPassword: (...a: unknown[]) => verifyDummyPassword(...a),
  hashPassword: vi.fn().mockResolvedValue("$argon2id$mock"),
}));

const verifyTotpCode = vi.fn();
vi.mock("../services/totp.service.js", () => ({
  verifyTotpCode: (...a: unknown[]) => verifyTotpCode(...a),
  generateTotpEnrollment: vi.fn(),
  encryptTotpSecret: vi.fn(),
  decryptTotpSecret: (...a: unknown[]) => `decrypted:${a[0]}`,
  TOTP_ISSUER: "Droplet",
}));

const findMatchingRecoveryCodeHash = vi.fn();
vi.mock("../services/recovery.service.js", () => ({
  findMatchingRecoveryCodeHash: (...a: unknown[]) => findMatchingRecoveryCodeHash(...a),
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

import { createPublicAuthRouter } from "./auth.js";
import { verifyAccessToken } from "../services/jwt.service.js";

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  nextcloudUsername: string | null;
  passwordHash: string | null;
  role: string;
  isLocal: boolean;
  createdAt: Date;
  updatedAt: Date;
}
interface TotpRow {
  id: string;
  userId: string;
  secretEnc: string;
  confirmedAt: Date | null;
}
interface RecoveryRow {
  id: string;
  userId: string;
  codeHash: string;
  usedAt: Date | null;
}

function createPrismaMock(opts: {
  users?: UserRow[];
  totp?: TotpRow[];
  recovery?: RecoveryRow[];
}) {
  const users = [...(opts.users ?? [])];
  const totp = [...(opts.totp ?? [])];
  const recovery = [...(opts.recovery ?? [])];
  const self: any = {};
  self.user = {
    findUnique: vi.fn(async ({ where }: { where: any }) => {
      if (where.email !== undefined) return users.find((u) => u.email === where.email) ?? null;
      if (where.id !== undefined) return users.find((u) => u.id === where.id) ?? null;
      return null;
    }),
  };
  self.totpCredential = {
    findUnique: vi.fn(async ({ where }: { where: any }) =>
      totp.find((t) => t.userId === where.userId) ?? null,
    ),
  };
  self.recoveryCode = {
    findMany: vi.fn(async ({ where }: { where: any }) =>
      recovery.filter(
        (r) => r.userId === where.userId && (where.usedAt === null ? r.usedAt === null : true),
      ),
    ),
    update: vi.fn(async ({ where, data }: { where: any; data: any }) => {
      const row = recovery.find((r) => r.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    }),
  };
  self._recovery = recovery;
  return self;
}

function buildApp(prismaMock: any) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", createPublicAuthRouter(prismaMock));
  return app;
}

function sessionCookie(res: request.Response): string | undefined {
  const sc = res.headers["set-cookie"];
  const cookies = Array.isArray(sc) ? sc : [sc ?? ""];
  return cookies.find((c) => c?.startsWith("droplet_session="));
}
function decode(res: request.Response) {
  const c = sessionCookie(res);
  if (!c) throw new Error("no session cookie");
  const raw = c.split(";")[0]!.replace("droplet_session=", "");
  const d = verifyAccessToken(raw);
  if (!d) throw new Error("verifyAccessToken null");
  return d;
}

const stefan: UserRow = {
  id: "u-stefan",
  username: "stefan",
  displayName: "Stefan",
  email: "stefan@warp.test",
  nextcloudUsername: "stefan",
  passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$abc$def",
  role: "owner",
  isLocal: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyDummyPassword.mockResolvedValue(false);
});

describe("login TOTP gate — user WITHOUT TOTP enabled", () => {
  it("no TOTP credential at all → password verify is the only gate, session issued", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    const prisma = createPrismaMock({ users: [stefan], totp: [] });
    const res = await request(buildApp(prisma))
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "pw" });

    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeDefined();
    expect(verifyTotpCode).not.toHaveBeenCalled();
  });

  it("TOTP row exists but is UNCONFIRMED (enrollment pending) → not required", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    const prisma = createPrismaMock({
      users: [stefan],
      totp: [{ id: "t1", userId: "u-stefan", secretEnc: "enc", confirmedAt: null }],
    });
    const res = await request(buildApp(prisma))
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "pw" });

    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeDefined();
    expect(verifyTotpCode).not.toHaveBeenCalled();
  });
});

describe("login TOTP gate — user WITH TOTP enabled", () => {
  const enabledTotp: TotpRow = {
    id: "t1",
    userId: "u-stefan",
    secretEnc: "enc-secret",
    confirmedAt: new Date("2026-01-01"),
  };

  it("no second factor supplied → 401 TOTP_REQUIRED, NO session cookie", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    const prisma = createPrismaMock({ users: [stefan], totp: [enabledTotp] });
    const res = await request(buildApp(prisma))
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "pw" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOTP_REQUIRED");
    expect(sessionCookie(res)).toBeUndefined();
  });

  it("valid TOTP code → 200, session issued, secret decrypted before verify", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    verifyTotpCode.mockResolvedValueOnce(true);
    const prisma = createPrismaMock({ users: [stefan], totp: [enabledTotp] });
    const res = await request(buildApp(prisma))
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "pw", totp: "123456" });

    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeDefined();
    // Verified against the DECRYPTED secret, not the stored ciphertext.
    expect(verifyTotpCode).toHaveBeenCalledWith("decrypted:enc-secret", "123456");
  });

  it("invalid TOTP code → 401 TOTP_REQUIRED, no session", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    verifyTotpCode.mockResolvedValueOnce(false);
    const prisma = createPrismaMock({ users: [stefan], totp: [enabledTotp] });
    const res = await request(buildApp(prisma))
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "pw", totp: "000000" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOTP_REQUIRED");
    expect(sessionCookie(res)).toBeUndefined();
  });

  it("valid recovery code → 200 AND the matched code row is marked used", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    findMatchingRecoveryCodeHash.mockResolvedValueOnce("hash-2");
    const prisma = createPrismaMock({
      users: [stefan],
      totp: [enabledTotp],
      recovery: [
        { id: "rc1", userId: "u-stefan", codeHash: "hash-1", usedAt: null },
        { id: "rc2", userId: "u-stefan", codeHash: "hash-2", usedAt: null },
      ],
    });
    const res = await request(buildApp(prisma))
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "pw", recoveryCode: "aaaa-bbbb" });

    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeDefined();
    // Exactly the matched row (id rc2 → hash-2) is consumed.
    expect(prisma.recoveryCode.update).toHaveBeenCalledTimes(1);
    const call = prisma.recoveryCode.update.mock.calls[0]![0];
    expect(call.where).toEqual({ id: "rc2" });
    expect(call.data.usedAt).toBeInstanceOf(Date);
  });

  it("wrong recovery code → 401 TOTP_REQUIRED, nothing consumed", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    findMatchingRecoveryCodeHash.mockResolvedValueOnce(null);
    const prisma = createPrismaMock({
      users: [stefan],
      totp: [enabledTotp],
      recovery: [{ id: "rc1", userId: "u-stefan", codeHash: "hash-1", usedAt: null }],
    });
    const res = await request(buildApp(prisma))
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "pw", recoveryCode: "zzzz-zzzz" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOTP_REQUIRED");
    expect(prisma.recoveryCode.update).not.toHaveBeenCalled();
  });

  it("a valid second factor stamps lastMfaAt into the access token", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    verifyTotpCode.mockResolvedValueOnce(true);
    const prisma = createPrismaMock({ users: [stefan], totp: [enabledTotp] });
    const res = await request(buildApp(prisma))
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "pw", totp: "123456" });

    const decoded = decode(res) as { lastMfaAt?: string };
    expect(decoded.lastMfaAt).toBeTruthy();
    // A recent ISO timestamp.
    expect(Date.now() - new Date(decoded.lastMfaAt!).getTime()).toBeLessThan(10_000);
  });

  it("wrong PASSWORD still 401s before the TOTP gate is even consulted", async () => {
    verifyPassword.mockResolvedValueOnce(false);
    const prisma = createPrismaMock({ users: [stefan], totp: [enabledTotp] });
    const res = await request(buildApp(prisma))
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "wrong", totp: "123456" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
    expect(verifyTotpCode).not.toHaveBeenCalled();
  });
});
