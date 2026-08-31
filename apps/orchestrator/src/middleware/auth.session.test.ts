/**
 * WARP-247 — authMiddleware session enforcement (idle/absolute/revocation).
 *
 * Mirrors middleware/auth.test.ts's harness (mock req/res/next, mocked
 * jwt.service + cache.service) but drives the JWT path with a payload that
 * carries a sid, and mocks session.service to model each check outcome.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-at-least-32-chars-long-aaa",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
    SERVICE_TOKEN_EMAIL: "",
    ORCHESTRATOR_SAMPLER_TOKEN: "",
    AI_GATEWAY_SAMPLER_TOKEN: "",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

const verifyAccessToken = vi.fn();
vi.mock("../services/jwt.service.js", () => ({
  verifyAccessToken: (...a: unknown[]) => verifyAccessToken(...(a as [string])),
  roleFromGroups: vi.fn().mockReturnValue("family"),
  // WARP-1636 — the OCS fallback's session-mint funnel. See the note in
  // middleware/auth.test.ts: the rank cap is pinned against the real
  // module in __tests__/auth.ocs-role-cap.test.ts.
  resolveNcSessionRole: vi.fn().mockReturnValue("family"),
}));

const checkSession = vi.fn();
vi.mock("../services/session.service.js", () => ({
  checkSession: (...a: unknown[]) => checkSession(...a),
}));

// WARP-490 — the access-token denylist gate. Mocked at the service boundary
// (like checkSession) so the middleware test doesn't reach into Redis. Default
// "not denied" is set in beforeEach; the revocation tests flip it per-case.
const isUserDenied = vi.fn();
vi.mock("../services/auth-denylist.service.js", () => ({
  isUserDenied: (...a: unknown[]) => isUserDenied(...a),
}));

import { authMiddleware, validateTokenForWs } from "./auth.js";

const payloadWithSid = {
  sub: "u-uuid-1",
  username: "alice",
  displayName: "Alice",
  role: "family" as const,
  sid: "sid-abc",
};

function cookieReq(): Request {
  return {
    headers: {},
    cookies: { droplet_session: "jwt-token" },
    path: "/api/llm/models",
  } as unknown as Request;
}

function headerReq(): Request {
  return {
    headers: { authorization: "Bearer jwt-token" },
    cookies: {},
    path: "/api/llm/models",
  } as unknown as Request;
}

function mockRes(): Response {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis() as unknown as Response["status"],
    json: vi.fn().mockReturnThis() as unknown as Response["json"],
    clearCookie: vi.fn().mockReturnThis() as unknown as Response["clearCookie"],
  };
  return res as Response;
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.clearAllMocks();
  // Default: subject is NOT revoked, so the denylist gate is transparent and
  // the existing session-enforcement cases exercise exactly what they did
  // before WARP-490. Revocation tests override this.
  isUserDenied.mockResolvedValue(false);
});

describe("authMiddleware — WARP-247 session enforcement", () => {
  it("passes a live session through and stamps req.user.sid", async () => {
    verifyAccessToken.mockReturnValue(payloadWithSid);
    checkSession.mockResolvedValue({
      kind: "ok",
      record: { userId: "u-uuid-1", role: "family", createdAt: 0, lastSeenAt: 0 },
    });
    const req = cookieReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await flush();

    expect(checkSession).toHaveBeenCalledWith("sid-abc");
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toMatchObject({ id: "u-uuid-1", sid: "sid-abc" });
  });

  it("401s SESSION_EXPIRED/idle_timeout and clears the cookie on an idle-expired session", async () => {
    verifyAccessToken.mockReturnValue(payloadWithSid);
    checkSession.mockResolvedValue({ kind: "expired", reason: "idle_timeout" });
    const req = cookieReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Session expired",
      code: "SESSION_EXPIRED",
      reason: "idle_timeout",
    });
    expect(res.clearCookie).toHaveBeenCalledWith("droplet_session", { path: "/" });
  });

  it("401s with reason absolute_timeout on an absolutely-expired session", async () => {
    verifyAccessToken.mockReturnValue(payloadWithSid);
    checkSession.mockResolvedValue({ kind: "expired", reason: "absolute_timeout" });
    const req = headerReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await flush();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SESSION_EXPIRED", reason: "absolute_timeout" }),
    );
    // Header-sourced token → nothing to clear.
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it("401s with reason revoked when the record is missing (revocation bites access tokens)", async () => {
    verifyAccessToken.mockReturnValue(payloadWithSid);
    checkSession.mockResolvedValue({ kind: "missing" });
    const req = cookieReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await flush();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SESSION_EXPIRED", reason: "revoked" }),
    );
  });

  it("fails OPEN on a Redis error — the ≤15-min JWT is still a valid credential", async () => {
    verifyAccessToken.mockReturnValue(payloadWithSid);
    checkSession.mockResolvedValue({ kind: "error" });
    const req = cookieReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("grants the one-release grace path to legacy sid-less tokens without a session check", async () => {
    const { sid: _sid, ...legacy } = payloadWithSid;
    verifyAccessToken.mockReturnValue(legacy);
    const req = cookieReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await flush();

    expect(checkSession).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("401s SESSION_EXPIRED/revoked BEFORE the session check when the subject is denylisted (WARP-490)", async () => {
    verifyAccessToken.mockReturnValue(payloadWithSid);
    isUserDenied.mockResolvedValue(true);
    const req = cookieReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Session revoked",
      code: "SESSION_EXPIRED",
      reason: "revoked",
    });
    expect(res.clearCookie).toHaveBeenCalledWith("droplet_session", { path: "/" });
    // The denylist short-circuits AHEAD of the session lookup.
    expect(checkSession).not.toHaveBeenCalled();
  });

  it("denylist ALSO cuts off a legacy sid-less token — the grace path is gated too (WARP-490)", async () => {
    const { sid: _sid, ...legacy } = payloadWithSid;
    verifyAccessToken.mockReturnValue(legacy);
    isUserDenied.mockResolvedValue(true);
    const req = headerReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SESSION_EXPIRED", reason: "revoked" }),
    );
  });
});

describe("validateTokenForWs — WARP-247 session enforcement", () => {
  it("rejects a WS upgrade whose session record is gone", async () => {
    verifyAccessToken.mockReturnValue(payloadWithSid);
    checkSession.mockResolvedValue({ kind: "missing" });
    const user = await validateTokenForWs("jwt-token");
    expect(user).toBeNull();
  });

  it("allows a WS upgrade with a live session", async () => {
    verifyAccessToken.mockReturnValue(payloadWithSid);
    checkSession.mockResolvedValue({
      kind: "ok",
      record: { userId: "u-uuid-1", role: "family", createdAt: 0, lastSeenAt: 0 },
    });
    const user = await validateTokenForWs("jwt-token");
    expect(user).toMatchObject({ id: "u-uuid-1", sid: "sid-abc" });
  });

  it("rejects a WS upgrade for a denylisted subject before the session check (WARP-490)", async () => {
    verifyAccessToken.mockReturnValue(payloadWithSid);
    isUserDenied.mockResolvedValue(true);
    const user = await validateTokenForWs("jwt-token");
    expect(user).toBeNull();
    expect(checkSession).not.toHaveBeenCalled();
  });
});
