/**
 * WARP-3180 — POST /api/auth/step-up re-proves the CURRENT session and
 * stamps lastMfaAt on a token for the SAME sid; it can never switch
 * accounts, refuses a session the store hasn't confirmed live, and the
 * stamped token gets through rotate-key's 60 s gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { generate } from "otplib";

vi.mock("../config.js", () => ({
  config: {
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    AUTH_ENABLED: true,
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "svc-mcp-token",
  },
}));
vi.mock("../middleware/rate-limit.js", () => ({
  authRateLimit: (_q: unknown, _s: unknown, n: () => void) => n(),
  sensitiveRateLimit: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
// Secrets at rest are plaintext here so the REAL TOTP check can run.
vi.mock("../services/encryption.service.js", () => ({
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
}));
const verifyPassword = vi.fn();
vi.mock("../services/password.service.js", () => ({
  verifyPassword: (...a: unknown[]) => verifyPassword(...a),
}));
// Delegates to the real check unless a test overrides it.
const secondFactor = vi.fn();
vi.mock("../services/login-second-factor.service.js", () => ({
  checkLoginSecondFactor: (...a: unknown[]) => secondFactor(...a),
}));
// The throttle with a real in-memory counter behind it.
const cache = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(async (k: string) => cache.get(k) ?? null),
  cacheSet: vi.fn(async (k: string, v: unknown) => void cache.set(k, v)),
  cacheDel: vi.fn(async (k: string) => void cache.delete(k)),
  cacheIncr: vi.fn(async (k: string) => {
    const n = ((cache.get(k) as number) ?? 0) + 1;
    cache.set(k, n);
    return n;
  }),
}));
const recordActivity = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../services/activity.singleton.js", async (importActual) => ({
  ...((await importActual()) as object),
  recordActivity,
}));
const checkSession = vi.hoisted(() => vi.fn());
const listUserSessions = vi.hoisted(() => vi.fn());
const revokeAllSessions = vi.hoisted(() => vi.fn());
vi.mock("../services/session.service.js", () => ({ checkSession, listUserSessions, revokeAllSessions,
  idleLimitSecondsForRole: () => 1800, absoluteLimitSecondsForRole: () => 43200 }));
vi.mock("../services/auth-denylist.service.js", () => ({ isUserDenied: vi.fn(async () => false) }));
const resolveExtensionPrincipal = vi.hoisted(() => vi.fn());
vi.mock("../services/extension-principal.js", () => ({ resolveExtensionPrincipal }));

import { createStepUpRouter } from "./auth-step-up.js";
import { createActivityRouter } from "./activity.js";
import { authMiddleware, requirePasswordChangeGate } from "../middleware/auth.js";
import { signAccessToken, verifyAccessToken, type Role } from "../services/jwt.service.js";
import { encryptTotpSecret } from "../services/totp.service.js";
import { errorHandler } from "../middleware/error-handler.js";

const actualSecondFactor = async (...a: unknown[]) =>
  (
    await vi.importActual<typeof import("../services/login-second-factor.service.js")>(
      "../services/login-second-factor.service.js",
    )
  ).checkLoginSecondFactor(...(a as Parameters<typeof import("../services/login-second-factor.service.js").checkLoginSecondFactor>));

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
type Row = { passwordHash: string; confirmed: boolean; role: Role; mustChangePassword?: boolean };
const users: Record<string, Row> = {
  owner1: { passwordHash: "h-owner", confirmed: true, role: "owner" },
  member1: { passwordHash: "h-member", confirmed: true, role: "family" },
  nototp: { passwordHash: "h-x", confirmed: false, role: "owner" },
  demoted: { passwordHash: "h-d", confirmed: true, role: "family" },
  mustchange: { passwordHash: "h-m", confirmed: true, role: "owner", mustChangePassword: true },
};
const lastStep: Record<string, number> = {};
const prisma = {
  user: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const u = users[where.id];
      return u
        ? {
            passwordHash: u.passwordHash,
            provisionSource: "LOCAL",
            directoryStatus: "ACTIVE",
            accessRoleId: null,
            role: u.role,
            mustChangePassword: u.mustChangePassword ?? false,
          }
        : null;
    }),
  },
  totpCredential: {
    findUnique: vi.fn(async ({ where }: { where: { userId: string } }) =>
      users[where.userId]
        ? {
            userId: where.userId,
            secretEnc: encryptTotpSecret(SECRET),
            lastAcceptedStep: lastStep[where.userId] ?? 0,
            confirmedAt: users[where.userId].confirmed ? new Date() : null,
          }
        : null,
    ),
    // The real conditional claim: only a LATER step wins.
    updateMany: vi.fn(async ({ where, data }: any) => {
      if ((lastStep[where.userId] ?? 0) >= data.lastAcceptedStep) return { count: 0 };
      lastStep[where.userId] = data.lastAcceptedStep;
      return { count: 1 };
    }),
  },
  recoveryCode: {},
} as any;

/** Synthetic app: req.user as authMiddleware would set it for a live session. */
function app(id: string, role: Role, opts: { sid?: string | null; checked?: boolean } = {}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    const sid = opts.sid === undefined ? "sid-1" : opts.sid ?? undefined;
    (req as any).user = { id, username: id, displayName: id, role, sid, lastMfaAt: null };
    req.sessionChecked = opts.checked ?? true;
    next();
  });
  a.use("/api", createStepUpRouter(prisma));
  a.use(errorHandler);
  return a;
}

