/**
 * authMiddleware — `_service:display` service-principal bearer (WARP-1800).
 *
 * The rack panel's device-bridge hits GET /api/network/wifi/join-code to
 * resolve the household join code, because its previous source — the box's own
 * hostapd via the bridge's /openwrt/qr — does not exist on the edge-router
 * shape, where the household SSID lives only on the approved AP.
 *
 * This principal is the narrowest one in the table and the only one whose
 * admitted route returns credential material, so the tests below care less
 * about the happy path than about everything it must NOT do: no coarse
 * `service`-role admission, no wildcard when the token is unset, no promotion
 * from the id alone.
 *
 * Same harness as auth.middleware.rag-eval-token.test.ts — the principal table
 * is captured at module-import time from `config`, so `vi.mock` config first.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_DISPLAY: "test-display-token-32chars-pad-abcd1",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const cacheGet = vi.fn().mockResolvedValue(null);
const cacheSet = vi.fn().mockResolvedValue(undefined);
const cacheDel = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/cache.service.js", () => ({
  cacheGet: (...args: unknown[]) => cacheGet(...args),
  cacheSet: (...args: unknown[]) => cacheSet(...args),
  cacheDel: (...args: unknown[]) => cacheDel(...args),
}));

const verifyAccessToken = vi.fn().mockReturnValue(null);
vi.mock("../services/jwt.service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/jwt.service.js")>();
  return {
    ...original,
    verifyAccessToken: (...args: unknown[]) => verifyAccessToken(...args),
  };
});

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
    path: "/api/network/wifi/join-code",
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

describe("authMiddleware — SERVICE_TOKEN_DISPLAY bearer", () => {
  beforeEach(() => {
    cacheGet.mockClear();
    cacheSet.mockClear();
    verifyAccessToken.mockClear();
    fetchSpy.mockClear();
  });

  it("recognises SERVICE_TOKEN_DISPLAY and sets the _service:display principal", async () => {
    const req = buildReq({
      headers: { authorization: "Bearer test-display-token-32chars-pad-abcd1" },
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
    expect(user.id).toBe("_service:display");
    expect(user.username).toBe("_service:display");
    expect(user.displayName).toBe("Rack Panel Bridge");
    expect(user.role).toBe("service");
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(cacheGet).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not promote a non-matching bearer to the display principal", async () => {
    const req = buildReq({
      // Same length, every byte differs — exercises timingSafeEqual.
      headers: { authorization: "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }) as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await Promise.resolve();

    expect((req as unknown as FakeReq).user).toBeUndefined();
    expect(verifyAccessToken).toHaveBeenCalledTimes(1);
  });
});

describe("authMiddleware — an unset SERVICE_TOKEN_DISPLAY is not a wildcard", () => {
  // A box whose .env predates the token (or a deployment with no panel) must
  // never promote a caller to a principal that can read the household PSK.
  it("empty configured token does not match an empty Bearer", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: {
        AUTH_ENABLED: true,
        NEXTCLOUD_URL: "http://nextcloud.test",
        SERVICE_TOKEN_DISPLAY: "",
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

    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    expect((req as unknown as FakeReq).user).toBeUndefined();
  });
});

describe("requireRoleOrService — the join-code guard", () => {
  function run(user: unknown, mw: ReturnType<typeof requireRoleOrService>) {
    const req = { user } as unknown as Request;
    const res = buildRes();
    const next = vi.fn() as unknown as NextFunction;
    mw(req, res as unknown as Response, next);
    return { res, next };
  }

  const mw = requireRoleOrService("_service:display", "owner", "admin");

  it("admits the panel bridge", () => {
    const { res, next } = run(
      { id: "_service:display", username: "_service:display", role: "service" },
      mw,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it("403s every OTHER service principal — the body is credential material", () => {
    for (const id of ["_service:mcp", "_service:voice", "_service:ai-gateway",
      "_service:rag-eval", "_service:sampler", "_service:email",
      "_service:egress-audit"]) {
      const { res, next } = run({ id, username: id, role: "service" }, mw);
      expect(res.statusCode, `${id} must not reach the join code`).toBe(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("does not admit the pinned id without the service role", () => {
    const { res, next } = run(
      { id: "_service:display", username: "_service:display", role: "family" },
      mw,
    );
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps the human tier unchanged — owner/admin in, family out", () => {
    const owner = run({ id: "u0", username: "ann", role: "owner" }, mw);
    expect(owner.next).toHaveBeenCalledTimes(1);
    const admin = run({ id: "u1", username: "alice", role: "admin" }, mw);
    expect(admin.next).toHaveBeenCalledTimes(1);
    const family = run({ id: "u2", username: "bob", role: "family" }, mw);
    expect(family.res.statusCode).toBe(403);
    expect(family.next).not.toHaveBeenCalled();
  });
});
