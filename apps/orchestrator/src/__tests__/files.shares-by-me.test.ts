/**
 * WARP-941 — GET /api/files/shares-by-me (outbound shares listing)
 *
 * The dashboard's Shared page has a "Shared by me" tab that was shipped as a
 * hardcoded placeholder because no reverse-share endpoint existed: the
 * orchestrator could list what the user RECEIVED (/files/shared-with-me) but
 * not what they CREATED. This route is the outbound sibling — it calls
 * `ncListOutboundShares` (OCS shares query WITHOUT a path filter) with the
 * caller's own Nextcloud credential, so Nextcloud scopes the listing to
 * shares that user owns.
 *
 * Covered:
 *   1. 200 + `{ shares }` passthrough of the mapped outbound shares
 *   2. the caller's resolved NC token is what reaches the client fn
 *   3. no NC session → 401 (same MissingNcTokenError contract as siblings)
 *   4. Nextcloud outage → 200 `{ shares: [] }` (same degrade contract as
 *      /files/shared-with-me — the Shared page must not dead-end on a 500)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// Guard with realistic semantics — the real implementation has its own
// coverage (rbac.test.ts); the shares-by-me route itself is session-gated
// via the NC token (like /files/shared-with-me), not role-gated.
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
      const role = (req as Request & { user?: { role?: string } }).user?.role;
      if (!role || !roles.includes(role)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      next();
    },
}));

// Files routes touch these — pass-throughs so nothing else interferes.
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("../config.js", () => ({
  config: { MAX_UPLOAD_SIZE_MB: 10, NODE_ENV: "test" },
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("nc-session-token"),
}));
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
  };
});

import { createFilesRouter } from "../routes/files.js";
import { ncListOutboundShares } from "../services/nextcloud.client.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";

const ncListOutboundSharesMock = vi.mocked(ncListOutboundShares);
const resolveNcTokenMock = vi.mocked(resolveNcToken);

interface FakeUser {
  id: string;
  username: string;
  role: "owner" | "admin" | "family" | "guest";
}

function buildApp(asUser: FakeUser | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (asUser) (req as unknown as { user?: FakeUser }).user = asUser;
    next();
  });
  const prismaStub = {
    fileCitation: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  app.use("/api", createFilesRouter(prismaStub as never));
  return app;
}

const FAMILY: FakeUser = { id: "uuid-caller", username: "stef-local", role: "family" };

const OUTBOUND = [
  {
    id: 21,
    url: null,
    token: null,
    shareType: 0,
    permissions: 1,
    path: "/Photos/trip.jpg",
    expireDate: null,
    hasPassword: false,
    note: null,
    shareWith: "romain",
    shareWithDisplayName: "Romain",
    uidOwner: "stefan",
    ownerDisplayName: "Stefan",
    stime: 1712860391,
  },
  {
    id: 22,
    url: "http://nextcloud.test/s/abc",
    token: "abc",
    shareType: 3,
    permissions: 1,
    path: "/report.pdf",
    expireDate: "2026-12-31",
    hasPassword: true,
    note: null,
    shareWith: null,
    shareWithDisplayName: null,
    uidOwner: "stefan",
    ownerDisplayName: "Stefan",
    stime: 1712860400,
  },
];

describe("WARP-941 — GET /api/files/shares-by-me", () => {
  beforeEach(() => {
    ncListOutboundSharesMock.mockReset();
    resolveNcTokenMock.mockReset();
    resolveNcTokenMock.mockResolvedValue("nc-session-token");
  });

  it("returns 200 + the caller's outbound shares (person + link)", async () => {
    ncListOutboundSharesMock.mockResolvedValue(OUTBOUND as never);

    const res = await request(buildApp(FAMILY)).get("/api/files/shares-by-me");

    expect(res.status).toBe(200);
    expect(res.body.shares).toHaveLength(2);
    expect(res.body.shares[0]).toMatchObject({
      id: 21,
      shareType: 0,
      shareWith: "romain",
      shareWithDisplayName: "Romain",
      path: "/Photos/trip.jpg",
    });
    expect(res.body.shares[1]).toMatchObject({ id: 22, shareType: 3 });
  });

  it("threads the caller's resolved Nextcloud token to the client", async () => {
    ncListOutboundSharesMock.mockResolvedValue([]);

    await request(buildApp(FAMILY)).get("/api/files/shares-by-me");

    expect(ncListOutboundSharesMock).toHaveBeenCalledTimes(1);
    expect(ncListOutboundSharesMock).toHaveBeenCalledWith("nc-session-token");
  });

  it("401s when the caller has no Nextcloud session (MissingNcTokenError contract)", async () => {
    resolveNcTokenMock.mockResolvedValue(null);

    const res = await request(buildApp(FAMILY)).get("/api/files/shares-by-me");

    expect(res.status).toBe(401);
    expect(ncListOutboundSharesMock).not.toHaveBeenCalled();
  });

  it("degrades to 200 { shares: [] } when Nextcloud is unreachable (no 500 on the Shared page)", async () => {
    // Same message shape the client throws on a 5xx (mirrors shared-with-me).
    ncListOutboundSharesMock.mockRejectedValue(
      new Error("OCS list outbound shares failed: 503"),
    );

    const res = await request(buildApp(FAMILY)).get("/api/files/shares-by-me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ shares: [] });
  });
});
