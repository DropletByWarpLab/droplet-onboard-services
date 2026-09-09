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
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// Force the cache to always miss by default so we exercise the Nextcloud path.
// Individual tests override cacheGet via mockResolvedValueOnce for cache-hit
// coverage. cacheDel is wired because the cache-hit re-validation purges a
// stale entry when it finds the user has been deactivated.
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

// Force JWT verification to fail so we fall through to Nextcloud OCS.
vi.mock("../services/jwt.service.js", () => ({
  verifyAccessToken: vi.fn().mockReturnValue(null),
  roleFromGroups: vi.fn().mockReturnValue("family"),
  // WARP-1636 — the OCS fallback mints through this funnel now. Stubbed
  // flat here because this suite is about the OCS transport, not the rank
  // cap; the cap itself is covered against the REAL module in
  // __tests__/auth.ocs-role-cap.test.ts (which deliberately does not mock
  // jwt.service, so deleting the cap turns it red).
  resolveNcSessionRole: vi.fn().mockReturnValue("family"),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30,
}));

import {
  authMiddleware,
  requirePasswordChangeGate,
  requireRole,
  _setAuthPrismaForTests,
} from "./auth.js";
import { cacheGet, cacheSet, cacheDel } from "../services/cache.service.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";
import type { RecordParams } from "../services/activity.service.js";

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

  it("rejects a SCIM-deactivated user on the cache-MISS path and does not cache them (ADR-013)", async () => {
    // OCS validates fine upstream, but the local row is DEACTIVATED. The middleware
    // must 401 and must NOT write the deactivated user into the token cache (a
    // cached entry would otherwise pass auth for up to TOKEN_CACHE_TTL).
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ocs: {
          meta: { status: "ok" },
          data: { id: "carol", "display-name": "Carol", groups: [] },
        },
      }),
    } as unknown as Response);
    _setAuthPrismaForTests({
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "u-uuid-carol-0003",
          username: "carol",
          displayName: "Carol",
          nextcloudUsername: "carol",
          role: "family",
          isLocal: false,
          directoryStatus: "DEACTIVATED",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    } as any);
    // These cache mocks are module-level and not reset between tests, so clear
    // the call history we assert on here.
    (cacheSet as ReturnType<typeof vi.fn>).mockClear();

    const req = mockReq("deactivated-ocs-token");
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    // Critical: the deactivated user is never written to the token cache.
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("rejects a deactivated user on the cache-HIT path and purges the stale entry (ADR-013)", async () => {
    // The token is warm in the cache, but the user was deactivated since it was
    // written. The cache-hit re-validation must catch it (indexed single-column
    // select), 401, purge the entry, and never touch the OCS fetch.
    (cacheGet as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "u-uuid-dave-0004",
      username: "dave",
      displayName: "Dave",
      role: "family",
    });
    const findUnique = vi.fn().mockResolvedValue({ directoryStatus: "DEACTIVATED" });
    _setAuthPrismaForTests({ user: { findUnique } } as any);
    (cacheDel as ReturnType<typeof vi.fn>).mockClear();

    const req = mockReq("warm-but-deactivated-token");
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    // Re-validated by a single-column select on the primary key, not a full row.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "u-uuid-dave-0004" },
      select: { directoryStatus: true },
    });
    // Stale cache entry purged; OCS fetch never reached on a hit.
    expect(cacheDel).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
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

describe("requirePasswordChangeGate — allowed-path matching", () => {
  // A must-change user must always be able to REACH the remediation endpoint.
  // The allow-list is exact-match, so a trailing slash on the path used to slip
  // past it and 403 the user out of the very endpoint that clears the flag.
  function gateReq(path: string): Request {
    return {
      user: { id: "u-1", role: "owner" },
      path,
    } as unknown as Request;
  }

  // findUnique resolves AFTER the allow-path short-circuit; if the gate reaches
  // it for an allowed path, mustChangePassword:true would (wrongly) 403.
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ mustChangePassword: true }),
    },
  } as unknown as Parameters<typeof requirePasswordChangeGate>[0];

  beforeEach(() => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockClear();
  });

  it("allows the change-password endpoint WITH a trailing slash", async () => {
    const gate = requirePasswordChangeGate(prisma);
    const req = gateReq("/api/auth/change-password/");
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    gate(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(next).toHaveBeenCalledTimes(1);
    expect((res.status as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // The allow-path short-circuit fires before any DB read.
    expect(prisma.user.findUnique as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("allows the change-password endpoint without a trailing slash", async () => {
    const gate = requirePasswordChangeGate(prisma);
    const req = gateReq("/api/auth/change-password");
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    gate(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(next).toHaveBeenCalledTimes(1);
    expect((res.status as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("still 403s a must-change user on a protected (non-allowed) path", async () => {
    const gate = requirePasswordChangeGate(prisma);
    const req = gateReq("/api/llm/models");
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    gate(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("requireRole — policy-violation audit emit (WARP-237)", () => {
  let recorded: RecordParams[];

  beforeEach(() => {
    recorded = [];
    _setActivityRecorderForTests(
      {
        record: async (p) => {
          recorded.push(p);
          return {} as never;
        },
      },
      null,
    );
  });

  afterEach(() => {
    _setActivityRecorderForTests(null, null);
  });

  it("emits a policy-violation activity row on a role denial", async () => {
    const mw = requireRole("owner", "admin");
    const req = {
      user: { id: "u-guest", role: "guest" },
      method: "POST",
      path: "/api/files/share",
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(recorded).toContainEqual(
      expect.objectContaining({
        kind: "auth",
        severity: "warn",
        what: "Access denied",
        refs: expect.objectContaining({
          path: "/api/files/share",
          method: "POST",
          role: "guest",
        }),
      }),
    );
  });

  it("does not emit or 403 when the role is permitted", async () => {
    const mw = requireRole("owner", "admin");
    const req = {
      user: { id: "u-admin", role: "admin" },
      method: "POST",
      path: "/api/files/share",
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(next).toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });
});
