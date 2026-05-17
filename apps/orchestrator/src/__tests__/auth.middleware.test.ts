/**
 * authMiddleware — service-principal bearer-token path (WARP-154 follow-up).
 *
 * Voice-io posts to `/api/llm/chat` with a Bearer matching
 * `config.SERVICE_TOKEN_VOICE`; the middleware must recognize that as a
 * service principal (role: "service") BEFORE attempting JWT validation,
 * and must reject mismatches without leaking timing.
 *
 * The principal table is captured at module-import time from `config`, so
 * these tests `vi.mock` config before importing auth.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_VOICE: "test-voice-token-32chars-padding-xyz",
  },
}));

// In-memory cache stub — service-token path never touches it, but the
// Nextcloud fallback would. We assert the service path short-circuits
// before any cache call.
const cacheGet = vi.fn().mockResolvedValue(null);
const cacheSet = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/cache.service.js", () => ({
  cacheGet: (...args: unknown[]) => cacheGet(...args),
  cacheSet: (...args: unknown[]) => cacheSet(...args),
}));

// JWT verifier stub — service-token path must run before this. We assert
// it's never called for a valid service token.
const verifyAccessToken = vi.fn().mockReturnValue(null);
vi.mock("../services/jwt.service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/jwt.service.js")>();
  return {
    ...original,
    verifyAccessToken: (...args: unknown[]) => verifyAccessToken(...args),
  };
});

// Block any accidental real-network fallback fetch.
const fetchSpy = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
vi.stubGlobal("fetch", fetchSpy);

// Mocks above are hoisted by vitest's transform so they run before this
// static import resolves. The earlier `await import` shape worked for
// vitest but tripped `tsc` (the orchestrator project compiles to
// CommonJS, where top-level await isn't valid). Static import + hoisted
// vi.mock is the conventional vitest pattern and compiles cleanly under
// either module target.
import { authMiddleware } from "../middleware/auth.js";

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
    path: "/api/llm/chat",
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

describe("authMiddleware — service-principal bearer", () => {
  beforeEach(() => {
    cacheGet.mockClear();
    cacheSet.mockClear();
    verifyAccessToken.mockClear();
    fetchSpy.mockClear();
  });

  it("recognises SERVICE_TOKEN_VOICE and sets req.user.role='service'", async () => {
    const req = buildReq({
      headers: { authorization: "Bearer test-voice-token-32chars-padding-xyz" },
    }) as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    // Service-token path is synchronous — give the runtime a microtask flush
    // anyway in case future code adds an await.
    await Promise.resolve();

    expect(next).toHaveBeenCalledTimes(1);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(0);
    const user = (req as unknown as FakeReq).user as { id: string; role: string };
    expect(user.id).toBe("_service:voice");
    expect(user.role).toBe("service");
    // Crucial: short-circuited before JWT + cache.
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(cacheGet).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a wrong-length token without leaking timing (constant-time path)", async () => {
    const req = buildReq({
      headers: { authorization: "Bearer wrong-token-shorter" },
    }) as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await Promise.resolve();

    // Falls through to JWT (which is mocked to return null), then to
    // Nextcloud OCS (which the global fetch stub 500s) → 401 from the
    // resolved-token path. Either next not called OR 401 written.
    expect((req as unknown as FakeReq).user).toBeUndefined();
    expect(verifyAccessToken).toHaveBeenCalledTimes(1);
  });

  it("rejects a same-length wrong token (timingSafeEqual mismatch)", async () => {
    // Same length as the configured token but every byte differs — exercises
    // the timingSafeEqual branch, not the length-mismatch short-circuit.
    const req = buildReq({
      headers: { authorization: "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }) as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await Promise.resolve();

    expect((req as unknown as FakeReq).user).toBeUndefined();
    expect(verifyAccessToken).toHaveBeenCalledTimes(1);
  });

  it("does NOT match service tokens sent via cookie (header-only)", async () => {
    // Service principals come from internal services that pass the token
    // as a Bearer header. Cookies are for human browser sessions. Even if
    // an attacker plants the right value in a `droplet_session` cookie, we
    // must NOT promote them to the service principal.
    const req = buildReq({
      cookies: { droplet_session: "test-voice-token-32chars-padding-xyz" },
    }) as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await Promise.resolve();

    expect((req as unknown as FakeReq).user).toBeUndefined();
    // Cookie token still flowed through the JWT verifier (which returned null)
    expect(verifyAccessToken).toHaveBeenCalledTimes(1);
  });

  it("falls through to JWT when no service token matches", async () => {
    // JWT verifier returns a payload → middleware calls next() with the
    // JWT-derived user, not the service principal.
    verifyAccessToken.mockReturnValueOnce({
      sub: "alice",
      username: "alice",
      displayName: "Alice",
      role: "owner",
    });
    const req = buildReq({
      headers: { authorization: "Bearer some-jwt-token-not-a-service-token" },
    }) as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await Promise.resolve();

    expect(next).toHaveBeenCalledTimes(1);
    expect(verifyAccessToken).toHaveBeenCalledTimes(1);
    const user = (req as unknown as FakeReq).user as { id: string; role: string };
    expect(user.id).toBe("alice");
    expect(user.role).toBe("owner");
  });

  it("public paths are not matched against service tokens (no header walk)", async () => {
    const req = buildReq({
      path: "/api/health",
      headers: { authorization: "Bearer test-voice-token-32chars-padding-xyz" },
    }) as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await Promise.resolve();

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as unknown as FakeReq).user).toBeUndefined();
  });
});

describe("authMiddleware — empty SERVICE_TOKEN_VOICE is not a wildcard", () => {
  // Sanity: the `if (!def.token) continue` guard in matchServiceToken means
  // a deployment with an empty SERVICE_TOKEN_VOICE must NEVER promote an
  // empty-Bearer caller. This test re-mocks config with the empty value to
  // confirm.
  it("empty configured token does not match an empty Bearer", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: {
        AUTH_ENABLED: true,
        NEXTCLOUD_URL: "http://nextcloud.test",
        SERVICE_TOKEN_VOICE: "",
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
});
