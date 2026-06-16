/**
 * WARP-287 — admin re-index route tests.
 *
 * Covers the route-level glue (RBAC, MFA, status-code mapping). The
 * underlying reindex service is mocked — its own logic (advisory lock,
 * file-indexer call) is covered separately.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock the reindex service before importing the router. Vitest hoists
// `vi.mock` to the top of the module, so the spy itself has to be
// declared via `vi.hoisted` to be visible at hoist time — a plain
// `const` would be in the TDZ when the mock factory runs.
const { reindexSpy } = vi.hoisted(() => ({ reindexSpy: vi.fn() }));
vi.mock("../services/file-reindex.service", () => ({
  reindexFile: reindexSpy,
  INDEX_IN_PROGRESS: "INDEX_IN_PROGRESS",
}));

import { adminFilesRouter } from "./admin-files.js";

function mkApp(opts: {
  user?: { id: string; role?: string; lastMfaAt?: Date | null };
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = opts.user;
    next();
  });
  app.use("/api/admin", adminFilesRouter);
  return app;
}

describe("POST /api/admin/files/:id/reindex", () => {
  beforeEach(() => {
    reindexSpy.mockReset();
  });

  it("returns 401 mfa_required when MFA is stale", async () => {
    const app = mkApp({
      user: { id: "u1", role: "admin", lastMfaAt: null },
    });
    const res = await request(app).post("/api/admin/files/f1/reindex");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("mfa_required");
  });

  it("returns 403 when caller is not an admin", async () => {
    const app = mkApp({
      user: { id: "u1", role: "user", lastMfaAt: new Date() },
    });
    const res = await request(app).post("/api/admin/files/f1/reindex");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("admin_required");
  });

  it("returns 200 + reindexed count when MFA is fresh and reindex succeeds", async () => {
    reindexSpy.mockResolvedValue({ chunksWritten: 7 });
    const app = mkApp({
      user: { id: "u1", role: "admin", lastMfaAt: new Date() },
    });
    const res = await request(app).post("/api/admin/files/f1/reindex");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fileId: "f1", chunksWritten: 7 });
    expect(reindexSpy).toHaveBeenCalledWith({ fileId: "f1", actor: "u1" });
  });

  it("returns 409 when an advisory lock is held by another transaction", async () => {
    reindexSpy.mockRejectedValue(
      Object.assign(new Error("lock"), { code: "INDEX_IN_PROGRESS" }),
    );
    const app = mkApp({
      user: { id: "u1", role: "admin", lastMfaAt: new Date() },
    });
    const res = await request(app).post("/api/admin/files/f1/reindex");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("index_in_progress");
  });

  it("returns 500 + rolls back on extractor failure", async () => {
    reindexSpy.mockRejectedValue(new Error("extractor blew up"));
    const app = mkApp({
      user: { id: "u1", role: "admin", lastMfaAt: new Date() },
    });
    const res = await request(app).post("/api/admin/files/f1/reindex");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("reindex_failed");
  });
});
