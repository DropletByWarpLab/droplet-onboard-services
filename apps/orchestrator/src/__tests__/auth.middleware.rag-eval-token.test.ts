/**
 * authMiddleware — `_service:rag-eval` service-principal bearer (RAGAS
 * eval-runner auth).
 *
 * The rag-eval container's ragas_runner.py hits
 * GET /api/admin/retrieval-eval/search on every eval question. On a deployed
 * appliance AUTH_ENABLED=true, so without a credential every search 401s and
 * the eval retrieves empty contexts (junk/NaN metrics). The runner now
 * presents `config.SERVICE_TOKEN_RAG_EVAL` as a Bearer; the middleware must
 * map it to the `_service:rag-eval` principal exactly like the established
 * voice/mcp/email tokens.
 *
 * Same harness as auth.middleware.test.ts: the principal table is captured at
 * module-import time from `config`, so these tests `vi.mock` config before
 * importing auth.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_RAG_EVAL: "test-rag-eval-token-32chars-pad-abc1",
  },
}));

// In-memory cache stub — the service-token path must short-circuit before
// any cache call (asserted below).
const cacheGet = vi.fn().mockResolvedValue(null);
const cacheSet = vi.fn().mockResolvedValue(undefined);
const cacheDel = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/cache.service.js", () => ({
  cacheGet: (...args: unknown[]) => cacheGet(...args),
  cacheSet: (...args: unknown[]) => cacheSet(...args),
  cacheDel: (...args: unknown[]) => cacheDel(...args),
}));

// JWT verifier stub — the service-token path must run before this.
const verifyAccessToken = vi.fn().mockReturnValue(null);
vi.mock("../services/jwt.service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/jwt.service.js")>();
  return {
    ...original,
    verifyAccessToken: (...args: unknown[]) => verifyAccessToken(...args),
  };
});

// Block any accidental real-network OCS fallback fetch.
const fetchSpy = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
vi.stubGlobal("fetch", fetchSpy);

import { authMiddleware, requireRoleOrService } from "../middleware/auth.js";

interface FakeReq {
  headers: Record<string, string | undefined>;
  cookies: Record<string, string | undefined>;
  path: string;
  user?: unknown;
}

function buildReq(overrides: Partial<FakeReq> = {}): FakeReq {
  return {
    headers: {},
    cookies: {},
    path: "/api/admin/retrieval-eval/search",
    ...overrides,
  };
}

function buildRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    clearCookie: vi.fn(),
  };
  return res;
}

describe("authMiddleware — SERVICE_TOKEN_RAG_EVAL bearer", () => {
  beforeEach(() => {
    cacheGet.mockClear();
    cacheSet.mockClear();
    verifyAccessToken.mockClear();
    fetchSpy.mockClear();
  });

  it("recognises SERVICE_TOKEN_RAG_EVAL and sets the _service:rag-eval principal", async () => {
    const req = buildReq({
      headers: { authorization: "Bearer test-rag-eval-token-32chars-pad-abc1" },
    }) as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await Promise.resolve();

    expect(next).toHaveBeenCalledTimes(1);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(0);
    const user = (req as unknown as FakeReq).user as {
      id: string;
      username: string;
      displayName: string;
      role: string;
    };
    expect(user.id).toBe("_service:rag-eval");
    expect(user.username).toBe("_service:rag-eval");
    expect(user.displayName).toBe("RAG Eval Runner");
    expect(user.role).toBe("service");
    // Same short-circuit guarantee as the voice/mcp tokens: never reaches
    // JWT verification, the token cache, or the OCS fallback.
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(cacheGet).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not promote a non-matching bearer to the rag-eval principal", async () => {
    const req = buildReq({
      // Same length as the configured token, every byte differs —
      // exercises the timingSafeEqual branch.
      headers: { authorization: "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }) as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await Promise.resolve();

    expect((req as unknown as FakeReq).user).toBeUndefined();
    expect(verifyAccessToken).toHaveBeenCalledTimes(1);
  });
});

describe("authMiddleware — empty SERVICE_TOKEN_RAG_EVAL is not a wildcard", () => {
  // The `if (!def.token) continue` guard in matchServiceToken means a
  // deployment WITHOUT the token configured (the empty default — e.g. a box
  // whose .env predates secrets.sh minting it) must NEVER promote a caller
  // to the rag-eval principal, not even for an empty Bearer.
  it("empty configured token does not match an empty Bearer", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: {
        AUTH_ENABLED: true,
        NEXTCLOUD_URL: "http://nextcloud.test",
        SERVICE_TOKEN_RAG_EVAL: "",
      },
    }));
    const { authMiddleware: freshMw } = await import("../middleware/auth.js");

    const req = buildReq({
      headers: { authorization: "Bearer " },
    }) as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    freshMw(req, res, next);
    await Promise.resolve();

    // Empty Bearer is treated as no token → 401 immediately.
    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    expect((req as unknown as FakeReq).user).toBeUndefined();
  });

  it("empty configured token does not match a non-empty Bearer either", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: {
        AUTH_ENABLED: true,
        NEXTCLOUD_URL: "http://nextcloud.test",
        SERVICE_TOKEN_RAG_EVAL: "",
      },
    }));
    const { authMiddleware: freshMw } = await import("../middleware/auth.js");

    const req = buildReq({
      headers: { authorization: "Bearer some-random-guess" },
    }) as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    freshMw(req, res, next);
    await Promise.resolve();

    // Falls through to JWT (mocked null) then the OCS fallback (stubbed
    // 500) — never the service principal.
    expect((req as unknown as FakeReq).user).toBeUndefined();
  });
});

describe("requireRoleOrService(serviceId, ...allowed)", () => {
  // Generalisation of requireRoleOrMcpService: admit exactly ONE pinned
  // service principal (id AND role must both match), defer everyone else
  // to plain requireRole semantics.
  function run(user: unknown, mw: ReturnType<typeof requireRoleOrService>) {
    const req = { user } as unknown as Request;
    const res = buildRes();
    const next = vi.fn() as unknown as NextFunction;
    mw(req, res as unknown as Response, next);
    return { res, next };
  }

  const mw = requireRoleOrService("_service:rag-eval", "owner", "admin");

  it("admits the pinned service principal", () => {
    const { res, next } = run(
      { id: "_service:rag-eval", username: "_service:rag-eval", role: "service" },
      mw,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it("403s a DIFFERENT service principal (no coarse role-based admission)", () => {
    const { res, next } = run(
      { id: "_service:voice", username: "_service:voice", role: "service" },
      mw,
    );
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not admit the pinned id without the service role", () => {
    // A human account that somehow carries the magic username must still
    // pass plain requireRole — id alone is not a credential.
    const { res, next } = run(
      { id: "_service:rag-eval", username: "_service:rag-eval", role: "family" },
      mw,
    );
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("defers to requireRole for human callers (admin passes, family fails)", () => {
    const admin = run({ id: "u1", username: "alice", role: "admin" }, mw);
    expect(admin.next).toHaveBeenCalledTimes(1);
    const family = run({ id: "u2", username: "bob", role: "family" }, mw);
    expect(family.res.statusCode).toBe(403);
    expect(family.next).not.toHaveBeenCalled();
  });
});
