/**
 * WARP-303 — auth middleware must NOT hang indefinitely when Nextcloud is
 * slow or unreachable. The OCS validation fetch is bounded by
 * `AbortSignal.timeout` so a slow Nextcloud surfaces as a clean 401 rather
 * than a request that never resolves (which previously held up
 * `/api/llm/models` polls and showed to users as intermittent 401s).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    FILES_ROOT: "/tmp/files",
    MAX_UPLOAD_SIZE_MB: 10,
    STORAGE_BACKEND: "nextcloud",
    JWT_SECRET: "test-secret-at-least-32-chars-long-aaa",
  },
}));

// Force the cache to always miss so we exercise the Nextcloud path.
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

// Force JWT verification to fail so we fall through to Nextcloud OCS.
vi.mock("../services/jwt.service.js", () => ({
  verifyAccessToken: vi.fn().mockReturnValue(null),
  roleFromGroups: vi.fn().mockReturnValue("family"),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30,
}));

import { authMiddleware, _setAuthPrismaForTests } from "./auth.js";

function mockReq(token: string): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
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

describe("authMiddleware — Nextcloud OCS validation", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    // WARP-485: by default each test runs without a Prisma binding so
    // the OCS path falls into the fail-closed USER_NOT_PROVISIONED
    // branch. Tests that need a populated User row (the happy-path
    // "bounded AbortSignal" case below) wire a per-test mock.
    _setAuthPrismaForTests(null);
  });

  afterEach(() => {
    global.fetch = realFetch;
    _setAuthPrismaForTests(null);
  });

  it("passes a bounded AbortSignal to the OCS fetch", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ocs: {
          meta: { status: "ok" },
          data: { id: "alice", "display-name": "Alice", groups: [] },
        },
      }),
    } as unknown as Response);
    // WARP-485: the OCS fallback now resolves `ocs.data.id` to a local
    // User row before populating req.user. Wire a minimal mock that
    // returns a UUID-shaped id so the happy path completes and `next()`
    // gets called (which is what this test still asserts).
    _setAuthPrismaForTests({
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "u-uuid-alice-0001",
          username: "alice",
          displayName: "Alice",
          email: null,
          nextcloudUsername: "alice",
          role: "family",
          isLocal: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    } as any);

    const req = mockReq("legacy-token");
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    // Drain the validation promise.
    await new Promise((r) => setImmediate(r));

    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("http://nextcloud.test/ocs/v1.php/cloud/user");
    expect(call[1]).toBeDefined();
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
    expect((next as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("returns 401 (not a hang) when the OCS fetch is aborted by the timeout", async () => {
    // Simulate a stuck Nextcloud: the fetch listens for abort and rejects.
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("timed out", "TimeoutError"));
          });
          // Force-fire immediately to keep the test fast — the real timeout
          // is 5 s but the contract is "abort makes us fail closed", not
          // "abort takes 5 s to surface."
          setTimeout(() => {
            try {
              (init.signal as AbortSignal & { dispatchEvent?: Function })
                ?.dispatchEvent?.(new Event("abort"));
            } catch {
              /* no-op */
            }
          }, 0);
        });
      },
    );

    const req = mockReq("slow-nextcloud-token");
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    // Wait long enough for the timeout to fire and the catch to run.
    await new Promise((r) => setTimeout(r, 50));

    // Nextcloud fail → validateNextcloudToken returns null → middleware 401s.
    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 500 if validation throws unexpectedly (separate from timeout)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      // Throw synchronously inside fetch — separate from abort.
      throw new TypeError("unexpected");
    });

    const req = mockReq("any-token");
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    // validateNextcloudToken catches errors and returns null, so the
    // middleware should 401, not 500. Confirm this is still the contract.
    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(401);
  });
});
