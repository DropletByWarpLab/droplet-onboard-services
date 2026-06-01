/**
 * PR #375 — protected TOTP enrollment + verify + recovery endpoints.
 *
 *   POST /auth/totp/enroll  → mint a secret, store it ENCRYPTED, return the
 *                             otpauth:// URI + a QR data-URL. Re-enroll
 *                             before confirmation re-mints; after the factor
 *                             is enabled it 409s (no silent secret rotation).
 *   POST /auth/totp/verify  → verify a 6-digit code; on the FIRST success
 *                             mark the factor enabled (confirmedAt) and mint
 *                             one-time recovery codes (shown once). A later
 *                             verify is a re-challenge — no new codes.
 *   POST /auth/recovery     → consume one unused recovery code (step-up for
 *                             an already-authenticated session).
 *
 * The TOTP + recovery services are mocked at their boundary; the in-memory
 * Prisma mock backs totpCredential + recoveryCode. req.user is injected by
 * a synthetic middleware (mirrors auth.invites.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
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
  ncInstallAndCreateAdmin: vi.fn(),
  ncLoginWithCredentials: vi.fn(),
  ncDeleteAppPassword: vi.fn().mockResolvedValue(undefined),
  ncGetCurrentUser: vi.fn(),
  ncCreateUser: vi.fn(),
  ncDeleteUser: vi.fn(),
  ncListUsers: vi.fn(),
  ncUpdateUser: vi.fn(),
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

vi.mock("../services/password.service.js", () => ({
  verifyPassword: vi.fn(),
  verifyDummyPassword: vi.fn(),
  hashPassword: vi.fn(),
}));

const generateTotpEnrollment = vi.fn();
const encryptTotpSecret = vi.fn();
const verifyTotpCode = vi.fn();
vi.mock("../services/totp.service.js", () => ({
  generateTotpEnrollment: (...a: unknown[]) => generateTotpEnrollment(...a),
  encryptTotpSecret: (...a: unknown[]) => encryptTotpSecret(...a),
  decryptTotpSecret: (...a: unknown[]) => `decrypted:${a[0]}`,
  verifyTotpCode: (...a: unknown[]) => verifyTotpCode(...a),
  TOTP_ISSUER: "Droplet",
}));

const generateRecoveryCodes = vi.fn();
const findMatchingRecoveryCodeHash = vi.fn();
vi.mock("../services/recovery.service.js", () => ({
  generateRecoveryCodes: (...a: unknown[]) => generateRecoveryCodes(...a),
  findMatchingRecoveryCodeHash: (...a: unknown[]) => findMatchingRecoveryCodeHash(...a),
  RECOVERY_CODE_COUNT: 10,
}));

vi.mock("../services/jwt.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/jwt.service.js")>(
    "../services/jwt.service.js",
  );
  return { ...actual, denyRefreshToken: vi.fn(), claimRefreshRotation: vi.fn().mockResolvedValue(true) };
});

const recordActivity = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...a: unknown[]) => recordActivity(...a),
}));
vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

import { createProtectedAuthRouter } from "./auth.js";

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

function createPrismaMock(opts: { totp?: TotpRow[]; recovery?: RecoveryRow[] } = {}) {
  const totp = [...(opts.totp ?? [])];
  let recovery = [...(opts.recovery ?? [])];
  let seq = 100;
  const self: any = {};
  self.totpCredential = {
    findUnique: vi.fn(async ({ where }: { where: any }) =>
      totp.find((t) => t.userId === where.userId) ?? null,
    ),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = totp.find((t) => t.userId === where.userId);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row: TotpRow = {
        id: `t-${seq++}`,
        userId: where.userId,
        secretEnc: create.secretEnc,
        confirmedAt: create.confirmedAt ?? null,
      };
      totp.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = totp.find((t) => t.id === where.id || t.userId === where.userId);
      if (row) Object.assign(row, data);
      return row;
    }),
  };
  self.recoveryCode = {
    findMany: vi.fn(async ({ where }: any) =>
      recovery.filter(
        (r) => r.userId === where.userId && (where.usedAt === null ? r.usedAt === null : true),
      ),
    ),
    deleteMany: vi.fn(async ({ where }: any) => {
      const before = recovery.length;
      recovery = recovery.filter((r) => r.userId !== where.userId);
      return { count: before - recovery.length };
    }),
    createMany: vi.fn(async ({ data }: any) => {
      for (const d of data) recovery.push({ id: `r-${seq++}`, usedAt: null, ...d });
      return { count: data.length };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = recovery.find((r) => r.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    }),
    // Atomic conditional consume guarded by usedAt:null. `count` reflects
    // rows actually flipped; 0 means a concurrent racer already used it.
    updateMany: vi.fn(async ({ where, data }: any) => {
      const matched = recovery.filter(
        (r) =>
          r.id === where.id &&
          (where.usedAt === null ? r.usedAt === null : true),
      );
      for (const row of matched) Object.assign(row, data);
      return { count: matched.length };
    }),
  };
  self._totp = totp;
  self._recovery = () => recovery;
  return self;
}

function buildApp(prismaMock: any, user: any = { id: "u-1", username: "stefan", displayName: "Stefan", role: "owner" }) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
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

beforeEach(() => {
  vi.clearAllMocks();
  generateTotpEnrollment.mockReturnValue({
    secret: "BASE32SECRET",
    otpauthUri: "otpauth://totp/Droplet:stefan?secret=BASE32SECRET&issuer=Droplet",
  });
  encryptTotpSecret.mockReturnValue("ENC(BASE32SECRET)");
  generateRecoveryCodes.mockResolvedValue({
    plaintext: Array.from({ length: 10 }, (_, i) => `code-${i}`),
    hashes: Array.from({ length: 10 }, (_, i) => `hash-${i}`),
  });
});

describe("POST /auth/totp/enroll", () => {
  it("mints a secret, stores it ENCRYPTED, returns otpauth URI + QR data-url", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma)).post("/api/auth/totp/enroll").send({});

    expect(res.status).toBe(200);
    expect(res.body.otpauthUri).toContain("otpauth://totp/");
    expect(res.body.qrDataUrl.startsWith("data:image/")).toBe(true);
    // The secret is carried ONLY inside the otpauth URI (and its QR
    // rendering) for the authenticator app — there is no standalone
    // `secret` field the client could mishandle / log.
    expect(res.body.secret).toBeUndefined();

    // Persisted as the ENCRYPTED blob, confirmedAt still pending.
    expect(encryptTotpSecret).toHaveBeenCalledWith("BASE32SECRET");
    const stored = prisma._totp[0];
    expect(stored.secretEnc).toBe("ENC(BASE32SECRET)");
    expect(stored.confirmedAt).toBeNull();
  });

  it("re-enroll before confirmation re-mints the secret (still pending)", async () => {
    const prisma = createPrismaMock({
      totp: [{ id: "t1", userId: "u-1", secretEnc: "OLD", confirmedAt: null }],
    });
    const res = await request(buildApp(prisma)).post("/api/auth/totp/enroll").send({});
    expect(res.status).toBe(200);
    expect(prisma._totp[0].secretEnc).toBe("ENC(BASE32SECRET)");
  });

  it("409s when TOTP is already enabled (no silent secret rotation)", async () => {
    const prisma = createPrismaMock({
      totp: [{ id: "t1", userId: "u-1", secretEnc: "OLD", confirmedAt: new Date() }],
    });
    const res = await request(buildApp(prisma)).post("/api/auth/totp/enroll").send({});
    expect(res.status).toBe(409);
    expect(encryptTotpSecret).not.toHaveBeenCalled();
  });

  it("401s when there is no authenticated user", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, null)).post("/api/auth/totp/enroll").send({});
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/totp/verify", () => {
  it("first valid code → enables the factor (confirmedAt set) + returns one-time recovery codes", async () => {
    verifyTotpCode.mockResolvedValueOnce(true);
    const prisma = createPrismaMock({
      totp: [{ id: "t1", userId: "u-1", secretEnc: "enc", confirmedAt: null }],
    });
    const res = await request(buildApp(prisma))
      .post("/api/auth/totp/verify")
      .send({ code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.recoveryCodes).toHaveLength(10);
    // Verified against the decrypted secret.
    expect(verifyTotpCode).toHaveBeenCalledWith("decrypted:enc", "123456");
    // Factor now enabled.
    expect(prisma._totp[0].confirmedAt).toBeInstanceOf(Date);
    // Fresh codes minted + persisted (old ones cleared first).
    expect(prisma.recoveryCode.deleteMany).toHaveBeenCalledWith({ where: { userId: "u-1" } });
    expect(prisma.recoveryCode.createMany).toHaveBeenCalledTimes(1);
  });

  it("invalid code on a pending enrollment → 401, factor stays disabled, no codes", async () => {
    verifyTotpCode.mockResolvedValueOnce(false);
    const prisma = createPrismaMock({
      totp: [{ id: "t1", userId: "u-1", secretEnc: "enc", confirmedAt: null }],
    });
    const res = await request(buildApp(prisma))
      .post("/api/auth/totp/verify")
      .send({ code: "000000" });

    expect(res.status).toBe(401);
    expect(prisma._totp[0].confirmedAt).toBeNull();
    expect(generateRecoveryCodes).not.toHaveBeenCalled();
  });

  it("verify with no enrollment row → 400 (enroll first)", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma))
      .post("/api/auth/totp/verify")
      .send({ code: "123456" });
    expect(res.status).toBe(400);
  });

  it("valid code when ALREADY enabled → re-challenge 200, no NEW recovery codes", async () => {
    verifyTotpCode.mockResolvedValueOnce(true);
    const prisma = createPrismaMock({
      totp: [{ id: "t1", userId: "u-1", secretEnc: "enc", confirmedAt: new Date("2026-01-01") }],
    });
    const res = await request(buildApp(prisma))
      .post("/api/auth/totp/verify")
      .send({ code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.recoveryCodes).toBeUndefined();
    expect(generateRecoveryCodes).not.toHaveBeenCalled();
  });

  it("missing/garbage code → 400 validation error", async () => {
    const prisma = createPrismaMock({
      totp: [{ id: "t1", userId: "u-1", secretEnc: "enc", confirmedAt: null }],
    });
    const res = await request(buildApp(prisma)).post("/api/auth/totp/verify").send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/recovery", () => {
  it("valid unused code → 200 and that code row is marked used", async () => {
    findMatchingRecoveryCodeHash.mockResolvedValueOnce("hash-2");
    const prisma = createPrismaMock({
      recovery: [
        { id: "rc1", userId: "u-1", codeHash: "hash-1", usedAt: null },
        { id: "rc2", userId: "u-1", codeHash: "hash-2", usedAt: null },
      ],
    });
    const res = await request(buildApp(prisma))
      .post("/api/auth/recovery")
      .send({ code: "aaaa-bbbb" });

    expect(res.status).toBe(200);
    // Consumed via an ATOMIC conditional update guarded by usedAt:null.
    expect(prisma.recoveryCode.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.recoveryCode.updateMany.mock.calls[0]![0].where).toEqual({
      id: "rc2",
      usedAt: null,
    });
  });

  it("no match → 401, nothing consumed", async () => {
    findMatchingRecoveryCodeHash.mockResolvedValueOnce(null);
    const prisma = createPrismaMock({
      recovery: [{ id: "rc1", userId: "u-1", codeHash: "hash-1", usedAt: null }],
    });
    const res = await request(buildApp(prisma))
      .post("/api/auth/recovery")
      .send({ code: "zzzz-zzzz" });

    expect(res.status).toBe(401);
    expect(prisma.recoveryCode.updateMany).not.toHaveBeenCalled();
  });

  // ── Single-use race (QA-flagged on #375) ──
  // A code that another request already consumed between our read and our
  // write must fail the factor (401 RECOVERY_INVALID), not re-authenticate.
  // The atomic guarded update returns count 0 → treat as already used.
  it("already-used code (lost the race) → 401 RECOVERY_INVALID", async () => {
    findMatchingRecoveryCodeHash.mockResolvedValueOnce("hash-1");
    const prisma = createPrismaMock({
      // The findMany read still surfaces it as unused (stale read), but the
      // row was consumed by a concurrent racer before our guarded update.
      recovery: [{ id: "rc1", userId: "u-1", codeHash: "hash-1", usedAt: null }],
    });
    // Simulate the racer winning: the guarded updateMany flips nothing.
    prisma.recoveryCode.updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await request(buildApp(prisma))
      .post("/api/auth/recovery")
      .send({ code: "aaaa-bbbb" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("RECOVERY_INVALID");
  });
});
