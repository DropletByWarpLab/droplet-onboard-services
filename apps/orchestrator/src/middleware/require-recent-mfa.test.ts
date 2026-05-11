/**
 * WARP-230 — unit tests for require-recent-mfa middleware.
 */
import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

import { createRequireRecentMfa } from "./require-recent-mfa.js";

function mockRes(): Response {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis() as unknown as Response["status"],
    json: vi.fn().mockReturnThis() as unknown as Response["json"],
  };
  return res as Response;
}

describe("require-recent-mfa", () => {
  it("calls next() when lastMfaAt is within the window", () => {
    const mw = createRequireRecentMfa({ windowSec: 60 });
    const req = {
      user: { username: "alice", lastMfaAt: new Date(Date.now() - 30_000) },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 401 mfa_stale when lastMfaAt is older than the window", () => {
    const mw = createRequireRecentMfa({ windowSec: 60 });
    const req = {
      user: { username: "alice", lastMfaAt: new Date(Date.now() - 120_000) },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "mfa_stale" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 mfa_required when lastMfaAt is null", () => {
    const mw = createRequireRecentMfa({ windowSec: 60 });
    const req = {
      user: { username: "alice", lastMfaAt: null },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "mfa_required" }),
    );
  });

  it("returns 401 auth_required when no req.user", () => {
    const mw = createRequireRecentMfa({ windowSec: 60 });
    const req = {} as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "auth_required" }),
    );
  });

  it("accepts ISO string lastMfaAt and parses correctly", () => {
    const mw = createRequireRecentMfa({ windowSec: 60 });
    const recent = new Date(Date.now() - 15_000).toISOString();
    const req = {
      user: { username: "alice", lastMfaAt: recent },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects unparseable lastMfaAt as mfa_required", () => {
    const mw = createRequireRecentMfa({ windowSec: 60 });
    const req = {
      user: { username: "alice", lastMfaAt: "not-a-date" },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "mfa_required" }),
    );
  });
});
