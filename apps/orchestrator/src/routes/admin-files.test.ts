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
  users?: Array<{
    id: string;
    displayName: string;
    username: string;
    nextcloudUsername: string | null;
    // C2 (PR #1223 review): non-optional, mirroring fetchUserUsageRow's
    // param contract — a fixture omitting it must fail compilation.
    usagePolicy?: { storageQuotaBytes: bigint | null; maxUploadSizeMb: number | null } | null;
    // WARP-1531 (RBAC v2 T7): AccessRole usage defaults.
    accessRole?: { storageQuotaBytes: bigint | null; maxUploadSizeMb: number | null } | null;
  }>;
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
        // WARP-1531: no person row, no role → box default; quota stays the
        // live NC value (today's behavior) and the sources say so honestly.
        quotaSource: "default",
        used: "4000000000",
        free: "1000000000",
        largestUploadMb: null,
        largestUploadMbSource: "default",
        lastActive: null,
      },
    ]);
  });

  it("returns the per-user upload-cap override from UserUsagePolicy", async () => {
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
          {
            id: "u1",
            displayName: "Alice",
            username: "alice",
            nextcloudUsername: "alice",
            usagePolicy: { storageQuotaBytes: null, maxUploadSizeMb: 2048 },
          },
        ],
      }),
    );
    const res = await request(app).get("/api/admin/files/usage");
    expect(res.status).toBe(200);
    expect(res.body.users[0].largestUploadMb).toBe(2048);
    expect(res.body.users[0].largestUploadMbSource).toBe("person");
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
      {
        userId: "u1",
        displayName: "Alice",
        quota: "—",
        quotaSource: "default",
        used: "—",
        free: "—",
        largestUploadMb: null,
        largestUploadMbSource: "default",
        lastActive: null,
      },
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
      {
        userId: "u2",
        displayName: "NoNc",
        quota: null,
        quotaSource: "default",
        used: "—",
        free: null,
        largestUploadMb: null,
        largestUploadMbSource: "default",
        lastActive: null,
      },
    ]);
    expect(ncGetUserQuotaAdminMock).not.toHaveBeenCalled();
  });

  // ── WARP-1531 (RBAC v2 T7): effective quota + provenance in the roster ──

  it("a role-default user reports the role's quota as the EFFECTIVE value, BigInt string-encoded", async () => {
    // NC still reports an older/different live quota — the roster's quota
    // column is the resolved desired state once a role manages it.
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
          {
            id: "u1",
            displayName: "Alice",
            username: "alice",
            nextcloudUsername: "alice",
            accessRole: { storageQuotaBytes: 10_737_418_240n, maxUploadSizeMb: 100 },
          },
        ],
      }),
    );
    const res = await request(app).get("/api/admin/files/usage");
    expect(res.status).toBe(200);
    expect(res.body.users[0]).toEqual({
      userId: "u1",
      displayName: "Alice",
      quota: "10737418240",
      quotaSource: "role",
      used: "4000000000",
      free: "1000000000",
      largestUploadMb: 100,
      largestUploadMbSource: "role",
      lastActive: null,
    });
  });

  it("a person policy beats the role default, field-by-field", async () => {
    ncGetUserQuotaAdminMock.mockResolvedValue({
      used: 1_000,
      free: 2_000,
      total: 3_000,
      quota: 3_000,
    });
    gfListFoldersMock.mockResolvedValue([]);
    const app = mkUsageApp(
      mkUsagePrisma({
        users: [
          {
            id: "u1",
            displayName: "Alice",
            username: "alice",
            nextcloudUsername: "alice",
            // Person sets ONLY storage — the upload cap still inherits the role.
            usagePolicy: { storageQuotaBytes: 1_073_741_824n, maxUploadSizeMb: null },
            accessRole: { storageQuotaBytes: 10_737_418_240n, maxUploadSizeMb: 100 },
          },
        ],
      }),
    );
    const res = await request(app).get("/api/admin/files/usage");
    expect(res.status).toBe(200);
    expect(res.body.users[0].quota).toBe("1073741824");
    expect(res.body.users[0].quotaSource).toBe("person");
    expect(res.body.users[0].largestUploadMb).toBe(100);
    expect(res.body.users[0].largestUploadMbSource).toBe("role");
  });

  it("a role-managed quota still renders when the NC read fails (used/free stay an honest '—')", async () => {
    ncGetUserQuotaAdminMock.mockRejectedValue(new Error("nc down"));
    gfListFoldersMock.mockResolvedValue([]);
    const app = mkUsageApp(
      mkUsagePrisma({
        users: [
          {
            id: "u1",
            displayName: "Alice",
            username: "alice",
            nextcloudUsername: "alice",
            accessRole: { storageQuotaBytes: 5_368_709_120n, maxUploadSizeMb: null },
          },
        ],
      }),
    );
    const res = await request(app).get("/api/admin/files/usage");
    expect(res.status).toBe(200);
    expect(res.body.users[0].quota).toBe("5368709120");
    expect(res.body.users[0].quotaSource).toBe("role");
    expect(res.body.users[0].used).toBe("—");
    expect(res.body.users[0].free).toBe("—");
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
