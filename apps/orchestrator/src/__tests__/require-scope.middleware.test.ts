/**
 * WARP-455 — requireScope(resource, loadUserScopes) middleware.
 *
 * Second RBAC axis on top of WARP-171's `requireRole`. The contract:
 *
 *   role × scope truth table
 *   ───────────────────────────────────────────────────────────────
 *     role        |  binding for `resource`?  |  result
 *     ────────────┼───────────────────────────┼──────────────
 *     owner       |  any                      |  pass
 *     admin       |  any                      |  pass
 *     family      |  yes                      |  pass
 *     family      |  no                       |  403
 *     guest       |  yes                      |  pass
 *     guest       |  no                       |  403
 *     service     |  any                      |  403  (read-only)
 *     missing     |  —                        |  403
 *     unknown     |  —                        |  403
 *
 * `owner` and `admin` always pass because they hold every scope by
 * definition (ADR-004 §3 — admin-tier passes every write). Service
 * principals never pass scope-guarded routes: voice-io and mcp-server
 * are read-only by design, the scope axis is for human role gradients.
 *
 * The middleware delegates scope lookup to an injected
 * `loadUserScopes(userId)` so the route layer can pass a Prisma-backed
 * loader and unit tests can pass a fixed Set without spinning up a DB.
 */
import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true },
}));

import {
  requireScope,
  type ScopeLoader,
  type ScopeName,
} from "../middleware/scope.js";

function buildReq(role?: string, id = "u1"): Request {
  return (role === undefined
    ? {}
    : { user: { id, role, username: id, displayName: id } }) as unknown as Request;
}

function buildRes() {
  return {
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
}

function loaderReturning(scopes: ScopeName[]): ScopeLoader {
  return vi.fn(async (_userId: string) => new Set<ScopeName>(scopes));
}

describe("requireScope(resource, loadUserScopes) — truth table", () => {
  it("owner passes regardless of bindings (every scope by definition)", async () => {
    const mw = requireScope("finance", loaderReturning([])); // no bindings
    const req = buildReq("owner");
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(0);
  });

  it("admin passes regardless of bindings", async () => {
    const mw = requireScope("exec_only", loaderReturning([]));
    const req = buildReq("admin");
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("family passes when they have the binding for the resource scope", async () => {
    const mw = requireScope("team", loaderReturning(["team"]));
    const req = buildReq("family");
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("family is 403'd when missing the binding for the resource scope", async () => {
    const mw = requireScope("finance", loaderReturning(["team"]));
    const req = buildReq("family");
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("guest passes when they have the binding for the resource scope", async () => {
    const mw = requireScope("team", loaderReturning(["team"]));
    const req = buildReq("guest");
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("guest is 403'd when missing the binding", async () => {
    const mw = requireScope("engineering", loaderReturning([]));
    const req = buildReq("guest");
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("service is 403'd regardless of bindings (scope axis is human-only)", async () => {
    const mw = requireScope("team", loaderReturning(["team"]));
    const req = buildReq("service");
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when req.user is absent (fail-closed, mirrors requireRole)", async () => {
    const mw = requireScope("team", loaderReturning(["team"]));
    const req = {} as unknown as Request;
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for an unknown role string (defense in depth)", async () => {
    const mw = requireScope("team", loaderReturning(["team"]));
    const req = buildReq("superuser");
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("response body carries a stable shape on 403", async () => {
    const mw = requireScope("team", loaderReturning([]));
    const req = buildReq("family");
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    const body = (res as unknown as { body: { error?: string } }).body;
    expect(body).toBeDefined();
    expect(typeof body.error).toBe("string");
    expect(body.error!.length).toBeGreaterThan(0);
  });

  it("skips loader entirely for owner/admin (no DB round-trip for admin-tier)", async () => {
    // Owners + admins hold every scope by definition; the loader
    // should NEVER run for them. This keeps the hot path off
    // Postgres for the most common request profile.
    const loader = loaderReturning([]);
    const mw = requireScope("finance", loader);
    const req = buildReq("owner");
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    expect(loader).not.toHaveBeenCalled();
  });

  it("the loader is invoked with the authenticated user's id", async () => {
    const loader = loaderReturning(["team"]);
    const mw = requireScope("team", loader);
    const req = buildReq("family", "alice-id");
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith("alice-id");
  });

  it("returns 500 (not 403) when the loader throws — service-error vs auth-error", async () => {
    // A DB hiccup on scope lookup is operational, not an
    // authorization failure. Mirroring the existing
    // authMiddleware → 500 → "service error" path for OCS failures
    // keeps the dashboard's error rendering consistent.
    const loader = vi.fn(async (_id: string) => {
      throw new Error("prisma down");
    });
    const mw = requireScope("team", loader);
    const req = buildReq("family");
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });
});
