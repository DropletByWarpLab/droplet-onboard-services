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
    // Return a SNAPSHOT (like real Prisma), never the live row — the
    // WARP-991 race tests mutate the store between a route's read and its
    // guarded write, and a shared reference would leak those mutations
    // into the route's already-read `cred`.
    findUnique: vi.fn(async ({ where }: { where: any }) => {
      const row = totp.find((t) => t.userId === where.userId);
      return row ? { ...row } : null;
    }),
    create: vi.fn(async ({ data }: any) => {
      const row: TotpRow = {
        id: `t-${seq++}`,
        userId: data.userId,
        secretEnc: data.secretEnc,
        confirmedAt: data.confirmedAt ?? null,
      };
      totp.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = totp.find((t) => t.id === where.id || t.userId === where.userId);
      if (row) Object.assign(row, data);
      return row;
    }),
    // Atomic guarded writes (WARP-991): enroll re-mints ONLY while pending
    // (`confirmedAt: null`); verify confirms ONLY the exact secret it
    // validated. `count` reflects rows actually flipped — 0 means a
    // concurrent racer changed the row between the caller's read and here.
    updateMany: vi.fn(async ({ where, data }: any) => {
      const matched = totp.filter(
        (t) =>
          t.userId === where.userId &&
          ("confirmedAt" in where ? t.confirmedAt === where.confirmedAt : true) &&
          ("secretEnc" in where ? t.secretEnc === where.secretEnc : true),
      );
      for (const row of matched) Object.assign(row, data);
      return { count: matched.length };
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

  it("clears stale recovery codes from a prior confirmed-then-disabled factor (ORCH-07)", async () => {
    // A user who previously confirmed TOTP (and got recovery codes) then had
    // it disabled would leave RecoveryCode rows behind. Starting a fresh
    // enrollment must purge them so the invariant "codes exist iff a
    // confirmed factor exists" holds before verify re-mints.
    const prisma = createPrismaMock({
      recovery: [
        { id: "r1", userId: "u-1", codeHash: "stale-1", usedAt: null },
        { id: "r2", userId: "u-1", codeHash: "stale-2", usedAt: null },
      ],
    });
    const res = await request(buildApp(prisma)).post("/api/auth/totp/enroll").send({});

    expect(res.status).toBe(200);
    expect(prisma.recoveryCode.deleteMany).toHaveBeenCalledWith({ where: { userId: "u-1" } });
    // No codes survive the re-enroll; enroll does NOT mint new ones (verify does).
    expect(prisma._recovery()).toHaveLength(0);
    expect(generateRecoveryCodes).not.toHaveBeenCalled();
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

  // ── WARP-991 — enroll/verify TOCTOU ──
  // Live evidence (.87): the wizard's 2-step screen advanced on a genuine
  // confirmed verify, yet TotpCredential.confirmedAt read NULL afterwards —
  // a stale enroll landed AFTER the verify and its unconditional upsert
  // flipped the enabled factor back to pending (and wiped the just-minted
  // recovery codes). The owner believed 2FA was on; login skipped the
  // challenge. The write must be atomic on "still unconfirmed".
  it("enroll that races a concurrent verify 409s and does NOT unconfirm the factor (WARP-991)", async () => {
    const prisma = createPrismaMock({
      totp: [{ id: "t1", userId: "u-1", secretEnc: "ENC(A)", confirmedAt: null }],
      // The codes the concurrent verify just minted — they must survive.
      recovery: [{ id: "rc1", userId: "u-1", codeHash: "hash-1", usedAt: null }],
    });
    // The pre-check reads a PENDING row; the concurrent verify confirms the
    // factor before enroll's write lands. Simulated at the
    // generateTotpEnrollment boundary, which runs exactly between the two.
    generateTotpEnrollment.mockImplementationOnce(() => {
      prisma._totp[0].confirmedAt = new Date("2026-07-01T00:00:00Z");
      return {
        secret: "FRESH",
        otpauthUri: "otpauth://totp/Droplet:stefan?secret=FRESH&issuer=Droplet",
      };
    });

    const res = await request(buildApp(prisma)).post("/api/auth/totp/enroll").send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TOTP_ALREADY_ENABLED");
    // The confirmed factor is untouched: same secret, still enabled…
    expect(prisma._totp[0].secretEnc).toBe("ENC(A)");
    expect(prisma._totp[0].confirmedAt).not.toBeNull();
    // …and the recovery codes the verify minted survive.
    expect(prisma._recovery()).toHaveLength(1);
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

  // ── WARP-991 — the mirror race: verify vs a concurrent re-enroll ──
  // The code checked out against secret A, but a concurrent re-enroll
  // rotated the stored secret to B between verify's read and its confirm
  // write. A blind `update where {userId}` would enable a factor whose
  // secret no authenticator app ever saw — locking the owner out at the
  // next login. The guarded confirm must fail closed as a wrong code.
  it("verify that races a concurrent re-enroll 401s and does NOT confirm the rotated secret (WARP-991)", async () => {
    const prisma = createPrismaMock({
      totp: [{ id: "t1", userId: "u-1", secretEnc: "ENC(A)", confirmedAt: null }],
    });
    verifyTotpCode.mockImplementationOnce(async () => {
      // The re-enroll wins between our read and our confirm write.
      prisma._totp[0].secretEnc = "ENC(B)";
      return true;
    });

    const res = await request(buildApp(prisma))
      .post("/api/auth/totp/verify")
      .send({ code: "123456" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOTP_INVALID");
    // The rotated enrollment stays pending — nothing was confirmed blind.
    expect(prisma._totp[0].confirmedAt).toBeNull();
    expect(generateRecoveryCodes).not.toHaveBeenCalled();
  });

  // Two concurrent FIRST verifies of the same enrollment: the loser's
  // guarded confirm flips nothing (already confirmed), but the code was
  // correct for the live secret — answer like a re-challenge (the winner's
  // response carried the one-time codes), never a false "Invalid code".
  it("a first-verify that loses the confirm race answers like a re-challenge (WARP-991)", async () => {
    const prisma = createPrismaMock({
      totp: [{ id: "t1", userId: "u-1", secretEnc: "ENC(A)", confirmedAt: null }],
    });
    verifyTotpCode.mockImplementationOnce(async () => {
      // The other verify wins the confirm between our read and our write.
      prisma._totp[0].confirmedAt = new Date("2026-07-01T00:00:00Z");
      return true;
    });

    const res = await request(buildApp(prisma))
      .post("/api/auth/totp/verify")
      .send({ code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    // No second set of recovery codes — the winner already showed them.
    expect(res.body.recoveryCodes).toBeUndefined();
    expect(generateRecoveryCodes).not.toHaveBeenCalled();
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
