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
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30,
}));

import {
  authMiddleware,
  requirePasswordChangeGate,
  requireRole,
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

// WARP-2994: the Nextcloud OCS validation describe that lived here is gone
// with the fallback it tested — see __tests__/auth.nc-password-reset-escalation.test.ts.

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
