/**
 * WARP-1456 — MCP-principal admission on the two /api/files routes the
 * share_file / restore_file_version LLM tools dispatch through.
 *
 * The tools present the `_service:mcp` principal (role "service"), which
 * plain requireRole 403s — the dead-tool class WARP-1439/WARP-1450 fixed
 * for cameras/updates. These tests pin that POST /files/share and
 * POST /files/versions/restore are requireRoleOrMcpService with the SAME
 * human role set as before (owner/admin/family — family stays admitted,
 * guest stays denied), and that the WARP-861 NC-identity idiom holds:
 * the service principal acts ONLY as the X-Nextcloud-User with the
 * X-Nextcloud-Token credential (missing either → 401, never an admin
 * fallback), while a human's spoofed headers are ignored (session wins).
 *
 * Scaffolding per files.mcp-service.test.ts / files.manager-shares.test.ts:
 * REAL auth + space guards, a req.user shim, mocked NC client so per-call
 * identity is assertable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js",
  );
  return {
    NextcloudOcsError: actual.NextcloudOcsError,
    ncListFiles: vi.fn(),
    ncCreateDirectory: vi.fn(),
    ncUploadFile: vi.fn(),
    ncDownloadFile: vi.fn(),
    ncDeleteFile: vi.fn(),
    ncListShares: vi.fn(),
    ncMoveFile: vi.fn(),
    ncCopyFile: vi.fn(),
    ncGetFileId: vi.fn(),
    ncListTrash: vi.fn(),
    ncRestoreTrashItem: vi.fn(),
    ncDeleteTrashItem: vi.fn(),
    ncEmptyTrash: vi.fn(),
    ncListVersions: vi.fn(),
    ncRestoreVersion: vi.fn(),
    ncSetFavorite: vi.fn(),
    ncListFavorites: vi.fn(),
    ncSearchFiles: vi.fn(),
    ncListRecents: vi.fn(),
    ncFetchThumbnail: vi.fn(),
    ncCreateShareV2: vi.fn(),
    ncUpdateShare: vi.fn(),
    ncDeleteShare: vi.fn(),
    ncListSharedWithMe: vi.fn(),
    ncListOutboundShares: vi.fn(),
    ncListMyShares: vi.fn(),
    ncGetShare: vi.fn(),
    ncDirExists: vi.fn(),
  };
});

// Session-cookie credential resolution for NON-service callers.
const mockResolveNcToken = vi.fn();
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: (...a: unknown[]) => mockResolveNcToken(...a),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  // WARP-1682: invalidateListing falls back to a prefix sweep when the
  // caller's ACL tag cannot be resolved, which is the state these stubs put
  // it in — the double has to carry the whole module surface it exercises.
  invalidatePrefix: vi.fn().mockResolvedValue(0),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config.js", () => ({
  config: {
    MAX_UPLOAD_SIZE_MB: 10,
    NODE_ENV: "test",
    DROPLET_SHARED_FOLDER_NAME: "Household",
    NEXTCLOUD_URL: "http://nextcloud.test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { createFilesRouter } from "../routes/files.js";
import * as nc from "../services/nextcloud.client.js";

const ncCreateShareV2 = nc.ncCreateShareV2 as unknown as ReturnType<typeof vi.fn>;
const ncGetFileId = nc.ncGetFileId as unknown as ReturnType<typeof vi.fn>;
const ncRestoreVersion = nc.ncRestoreVersion as unknown as ReturnType<typeof vi.fn>;
const ncListVersions = nc.ncListVersions as unknown as ReturnType<typeof vi.fn>;

const SHARE = {
  id: 101,
  url: "https://nc.example/s/AbCdEf",
  token: "AbCdEf",
  shareType: 3,
  permissions: 1,
  path: "/report.pdf",
  expireDate: "2026-07-27",
  hasPassword: false,
  note: null,
  shareWith: null,
  shareWithDisplayName: null,
  uidOwner: "alice",
  ownerDisplayName: "Alice",
  stime: 1753000000,
};

function buildApp(asUser: { id: string; username: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  // Personal-space calls never touch these models; stubs exist so a
  // regression into the dept branch fails loudly instead of crashing.
  const prismaStub = {
    department: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
    departmentMembership: { findUnique: vi.fn().mockResolvedValue(null) },
    departmentShare: { create: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  app.use("/api", createFilesRouter(prismaStub as never));
  return app;
}

const MCP = { id: "_service:mcp", username: "_service:mcp", role: "service" };
const FAMILY = { id: "u-1", username: "romain", role: "family" };
const GUEST = { id: "u-2", username: "visitor", role: "guest" };

beforeEach(() => {
  ncCreateShareV2.mockReset().mockResolvedValue({ ...SHARE });
  ncGetFileId.mockReset().mockResolvedValue(42);
  ncRestoreVersion.mockReset().mockResolvedValue(undefined);
  ncListVersions.mockReset().mockResolvedValue([
    { versionId: "1752800000", size: 1024, modifiedAt: "2026-07-18T01:33:20.000Z" },
  ]);
  mockResolveNcToken.mockReset().mockResolvedValue("session-token");
});

describe("WARP-1456 — POST /files/share admits the MCP service principal", () => {
  it("MCP + both NC headers → share minted AS the asserted user's credential", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/share")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "alice")
      .send({ path: "/report.pdf", shareType: 3, permissions: 1, expireDate: "2026-07-27" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 101, url: "https://nc.example/s/AbCdEf" });
    expect(ncCreateShareV2).toHaveBeenCalledWith(
      "nct-user-cred",
      "/report.pdf",
      expect.objectContaining({ shareType: 3, permissions: 1, expireDate: "2026-07-27" }),
    );
    // The session resolver must not even be consulted for the service path.
    expect(mockResolveNcToken).not.toHaveBeenCalled();
  });

  it("MCP without the token header → 401 fail-closed, no share", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/share")
      .set("X-Nextcloud-User", "alice")
      .send({ path: "/report.pdf" });

    expect(res.status).toBe(401);
    expect(ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("MCP with no NC headers at all → 401 fail-closed, no share", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/share")
      .send({ path: "/report.pdf" });

    expect(res.status).toBe(401);
    expect(ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("human RBAC unchanged: family still admitted, on the SESSION credential", async () => {
    const res = await request(buildApp(FAMILY))
      .post("/api/files/share")
      .send({ path: "/x.txt" });

    expect(res.status).toBe(200);
    expect(ncCreateShareV2).toHaveBeenCalledWith(
      "session-token",
      "/x.txt",
      expect.objectContaining({ shareType: 3, permissions: 1 }),
    );
  });

  it("human RBAC unchanged: guest still denied 403", async () => {
    const res = await request(buildApp(GUEST))
      .post("/api/files/share")
      .send({ path: "/x.txt" });

    expect(res.status).toBe(403);
    expect(ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("ignores spoofed NC headers from a human — the session rules", async () => {
    const res = await request(buildApp(FAMILY))
      .post("/api/files/share")
      .set("X-Nextcloud-Token", "attacker-token")
      .set("X-Nextcloud-User", "admin")
      .send({ path: "/x.txt" });

    expect(res.status).toBe(200);
    expect(ncCreateShareV2).toHaveBeenCalledWith(
      "session-token",
      "/x.txt",
      expect.anything(),
    );
  });
});

describe("WARP-1456 — POST /files/versions/restore admits the MCP service principal", () => {
  it("MCP + both NC headers → restore runs AS the asserted user", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/versions/restore")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "alice")
      .send({ path: "/notes.txt", versionId: "1752800000" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ restored: { path: "/notes.txt", versionId: "1752800000" } });
    expect(ncGetFileId).toHaveBeenCalledWith("nct-user-cred", "alice", "/notes.txt");
    expect(ncRestoreVersion).toHaveBeenCalledWith("nct-user-cred", "alice", 42, "1752800000");
    expect(mockResolveNcToken).not.toHaveBeenCalled();
  });

  it("MCP without the user header → 401 fail-closed (no admin fallback), no restore", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/versions/restore")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .send({ path: "/notes.txt", versionId: "1752800000" });

    expect(res.status).toBe(401);
    expect(ncGetFileId).not.toHaveBeenCalled();
    expect(ncRestoreVersion).not.toHaveBeenCalled();
  });

  it("human RBAC unchanged: family still admitted, on the SESSION identity", async () => {
    const res = await request(buildApp(FAMILY))
      .post("/api/files/versions/restore")
      .send({ path: "/notes.txt", versionId: "1752800000" });

    expect(res.status).toBe(200);
    expect(ncGetFileId).toHaveBeenCalledWith("session-token", "romain", "/notes.txt");
    expect(ncRestoreVersion).toHaveBeenCalledWith("session-token", "romain", 42, "1752800000");
  });

  it("human RBAC unchanged: guest still denied 403", async () => {
    const res = await request(buildApp(GUEST))
      .post("/api/files/versions/restore")
      .send({ path: "/notes.txt", versionId: "1752800000" });

    expect(res.status).toBe(403);
    expect(ncRestoreVersion).not.toHaveBeenCalled();
  });

  it("ignores spoofed NC headers from a human — the session rules", async () => {
    const res = await request(buildApp(FAMILY))
      .post("/api/files/versions/restore")
      .set("X-Nextcloud-Token", "attacker-token")
      .set("X-Nextcloud-User", "admin")
      .send({ path: "/notes.txt", versionId: "1752800000" });

    expect(res.status).toBe(200);
    expect(ncGetFileId).toHaveBeenCalledWith("session-token", "romain", "/notes.txt");
    expect(ncRestoreVersion).toHaveBeenCalledWith("session-token", "romain", 42, "1752800000");
  });
});

describe("WARP-1456 — GET /files/versions (list_file_versions target, no role guard to flip)", () => {
  it("MCP + both NC headers → version list AS the asserted user", async () => {
    const res = await request(buildApp(MCP))
      .get(`/api/files/versions?path=${encodeURIComponent("/notes.txt")}`)
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "alice");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      fileId: 42,
      versions: [{ versionId: "1752800000", size: 1024, modifiedAt: "2026-07-18T01:33:20.000Z" }],
    });
    expect(ncGetFileId).toHaveBeenCalledWith("nct-user-cred", "alice", "/notes.txt");
    expect(ncListVersions).toHaveBeenCalledWith("nct-user-cred", "alice", 42);
  });

  it("MCP without the token header → 401 fail-closed", async () => {
    const res = await request(buildApp(MCP))
      .get(`/api/files/versions?path=${encodeURIComponent("/notes.txt")}`)
      .set("X-Nextcloud-User", "alice");

    expect(res.status).toBe(401);
    expect(ncListVersions).not.toHaveBeenCalled();
  });
});
