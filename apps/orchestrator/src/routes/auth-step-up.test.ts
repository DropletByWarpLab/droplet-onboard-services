/**
 * WARP-3180 — POST /api/auth/step-up re-proves the CURRENT session and
 * stamps lastMfaAt on a token for the SAME sid; it can never switch
 * accounts, and the stamped token gets through rotate-key's 60 s gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: { JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa", AUTH_ENABLED: true },
}));
vi.mock("../middleware/rate-limit.js", () => ({
  sensitiveRateLimit: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
const verifyPassword = vi.fn();
vi.mock("../services/password.service.js", () => ({
  verifyPassword: (...a: unknown[]) => verifyPassword(...a),
}));
const secondFactor = vi.fn();
vi.mock("../services/login-second-factor.service.js", () => ({
  checkLoginSecondFactor: (...a: unknown[]) => secondFactor(...a),
}));
const throttle = vi.hoisted(() => ({
  checkPasswordChangeLock: vi.fn(async () => ({ locked: false, retryAfterSeconds: 0 })),
  recordPasswordChangeFailure: vi.fn(async () => {}),
  clearPasswordChangeRateState: vi.fn(async () => {}),
}));
vi.mock("../services/password-change-throttle.service.js", () => throttle);
const recordActivity = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../services/activity.singleton.js", async (importActual) => ({
  ...((await importActual()) as object),
  recordActivity,
}));

import { createStepUpRouter } from "./auth-step-up.js";
import { createActivityRouter } from "./activity.js";
import { verifyAccessToken } from "../services/jwt.service.js";

type Role = "owner" | "admin" | "family" | "guest";
const users: Record<string, { passwordHash: string; confirmed: boolean; role: Role }> = {
  owner1: { passwordHash: "h-owner", confirmed: true, role: "owner" },
  member1: { passwordHash: "h-member", confirmed: true, role: "family" },
  nototp: { passwordHash: "h-x", confirmed: false, role: "owner" },
  demoted: { passwordHash: "h-d", confirmed: true, role: "family" },
};
const prisma = {
  user: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      users[where.id]
        ? { passwordHash: users[where.id].passwordHash, provisionSource: "LOCAL", directoryStatus: "ACTIVE", accessRoleId: null, role: users[where.id].role }
        : null,
    ),
  },
  totpCredential: {
    findUnique: vi.fn(async ({ where }: { where: { userId: string } }) =>
      users[where.userId] ? { confirmedAt: users[where.userId].confirmed ? new Date() : null } : null,
    ),
  },
} as any;

function app(id: string, role: Role, sid: string | undefined = "sid-1") {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as any).user = { id, username: id, displayName: id, role, sid, lastMfaAt: null };
    next();
  });
  a.use("/api", createStepUpRouter(prisma));
  return a;
}

function tokenFrom(res: request.Response) {
  const cookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("droplet_session="));
  if (!cookie) throw new Error("no session cookie");
  const payload = verifyAccessToken(decodeURIComponent(cookie.split(";")[0].split("=")[1]));
  if (!payload) throw new Error("token does not verify");
  return payload;
}

beforeEach(() => {
  verifyPassword.mockReset();
  secondFactor.mockReset();
  recordActivity.mockClear();
  throttle.recordPasswordChangeFailure.mockClear();
});

describe("POST /api/auth/step-up", () => {
  it("stamps lastMfaAt on a token for the same user and session id", async () => {
    verifyPassword.mockResolvedValue(true);
    secondFactor.mockResolvedValue("passed");
    const before = Date.now();
    const res = await request(app("owner1", "owner", "sid-keep")).post("/api/auth/step-up").send({ password: "pw", totp: "123456" });
    expect(res.status).toBe(200);
    const t = tokenFrom(res);
    expect(t.sub).toBe("owner1");
    expect(t.role).toBe("owner");
    expect(t.sid).toBe("sid-keep");
    expect(Date.parse(t.lastMfaAt!)).toBeGreaterThanOrEqual(before - 1000);
    expect(verifyPassword).toHaveBeenCalledWith("h-owner", "pw");
    expect(secondFactor).toHaveBeenCalledWith(prisma, "owner1", { totp: "123456" });
    const audited = JSON.stringify(recordActivity.mock.calls);
    expect(audited).toContain("Step-up confirmed");
    expect(audited).not.toContain('"pw"');
  });

  it("cannot switch accounts: an identity field is refused, and only req.user is checked", async () => {
    verifyPassword.mockResolvedValue(true);
    secondFactor.mockResolvedValue("passed");
    const res = await request(app("member1", "family")).post("/api/auth/step-up").send({ password: "pw", totp: "1", email: "owner@acme.test" });
    expect(res.status).toBe(400);
    const ok = await request(app("member1", "family")).post("/api/auth/step-up").send({ password: "owner-pw", totp: "1" });
    expect(verifyPassword).toHaveBeenCalledWith("h-member", "owner-pw");
    expect(tokenFrom(ok).sub).toBe("member1");
    expect(tokenFrom(ok).role).toBe("family");
  });

  it("a wrong code is 401, counted and audited, and sets no cookie", async () => {
    verifyPassword.mockResolvedValue(true);
    secondFactor.mockResolvedValue("failed");
    const res = await request(app("owner1", "owner")).post("/api/auth/step-up").send({ password: "pw", totp: "000000" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STEP_UP_INVALID");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(throttle.recordPasswordChangeFailure).toHaveBeenCalledWith("owner1");
    expect(JSON.stringify(recordActivity.mock.calls)).toContain("Step-up failed");
  });

  it("a wrong password is 401 and never spends the code", async () => {
    verifyPassword.mockResolvedValue(false);
    const res = await request(app("owner1", "owner")).post("/api/auth/step-up").send({ password: "bad", totp: "123456" });
    expect(res.status).toBe(401);
    expect(secondFactor).not.toHaveBeenCalled();
  });

  it("an account without TOTP gets a clear 409", async () => {
    const res = await request(app("nototp", "owner")).post("/api/auth/step-up").send({ password: "pw", totp: "1" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TOTP_NOT_ENROLLED");
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("a sid-less token has no session to stamp", async () => {
    const res = await request(app("owner1", "owner", undefined)).post("/api/auth/step-up").send({ password: "pw", totp: "1" });
    expect(res.status).toBe(401);
  });
});

describe("role on the re-minted token", () => {
  it("comes from the row, so a demoted owner's step-up can't keep owner", async () => {
    verifyPassword.mockResolvedValue(true);
    secondFactor.mockResolvedValue("passed");
    const res = await request(app("demoted", "owner")).post("/api/auth/step-up").send({ password: "pw", totp: "1" });
    expect(tokenFrom(res).role).toBe("family");
  });
});

describe("the stepped-up token and rotate-key", () => {
  function rotateApp(user: ReturnType<typeof tokenFrom>) {
    const a = express();
    a.use((req, _res, next) => {
      (req as any).user = { id: user.sub, username: user.username, role: user.role, lastMfaAt: user.lastMfaAt ?? null };
      next();
    });
    a.use("/api", createActivityRouter({} as any));
    return a;
  }

  it("an owner's stepped-up token passes the 60 s MFA gate", async () => {
    verifyPassword.mockResolvedValue(true);
    secondFactor.mockResolvedValue("passed");
    const t = tokenFrom(await request(app("owner1", "owner")).post("/api/auth/step-up").send({ password: "pw", totp: "1" }));
    const res = await request(rotateApp(t)).post("/api/activity/rotate-key");
    // Past both gates: the rotation itself answers (no signer in this test).
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.body.code).toBe("AUDIT_SIGNER_UNAVAILABLE");
  });

  it("a member can step up, but rotate-key stays owner-only", async () => {
    verifyPassword.mockResolvedValue(true);
    secondFactor.mockResolvedValue("passed");
    const t = tokenFrom(await request(app("member1", "family")).post("/api/auth/step-up").send({ password: "pw", totp: "1" }));
    const res = await request(rotateApp(t)).post("/api/activity/rotate-key");
    expect(res.status).toBe(403);
  });
});
