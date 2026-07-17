/**
 * WARP-582 — files routes must NEVER fall back to the Nextcloud `admin`
 * account. A request that reaches a handler without an authenticated
 * username (misordered router, future auth regression, a malformed
 * principal) must be refused with 401 — not run as anyone, and not surface
 * as a 500 invariant crash.
 *
 * Historical context: getUser(req) was `req.user?.username || "admin"`, so a
 * missing user silently ran every file op as the NC admin (the ORCH-007
 * fail-open). #944 made it throw a generic Error (→ 500 via the express
 * error handler); this pins the thrown shape to a 401 MissingAuthUserError.
 *
 * Layering note: the space-guarded routes (GET/DELETE /files, mkdir, upload)
 * already 403 a fully-anonymous request in requireSpaceAccess before the
 * handler runs — so the anonymous cases below use unguarded routes
 * (recents/download), and the space-guarded route is exercised with a
 * present-but-username-less principal (which passes the guard's id+role
 * check and must still die in getUser, fail-closed).
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
  };
});

const mockResolveNcToken = vi.fn();
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: (...a: unknown[]) => mockResolveNcToken(...a),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    MAX_UPLOAD_SIZE_MB: 10,
    NODE_ENV: "test",
  },
}));

// Pass-through role guards: this suite exercises the getUser identity
// invariant, not RBAC (files.mcp-service.test.ts covers guard selection).
// recordAccessDenied is exported for middleware/space.ts, which imports it
// from the same (mocked) module.
vi.mock("../middleware/auth.js", () => ({
  recordAccessDenied: vi.fn(),
  requireRole:
    () =>
    (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
  requireRoleOrMcpService:
    () =>
    (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));

import { createFilesRouter } from "../routes/files.js";
import * as nc from "../services/nextcloud.client.js";

const ncListFiles = nc.ncListFiles as unknown as ReturnType<typeof vi.fn>;
const ncListRecents = nc.ncListRecents as unknown as ReturnType<typeof vi.fn>;
const ncDownloadFile = nc.ncDownloadFile as unknown as ReturnType<typeof vi.fn>;

/** App whose auth layer populated req.user with `user` — or nothing at all. */
function buildApp(user?: { id: string; username?: string; role: string }) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      (req as unknown as { user?: typeof user }).user = user;
      next();
    });
  }
  const prismaStub = { fileCitation: { findMany: vi.fn().mockResolvedValue([]) } };
  app.use("/api", createFilesRouter(prismaStub as never));
  return app;
}

beforeEach(() => {
  ncListFiles.mockReset().mockResolvedValue([{ name: "a.txt" }]);
  ncListRecents.mockReset().mockResolvedValue([]);
  ncDownloadFile.mockReset().mockResolvedValue(null);
  mockResolveNcToken.mockReset().mockResolvedValue("session-token");
});

describe("WARP-582 — files routes refuse a missing authenticated user (401, never admin)", () => {
  it("anonymous GET /api/files/recents → 401, never lists as admin (and never 500s)", async () => {
    const res = await request(buildApp()).get("/api/files/recents");
    expect(res.status).toBe(401);
    expect(ncListRecents).not.toHaveBeenCalled();
  });

  it("anonymous GET /api/files/download → 401, never downloads as admin", async () => {
    const res = await request(buildApp()).get("/api/files/download?path=/secret.pdf");
    expect(res.status).toBe(401);
    expect(ncDownloadFile).not.toHaveBeenCalled();
  });

  it("a principal WITHOUT a username on GET /api/files → 401 (no admin fallback), never 500", async () => {
    const res = await request(
      buildApp({ id: "u-broken", role: "family" }),
    ).get("/api/files?path=/");
    expect(res.status).toBe(401);
    expect(ncListFiles).not.toHaveBeenCalled();
  });

  it("control: a complete principal still lists their OWN files", async () => {
    const res = await request(
      buildApp({ id: "u-1", username: "alice", role: "family" }),
    ).get("/api/files?path=/");
    expect(res.status).toBe(200);
    expect(ncListFiles).toHaveBeenCalledWith("session-token", "alice", "/");
  });
});
