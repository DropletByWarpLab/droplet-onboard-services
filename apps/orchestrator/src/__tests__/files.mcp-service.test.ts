/**
 * WARP-861 — the MCP file tools reach /api/files/* as the `_service:mcp`
 * principal carrying the per-user Nextcloud credential in headers:
 *   X-Nextcloud-Token / X-Nextcloud-User
 *
 * Covered:
 *   - service principal + both headers → NC client called AS that user
 *   - service principal missing either header → 401 (no admin fallback)
 *   - a regular user's spoofed headers are IGNORED (session wins)
 *   - the tool-reachable write route (mkdir) admits the service principal
 *     via requireRoleOrMcpService while plain requireRole routes don't
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

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
  };
});

// Session-cookie credential resolution for NON-service callers.
const mockResolveNcToken = vi.fn();
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: (...a: unknown[]) => mockResolveNcToken(...a),
}));

// Redis-backed list cache — pass-through misses so every request hits the
// (mocked) NC client and we can assert per-call identity.
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

vi.mock("../config.js", () => ({
  config: {
    MAX_UPLOAD_SIZE_MB: 10,
    NODE_ENV: "test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// Auth guards with realistic semantics (the real implementations have
// their own unit coverage; here we verify WHICH guard each route uses).
vi.mock("../middleware/auth.js", () => ({
  requireRole:
    (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as Request & { user?: { role?: string } }).user?.role;
      if (!role || !roles.includes(role)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      next();
    },
  requireRoleOrMcpService:
    (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const u = (req as Request & { user?: { id?: string; role?: string } }).user;
      if (u?.id === "_service:mcp" && u.role === "service") {
        next();
        return;
      }
      if (!u?.role || !roles.includes(u.role)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      next();
    },
}));

import { createFilesRouter } from "../routes/files.js";
import * as nc from "../services/nextcloud.client.js";

const ncListFiles = nc.ncListFiles as unknown as ReturnType<typeof vi.fn>;
const ncCreateDirectory = nc.ncCreateDirectory as unknown as ReturnType<typeof vi.fn>;

function buildApp(asUser: { id: string; username: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  const prismaStub = { fileCitation: { findMany: vi.fn().mockResolvedValue([]) } };
  app.use("/api", createFilesRouter(prismaStub as never));
  return app;
}

const MCP = { id: "_service:mcp", username: "_service:mcp", role: "service" };
const HUMAN = { id: "u-1", username: "romain", role: "family" };

beforeEach(() => {
  ncListFiles.mockReset().mockResolvedValue([{ name: "a.txt" }]);
  ncCreateDirectory.mockReset().mockResolvedValue(undefined);
  mockResolveNcToken.mockReset().mockResolvedValue("session-token");
});

describe("WARP-861 — files routes for the mcp service principal", () => {
  it("acts as the header-asserted user with the header token", async () => {
    const res = await request(buildApp(MCP))
      .get("/api/files?path=/photos")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "alice");
    expect(res.status).toBe(200);
    expect(ncListFiles).toHaveBeenCalledWith("nct-user-cred", "alice", "/photos");
    // The session resolver must not even be consulted for the service path.
    expect(mockResolveNcToken).not.toHaveBeenCalled();
  });

  it("401s when the service principal omits the user header (no admin fallback)", async () => {
    const res = await request(buildApp(MCP))
      .get("/api/files?path=/")
      .set("X-Nextcloud-Token", "nct-user-cred");
    expect(res.status).toBe(401);
    expect(ncListFiles).not.toHaveBeenCalled();
  });

  it("401s when the service principal omits the token header", async () => {
    const res = await request(buildApp(MCP))
      .get("/api/files?path=/")
      .set("X-Nextcloud-User", "alice");
    expect(res.status).toBe(401);
    expect(ncListFiles).not.toHaveBeenCalled();
  });

  it("ignores spoofed headers from a regular user — the session rules", async () => {
    const res = await request(buildApp(HUMAN))
      .get("/api/files?path=/")
      .set("X-Nextcloud-Token", "attacker-token")
      .set("X-Nextcloud-User", "admin");
    expect(res.status).toBe(200);
    expect(ncListFiles).toHaveBeenCalledWith("session-token", "romain", "/");
  });

  it("admits the service principal on the tool-reachable mkdir write route", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/mkdir")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "alice")
      .send({ path: "/new-folder" });
    expect(res.status).toBe(200);
    expect(ncCreateDirectory).toHaveBeenCalledWith(
      "nct-user-cred",
      "alice",
      "/new-folder",
    );
  });

  it("keeps plain requireRole routes closed to the service principal", async () => {
    // Empty-trash is NOT tool-reachable and stays human-only. (POST
    // /files/share moved off this pin when WARP-1456 made it a share_file
    // tool route — see files-share-versions-mcp-guards.test.ts.)
    const res = await request(buildApp(MCP))
      .delete("/api/files/trash")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "alice");
    expect(res.status).toBe(403);
  });
});