/** The real middleware chain the route is mounted behind in app.ts. */
function realApp() {
  const a = express();
  a.use(express.json());
  a.use(authMiddleware);
  a.use(requirePasswordChangeGate(prisma));
  a.use("/api", createStepUpRouter(prisma));
  a.use(errorHandler);
  return a;
}
const bearer = (id: string, role: Role) =>
  `Bearer ${signAccessToken({ id, username: id, displayName: id, role, sid: `sid-${id}` })}`;

function tokenFrom(res: request.Response) {
  const cookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("droplet_session="));
  if (!cookie) throw new Error(`no session cookie (status ${res.status})`);
  const payload = verifyAccessToken(decodeURIComponent(cookie.split(";")[0].split("=")[1]));
  if (!payload) throw new Error("token does not verify");
  return payload;
}

const auditText = () => JSON.stringify(recordActivity.mock.calls);

beforeEach(() => {
  verifyPassword.mockReset();
  secondFactor.mockReset();
  secondFactor.mockImplementation(actualSecondFactor);
  recordActivity.mockClear();
  checkSession.mockReset();
  checkSession.mockResolvedValue({ kind: "ok" });
  listUserSessions.mockReset();
  revokeAllSessions.mockReset();
  revokeAllSessions.mockResolvedValue(2);
  resolveExtensionPrincipal.mockReset();
  cache.clear();
  for (const k of Object.keys(lastStep)) delete lastStep[k];
});

