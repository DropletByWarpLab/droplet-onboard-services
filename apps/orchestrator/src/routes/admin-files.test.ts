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

// WARP-1271 (T19a): admin usage roster deps.
const { ncGetUserQuotaAdminMock, gfListFoldersMock } = vi.hoisted(() => ({
  ncGetUserQuotaAdminMock: vi.fn(),
  gfListFoldersMock: vi.fn(),
}));
vi.mock("../services/nextcloud.client.js", () => ({
  ncGetUserQuotaAdmin: ncGetUserQuotaAdminMock,
}));
vi.mock("../services/nextcloud-groups.client.js", () => ({
  gfListFolders: gfListFoldersMock,
}));
vi.mock("../services/department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic:dGVzdDp0ZXN0"),
}));

import { adminFilesRouter, createAdminFilesUsageRouter } from "./admin-files.js";

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

// ── WARP-1271 (T19a): GET /api/admin/files/usage ───────────────────────

function mkUsagePrisma(opts: {
  users?: Array<{ id: string; displayName: string; username: string; nextcloudUsername: string | null }>;
  departments?: Array<{ id: string; name: string; kind: string; ncGroupfolderId: number | null; quotaBytes: bigint | null }>;
}) {
  return {
    user: { findMany: vi.fn().mockResolvedValue(opts.users ?? []) },
    department: { findMany: vi.fn().mockResolvedValue(opts.departments ?? []) },
  } as any;
}

function mkUsageApp(
  prisma: ReturnType<typeof mkUsagePrisma>,
  user: { id: string; role?: string } = { id: "owner-1", role: "owner" },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = user;
    next();
  });
  app.use("/api/admin", createAdminFilesUsageRouter(prisma));
  return app;
}

describe("GET /api/admin/files/usage", () => {
  beforeEach(() => {
    ncGetUserQuotaAdminMock.mockReset();
    gfListFoldersMock.mockReset();
  });

  it("403 for a non-admin caller", async () => {
    const app = mkUsageApp(mkUsagePrisma({}), { id: "u1", role: "family" });
    const res = await request(app).get("/api/admin/files/usage");
    expect(res.status).toBe(403);
  });

  it("returns per-user rows with BigInt fields string-encoded", async () => {
    ncGetUserQuotaAdminMock.mockResolvedValue({
      used: 4_000_000_000,
      free: 1_000_000_000,
      total: 5_000_000_000,
      quota: 5_000_000_000,
    });
    gfListFoldersMock.mockResolvedValue([]);
    const app = mkUsageApp(
      mkUsagePrisma({
        users: [
          { id: "u1", displayName: "Alice", username: "alice", nextcloudUsername: "alice" },
        ],
      }),
    );
    const res = await request(app).get("/api/admin/files/usage");
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([
      {
        userId: "u1",
        displayName: "Alice",
        quota: "5000000000",
        used: "4000000000",
        free: "1000000000",
      },
    ]);
  });

  it("tolerates a per-user quota-read failure with an honest '—', never dropping the row or 500ing", async () => {
    ncGetUserQuotaAdminMock.mockRejectedValue(new Error("nc down"));
    gfListFoldersMock.mockResolvedValue([]);
    const app = mkUsageApp(
      mkUsagePrisma({
        users: [
          { id: "u1", displayName: "Alice", username: "alice", nextcloudUsername: "alice" },
        ],
      }),
    );
    const res = await request(app).get("/api/admin/files/usage");
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([
      { userId: "u1", displayName: "Alice", quota: "—", used: "—", free: "—" },
    ]);
  });

  it("a user with no Nextcloud account yet never calls the quota client", async () => {
    gfListFoldersMock.mockResolvedValue([]);
    const app = mkUsageApp(
      mkUsagePrisma({
        users: [
          { id: "u2", displayName: "NoNc", username: "nonc", nextcloudUsername: null },
        ],
      }),
    );
    const res = await request(app).get("/api/admin/files/usage");
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([
      { userId: "u2", displayName: "NoNc", quota: null, used: "—", free: null },
    ]);
    expect(ncGetUserQuotaAdminMock).not.toHaveBeenCalled();
  });

  it("returns per-department rows from gfListFolders, BigInt quota string-encoded", async () => {
    gfListFoldersMock.mockResolvedValue([
      { id: 7, mountPoint: "Sales", groups: {}, quota: -3, size: 123_456, acl: true, manage: [] },
    ]);
    const app = mkUsageApp(
      mkUsagePrisma({
        departments: [
          { id: "d1", name: "Sales", kind: "DEPARTMENT", ncGroupfolderId: 7, quotaBytes: 999_999n },
        ],
      }),
    );
    const res = await request(app).get("/api/admin/files/usage");
    expect(res.status).toBe(200);
    expect(res.body.departments).toEqual([
      { id: "d1", name: "Sales", kind: "DEPARTMENT", sizeBytes: "123456", quotaBytes: "999999" },
    ]);
  });

  it("a department whose groupfolder id isn't discovered yet reports sizeBytes '—'", async () => {
    gfListFoldersMock.mockResolvedValue([]);
    const app = mkUsageApp(
      mkUsagePrisma({
        departments: [
          { id: "d1", name: "Sales", kind: "DEPARTMENT", ncGroupfolderId: null, quotaBytes: null },
        ],
      }),
    );
    const res = await request(app).get("/api/admin/files/usage");
    expect(res.status).toBe(200);
    expect(res.body.departments).toEqual([
      { id: "d1", name: "Sales", kind: "DEPARTMENT", sizeBytes: "—", quotaBytes: null },
    ]);
  });
});
