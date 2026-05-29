/**
 * WARP-171: unit tests for the `requireRole(...allowed)` middleware helper.
 *
 * Per ADR-004 §2 the helper lives in `src/middleware/auth.ts` and has
 * **fail-closed semantics**: a request that reaches it without an
 * authenticated principal (no `req.user.role`) returns 403, not 401.
 * The upstream `authMiddleware` already returned 401 if no valid token
 * was present, so reaching `requireRole` means the caller IS
 * authenticated — just not authorized for this route.
 *
 * These tests drive only the middleware in isolation (synthetic
 * req/res/next) — the full role × route matrix lives in rbac.test.ts
 * which exercises real Express routers.
 */
import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Module-level mocks must be hoisted above the SUT import (vitest
// transforms hoist vi.mock calls automatically). The config mock keeps
// the auth module's eager config reads from blowing up when env vars
// aren't set in the test runner.
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

import { requireRole } from "../middleware/auth.js";

interface FakeReq {
  user?: { role?: string; [k: string]: unknown };
}

function buildReq(role?: string): FakeReq {
  return role === undefined ? {} : { user: { role } };
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
  };
  return res;
}

describe("requireRole(...) middleware", () => {
  it("calls next() when the user's role is in the allowed list", () => {
    const mw = requireRole("owner", "admin");
    const req = buildReq("admin") as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(0);
  });

  it("returns 403 (fail-closed) when req.user is absent", () => {
    // Critical: the upstream authMiddleware should never let an
    // unauthenticated request reach a guard, but defense-in-depth
    // requires 403 here (not 401) — the contract is "you're not
    // authorized for this route", and a 401 here would leak the
    // guard-vs-auth-middleware ordering to clients.
    const mw = requireRole("owner");
    const req = {} as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when req.user exists but role is missing", () => {
    const mw = requireRole("owner");
    const req = { user: {} } as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when role is not in the allowed list", () => {
    const mw = requireRole("owner", "admin");
    const req = buildReq("family") as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for the `service` role on routes that don't allow it", () => {
    // Service principals (voice-io, mcp-server) are intentionally
    // read-only — every write guard in the matrix excludes `service`.
    // This is the regression that AC #6 explicitly asks for.
    const mw = requireRole("owner", "admin", "family");
    const req = buildReq("service") as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when the role string is unknown (defense in depth)", () => {
    // The Prisma enum + zod validation should make this unreachable in
    // practice, but the middleware MUST fail closed for any unrecognised
    // value rather than (a) throwing and exposing a stack to the
    // caller, or (b) silently calling next() because the value happens
    // to be falsy.
    const mw = requireRole("owner");
    const req = buildReq("superuser") as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("response body carries a stable shape on 403 (for dashboard error rendering)", () => {
    // The dashboard's apiClient renders `error` as a toast; keep the
    // shape stable so a future schema migration on response bodies
    // doesn't silently regress the UI copy.
    const mw = requireRole("owner");
    const req = buildReq("family") as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    const body = (res as unknown as { body: { error?: string } }).body;
    expect(body).toBeDefined();
    expect(typeof body.error).toBe("string");
    expect(body.error!.length).toBeGreaterThan(0);
  });

  it("zero-argument call returns 403 for every role (no implicit allow-all)", () => {
    // requireRole() with no roles is a programmer error — but it must
    // fail closed rather than allow every authenticated user through.
    const mw = requireRole();
    const req = buildReq("owner") as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    mw(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