describe("self-service session routes", () => {
  it("security status projects only the checked caller's confirmed factor, never its secret", async () => {
    const res = await request(app("member1", "family")).get("/api/auth/security").query({ userId: "owner1" });
    expect(res.status).toBe(200); expect(res.body).toEqual({ totpEnabled: true });
    expect(prisma.totpCredential.findUnique).toHaveBeenCalledWith({ where: { userId: "member1" }, select: { confirmedAt: true } });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
  it("an unconfirmed enrollment is not enabled", async () => {
    const res = await request(app("nototp", "owner")).get("/api/auth/security");
    expect(res.status).toBe(200); expect(res.body).toEqual({ totpEnabled: false });
  });
  it("lists only the checked caller's sessions and never exposes session ids or another selected user", async () => {
    listUserSessions.mockResolvedValue([{ role: "family", createdAt: 100, lastSeenAt: 200 }]);
    const res = await request(app("member1", "family")).get("/api/auth/sessions/mine").query({ userId: "owner1", username: "owner1" });
    expect(res.status).toBe(200); expect(listUserSessions).toHaveBeenCalledExactlyOnceWith("member1");
    expect(res.body).toEqual({ sessions: [{ role: "family", createdAt: 100, lastSeenAt: 200, idleDeadline: 2000, absoluteDeadline: 43300 }] });
    expect(JSON.stringify(res.body)).not.toContain("sid"); expect(res.headers["cache-control"]).toBe("no-store");
  });
  it("an unreadable session store is unavailable, never an empty success", async () => {
    listUserSessions.mockResolvedValue(null);
    const res = await request(app("member1", "family")).get("/api/auth/sessions/mine");
    expect(res.status).toBe(503); expect(res.body.code).toBe("SESSIONS_UNAVAILABLE"); expect(res.body.sessions).toBeUndefined();
  });
  it("revoke keeps only the current caller's checked session", async () => {
    const res = await request(app("member1", "family", { sid: "sid-member" })).post("/api/auth/sessions/revoke-others").send({});
    expect(res.status).toBe(200); expect(res.body).toEqual({ revoked: 2 });
    expect(revokeAllSessions).toHaveBeenCalledExactlyOnceWith("member1", { exceptSid: "sid-member" });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(auditText()).not.toContain("sid-member");
  });
  it.each([{ userId: "owner1" }, { username: "owner1" }, { exceptSid: "sid-owner" }, { sid: "sid-owner" }])("never permits a caller-selected identity or preserved session %j", async (body) => {
    const res = await request(app("member1", "family")).post("/api/auth/sessions/revoke-others").send(body);
    expect(res.status).toBe(400); expect(revokeAllSessions).not.toHaveBeenCalled();
  });
  it.each([{ sid: null }, { checked: false }])("unconfirmed and sid-less sessions cannot read or revoke %j", async (options) => {
    const a = app("member1", "family", options);
    expect((await request(a).get("/api/auth/security")).status).toBe(401);
    expect((await request(a).get("/api/auth/sessions/mine")).status).toBe(401);
    expect((await request(a).post("/api/auth/sessions/revoke-others").send({})).status).toBe(401);
    expect(listUserSessions).not.toHaveBeenCalled(); expect(revokeAllSessions).not.toHaveBeenCalled();
  });
  it("service principals cannot use self-service", async () => {
    const a = app("_service:mcp", "service");
    expect((await request(a).get("/api/auth/security")).status).toBe(401);
    expect((await request(a).get("/api/auth/sessions/mine")).status).toBe(401);
    expect((await request(a).post("/api/auth/sessions/revoke-others").send({})).status).toBe(401);
    expect(listUserSessions).not.toHaveBeenCalled(); expect(revokeAllSessions).not.toHaveBeenCalled();
  });
  it("a failed revoke does not report that other sessions ended", async () => {
    revokeAllSessions.mockRejectedValue(Object.assign(new Error("Session revocation unavailable"), { statusCode: 503, code: "SESSION_REVOCATION_UNAVAILABLE" }));
    const res = await request(app("member1", "family")).post("/api/auth/sessions/revoke-others").send({});
    expect(res.status).toBe(503); expect(res.body.revoked).toBeUndefined(); expect(recordActivity).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/step-up", () => {
  it.each(["body", "body=1"])("native %s returns the same-session access token without cookies or refresh rotation", async (mode) => {
    verifyPassword.mockResolvedValue(true); secondFactor.mockResolvedValue("passed");
    const res = await request(app("owner1", "owner", { sid: "sid-keep" })).post("/api/auth/step-up").query({ return: mode }).send({ password: "pw", totp: "123456" });
    expect(res.status).toBe(200); expect(res.headers["set-cookie"]).toBeUndefined();
    const token = verifyAccessToken(res.body.accessToken);
    expect(token?.sub).toBe("owner1"); expect(token?.sid).toBe("sid-keep"); expect(token?.lastMfaAt).toBe(res.body.lastMfaAt);
    expect(res.body.accessTokenExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(res.body.refreshToken).toBeUndefined(); expect(res.body.user.id).toBe("owner1");
    expect(auditText()).not.toContain(res.body.accessToken);
  });
  it.each(["Origin", "Referer", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest"])("%s keeps cookie-only step-up even with native opt-in", async (marker) => {
    verifyPassword.mockResolvedValue(true); secondFactor.mockResolvedValue("passed");
    const res = await request(app("owner1", "owner")).post("/api/auth/step-up?return=body").set(marker, "https://box.test").send({ password: "pw", totp: "123456" });
    expect(res.status).toBe(200); expect(res.body.accessToken).toBeUndefined(); expect(tokenFrom(res).sub).toBe("owner1");
  });
  it("stamps lastMfaAt on a token for the same user and session id", async () => {
    verifyPassword.mockResolvedValue(true);
    secondFactor.mockResolvedValue("passed");
    const before = Date.now();
    const res = await request(app("owner1", "owner", { sid: "sid-keep" })).post("/api/auth/step-up").send({ password: "pw", totp: "123456" });
    expect(res.status).toBe(200);
    const t = tokenFrom(res);
    expect(t.sub).toBe("owner1");
    expect(t.role).toBe("owner");
    expect(t.sid).toBe("sid-keep");
    expect(Date.parse(t.lastMfaAt!)).toBeGreaterThanOrEqual(before - 1000);
    expect(verifyPassword).toHaveBeenCalledWith("h-owner", "pw");
    expect(secondFactor).toHaveBeenCalledWith(prisma, "owner1", { totp: "123456" });
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
    expect(auditText()).toContain("Step-up failed");
  });

  it("a wrong password is 401 and never spends the code", async () => {
    verifyPassword.mockResolvedValue(false);
    const res = await request(app("owner1", "owner")).post("/api/auth/step-up").send({ password: "bad", totp: "123456" });
    expect(res.status).toBe(401);
    expect(secondFactor).not.toHaveBeenCalled();
  });

  it("the same real TOTP code is refused the second time (replay)", async () => {
    verifyPassword.mockResolvedValue(true);
    const code = await generate({ secret: SECRET });
    const first = await request(app("owner1", "owner")).post("/api/auth/step-up").send({ password: "pw", totp: code });
    expect(first.status).toBe(200);
    const replay = await request(app("owner1", "owner")).post("/api/auth/step-up").send({ password: "pw", totp: code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("STEP_UP_INVALID");
  });

  it("locks out with 429 once the shared counter trips, and audits the lockout", async () => {
    verifyPassword.mockResolvedValue(false);
    let res: request.Response | undefined;
    for (let i = 0; i < 20; i++) {
      res = await request(app("owner1", "owner")).post("/api/auth/step-up").send({ password: "bad", totp: "123456" });
      if (res.status === 429) break;
    }
    expect(res!.status).toBe(429);
    expect(res!.body.code).toBe("TOO_MANY_ATTEMPTS");
    expect(auditText()).toContain("Step-up locked out");
    // The lockout is audited once, when it starts; attempts refused while
    // locked add nothing to the signed chain.
    const rows = recordActivity.mock.calls.length;
    for (let i = 0; i < 5; i++) {
      const again = await request(app("owner1", "owner")).post("/api/auth/step-up").send({ password: "bad", totp: "123456" });
      expect(again.status).toBe(429);
    }
    expect(recordActivity.mock.calls.length).toBe(rows);
    expect(auditText().match(/Step-up locked out/g)).toHaveLength(1);
  });

  it("the audit rows carry no password or code", async () => {
    verifyPassword.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    secondFactor.mockResolvedValue("passed");
    await request(app("owner1", "owner")).post("/api/auth/step-up").send({ password: "S3cret-pw!", totp: "482913" });
    await request(app("owner1", "owner")).post("/api/auth/step-up").send({ password: "S3cret-pw!", totp: "482913" });
    const text = auditText();
    expect(text).toContain("Step-up confirmed");
    expect(text).not.toContain("S3cret-pw!");
    expect(text).not.toContain("482913");
  });

  it("an account without TOTP gets a clear 409", async () => {
    const res = await request(app("nototp", "owner")).post("/api/auth/step-up").send({ password: "pw", totp: "1" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TOTP_NOT_ENROLLED");
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("a sid-less token has no session to stamp", async () => {
    const res = await request(app("owner1", "owner", { sid: null })).post("/api/auth/step-up").send({ password: "pw", totp: "1" });
    expect(res.status).toBe(401);
  });

  it("the role on the new token comes from the row (a demoted owner can't keep owner)", async () => {
    verifyPassword.mockResolvedValue(true);
    secondFactor.mockResolvedValue("passed");
    const res = await request(app("demoted", "owner")).post("/api/auth/step-up").send({ password: "pw", totp: "1" });
    expect(tokenFrom(res).role).toBe("family");
  });
});

describe("POST /api/auth/step-up behind the real auth middleware", () => {
  it("fails closed when the session store can't confirm the session (Redis down)", async () => {
    checkSession.mockResolvedValue({ kind: "error" });
    verifyPassword.mockResolvedValue(true);
    const res = await request(realApp()).post("/api/auth/step-up").set("Authorization", bearer("owner1", "owner")).send({ password: "pw", totp: "1" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_REQUIRED");
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("a revoked session is refused", async () => {
    checkSession.mockResolvedValue({ kind: "missing" });
    const res = await request(realApp()).post("/api/auth/step-up").set("Authorization", bearer("owner1", "owner")).send({ password: "pw", totp: "1" });
    expect(res.status).toBe(401);
  });

  it("a live session steps up", async () => {
    verifyPassword.mockResolvedValue(true);
    secondFactor.mockResolvedValue("passed");
    const res = await request(realApp()).post("/api/auth/step-up").set("Authorization", bearer("owner1", "owner")).send({ password: "pw", totp: "1" });
    expect(res.status).toBe(200);
    expect(tokenFrom(res).sid).toBe("sid-owner1");
  });

  it("a service bearer gets 401", async () => {
    const res = await request(realApp()).post("/api/auth/step-up").set("Authorization", "Bearer svc-mcp-token").send({ password: "pw", totp: "1" });
    expect(res.status).toBe(401);
  });

  it("a dxt_ extension bearer gets 401", async () => {
    resolveExtensionPrincipal.mockResolvedValue({
      id: "_service:ext:demo",
      username: "_service:ext:demo",
      displayName: "Extension demo",
      role: "service",
      extensionId: "demo",
    });
    const res = await request(realApp()).post("/api/auth/step-up").set("Authorization", "Bearer dxt_abcdef").send({ password: "pw", totp: "1" });
    expect(resolveExtensionPrincipal).toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("a user who must change their password gets 403", async () => {
    const res = await request(realApp()).post("/api/auth/step-up").set("Authorization", bearer("mustchange", "owner")).send({ password: "pw", totp: "1" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PASSWORD_CHANGE_REQUIRED");
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
