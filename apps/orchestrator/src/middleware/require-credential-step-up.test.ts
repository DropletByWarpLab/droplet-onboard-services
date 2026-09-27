/**
 * WARP-3193 SEC-AUTH-9 — enrolling a new credential (TOTP, passkey) needs a
 * step-up, so a hijacked session cannot plant a factor of its own.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const verifyPassword = vi.fn();
vi.mock("../services/password.service.js", () => ({
  verifyPassword: (...a: unknown[]) => verifyPassword(...a),
}));
const checkPasswordChangeLock = vi.fn();
const recordPasswordChangeFailure = vi.fn();
const clearPasswordChangeRateState = vi.fn();
vi.mock("../services/password-change-throttle.service.js", () => ({
  checkPasswordChangeLock: (...a: unknown[]) => checkPasswordChangeLock(...a),
  recordPasswordChangeFailure: (...a: unknown[]) => recordPasswordChangeFailure(...a),
  clearPasswordChangeRateState: (...a: unknown[]) => clearPasswordChangeRateState(...a),
}));

import { createRequireCredentialStepUp, CREDENTIAL_STEP_UP_WINDOW_SEC } from "./require-credential-step-up.js";

type Row = { passwordHash: string | null; provisionSource: string };

function prismaWith(opts: { totpConfirmed?: boolean; row?: Row | null }) {
  return {
    totpCredential: {
      findUnique: vi.fn(async () =>
        opts.totpConfirmed === undefined ? null : { confirmedAt: opts.totpConfirmed ? new Date() : null },
      ),
    },
    user: {
      findUnique: vi.fn(async () =>
        opts.row === undefined ? { passwordHash: "$argon2id$x", provisionSource: "LOCAL" } : opts.row,
      ),
    },
  } as any;
}

function app(prisma: any, user: Record<string, unknown> | null = { id: "u1" }) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (user) (req as any).user = user;
    next();
  });
  a.post("/enroll", createRequireCredentialStepUp(prisma), (_req, res) => {
    res.json({ ok: true });
  });
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  checkPasswordChangeLock.mockResolvedValue({ locked: false, retryAfterSeconds: 0 });
});

describe("createRequireCredentialStepUp", () => {
  it("the window is five minutes", () => {
    expect(CREDENTIAL_STEP_UP_WINDOW_SEC).toBe(300);
  });

  it("401 without a signed-in user", async () => {
    const res = await request(app(prismaWith({}), null)).post("/enroll");
    expect(res.status).toBe(401);
  });

  describe("user WITH a confirmed TOTP factor → recent MFA", () => {
    it("🔴 no MFA stamp on the session → 401 mfa_required (a password does not substitute)", async () => {
      verifyPassword.mockResolvedValue(true);
      const res = await request(app(prismaWith({ totpConfirmed: true }))).post("/enroll").send({ currentPassword: "pw" });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("mfa_required");
    });

    it("🔴 a stamp older than the window → 401 mfa_stale", async () => {
      const stale = new Date(Date.now() - 301_000).toISOString();
      const res = await request(app(prismaWith({ totpConfirmed: true }), { id: "u1", lastMfaAt: stale })).post("/enroll");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("mfa_stale");
    });

    it("a stamp inside the window → passes", async () => {
      const fresh = new Date(Date.now() - 60_000).toISOString();
      const res = await request(app(prismaWith({ totpConfirmed: true }), { id: "u1", lastMfaAt: fresh })).post("/enroll");
      expect(res.status).toBe(200);
    });
  });

  describe("user with NO second factor yet → current password", () => {
    it("🔴 no password in the body → 403 STEP_UP_PASSWORD_REQUIRED, nothing verified", async () => {
      const res = await request(app(prismaWith({ totpConfirmed: false }))).post("/enroll");
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("STEP_UP_PASSWORD_REQUIRED");
      expect(verifyPassword).not.toHaveBeenCalled();
    });

    it("🔴 wrong password → 403 INVALID_PASSWORD and the shared failure counter bumps", async () => {
      verifyPassword.mockResolvedValue(false);
      const res = await request(app(prismaWith({}))).post("/enroll").send({ currentPassword: "nope" });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("INVALID_PASSWORD");
      expect(recordPasswordChangeFailure).toHaveBeenCalledWith("u1");
    });

    it("🔴 locked by earlier failures → 429 before any verify", async () => {
      checkPasswordChangeLock.mockResolvedValue({ locked: true, retryAfterSeconds: 30 });
      const res = await request(app(prismaWith({}))).post("/enroll").send({ currentPassword: "pw" });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe("TOO_MANY_ATTEMPTS");
      expect(verifyPassword).not.toHaveBeenCalled();
    });

    it("correct password → passes and clears the counter", async () => {
      verifyPassword.mockResolvedValue(true);
      const res = await request(app(prismaWith({}))).post("/enroll").send({ currentPassword: "pw" });
      expect(res.status).toBe(200);
      expect(verifyPassword).toHaveBeenCalledWith("$argon2id$x", "pw");
      expect(clearPasswordChangeRateState).toHaveBeenCalledWith("u1");
    });

    it("an IdP-provisioned account (no usable local password) is not locked out", async () => {
      for (const row of [
        { passwordHash: null, provisionSource: "SSO" },
        { passwordHash: "$argon2id$legacy", provisionSource: "SCIM" },
      ]) {
        const res = await request(app(prismaWith({ row }))).post("/enroll");
        expect(res.status).toBe(200);
      }
      expect(verifyPassword).not.toHaveBeenCalled();
    });
  });
});
