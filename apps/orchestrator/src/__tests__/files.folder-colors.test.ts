/**
 * Files — per-user folder colours (GET/PUT/DELETE /files/folder-colors).
 *
 * The prisma mock honors `userId` + `ncFileId` filtering the way Postgres
 * would: the whole point of the table is that a colour is PERSONAL, so the
 * cross-user cases must distinguish "my rows" from "everyone's rows".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, MAX_UPLOAD_SIZE_MB: 100, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("ncTokenStub"),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));

const PATH_TO_FILEID: Record<string, number> = {
  "/Photos": 101,
  "/Photos/Trips": 102,
};
vi.mock("../services/nextcloud.client.js", () => ({
  ncGetFileId: vi.fn(
    async (_t: string, _u: string, p: string): Promise<number | null> => PATH_TO_FILEID[p] ?? null,
  ),
  ncListFiles: vi.fn(),
  ncUploadFile: vi.fn(),
  ncDownloadFile: vi.fn(),
  ncDeleteFile: vi.fn(),
  ncCreateDirectory: vi.fn(),
  ncListShares: vi.fn(),
  ncMoveFile: vi.fn(),
  ncCopyFile: vi.fn(),
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
  NextcloudOcsError: class NextcloudOcsError extends Error {
    ocsStatus = 400;
  },
}));

import { createFilesRouter } from "../routes/files.js";
import type { AuthUser } from "../middleware/auth.js";

interface ColorRow {
  userId: string;
  ncFileId: number;
  color: string;
}

function createPrismaMock() {
  const rows: ColorRow[] = [];
  const matches = (r: ColorRow, where: Partial<ColorRow>) =>
    Object.entries(where).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v);
  return {
    _rows: rows,
    fileFolderColor: {
      findMany: vi.fn(async ({ where }: { where: Partial<ColorRow> }) =>
        rows
          .filter((r) => matches(r, where))
          .map(({ ncFileId, color }) => ({ ncFileId, color })),
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId_ncFileId: { userId: string; ncFileId: number } };
          create: ColorRow;
          update: { color: string };
        }) => {
          const existing = rows.find((r) => matches(r, where.userId_ncFileId));
          if (existing) {
            existing.color = update.color;
            return { ncFileId: existing.ncFileId, color: existing.color };
          }
          rows.push({ ...create });
          return { ncFileId: create.ncFileId, color: create.color };
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: Partial<ColorRow> }) => {
        let count = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (matches(rows[i], where)) {
            rows.splice(i, 1);
            count++;
          }
        }
        return { count };
      }),
    },
    // Metadata department gate: nothing here is registered to a department.
    file: { findUnique: vi.fn().mockResolvedValue(null) },
    department: { findUnique: vi.fn().mockResolvedValue(null) },
  };
}

const mkUser = (role: AuthUser["role"], id: string): AuthUser => ({
  id,
  username: id,
  displayName: id,
  role,
});

function buildApp(prisma: ReturnType<typeof createPrismaMock>, user: AuthUser | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createFilesRouter(prisma as any));
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe("folder colours", () => {
  it("PUT then GET round-trips a colour keyed on ncFileId", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family", "u-fam"));
    const put = await request(app)
      .put("/api/files/folder-colors")
      .send({ path: "/Photos", color: "red" });
    expect(put.status).toBe(200);
    expect(put.body.color).toEqual({ ncFileId: 101, color: "red" });

    const get = await request(app).get("/api/files/folder-colors");
    expect(get.status).toBe(200);
    expect(get.body.colors).toEqual([{ ncFileId: 101, color: "red" }]);
  });

  it("re-colouring the same folder updates in place (one row)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("owner", "u-own"));
    await request(app).put("/api/files/folder-colors").send({ path: "/Photos", color: "red" });
    await request(app).put("/api/files/folder-colors").send({ path: "/Photos", color: "blue" });
    expect(prisma._rows).toEqual([{ userId: "u-own", ncFileId: 101, color: "blue" }]);
  });

  it("colours are personal: another user sees none and cannot clear mine", async () => {
    const prisma = createPrismaMock();
    await request(buildApp(prisma, mkUser("family", "u-a")))
      .put("/api/files/folder-colors")
      .send({ path: "/Photos", color: "green" });

    const bApp = buildApp(prisma, mkUser("family", "u-b"));
    const get = await request(bApp).get("/api/files/folder-colors");
    expect(get.body.colors).toEqual([]);

    const del = await request(bApp).delete("/api/files/folder-colors").query({ path: "/Photos" });
    expect(del.status).toBe(204);
    expect(prisma._rows).toHaveLength(1);
    expect(prisma._rows[0].userId).toBe("u-a");
  });

  it("guests may colour folders they can see", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("guest", "u-guest"));
    const put = await request(app)
      .put("/api/files/folder-colors")
      .send({ path: "/Photos/Trips", color: "purple" });
    expect(put.status).toBe(200);
    expect(prisma._rows).toEqual([{ userId: "u-guest", ncFileId: 102, color: "purple" }]);
  });

  it("DELETE clears the caller's colour", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family", "u-fam"));
    await request(app).put("/api/files/folder-colors").send({ path: "/Photos", color: "red" });
    const del = await request(app).delete("/api/files/folder-colors").query({ path: "/Photos" });
    expect(del.status).toBe(204);
    expect(prisma._rows).toEqual([]);
  });

  it("rejects a colour outside the palette (including 'none') with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family", "u-fam"));
    for (const color of ["magenta", "none", ""]) {
      const res = await request(app).put("/api/files/folder-colors").send({ path: "/Photos", color });
      expect(res.status).toBe(400);
    }
    expect(prisma.fileFolderColor.upsert).not.toHaveBeenCalled();
  });

  it("404s an unknown folder and 400s a missing / root path", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family", "u-fam"));
    const missing = await request(app)
      .put("/api/files/folder-colors")
      .send({ path: "/Nope", color: "red" });
    expect(missing.status).toBe(404);
    const root = await request(app).delete("/api/files/folder-colors").query({ path: "/" });
    expect(root.status).toBe(400);
    const none = await request(app).delete("/api/files/folder-colors");
    expect(none.status).toBe(400);
    expect(prisma.fileFolderColor.upsert).not.toHaveBeenCalled();
  });

  it("rejects a path traversal", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family", "u-fam"));
    const res = await request(app)
      .put("/api/files/folder-colors")
      .send({ path: "/Photos/../Secret", color: "red" });
    expect(res.status).toBe(400);
  });

  it("refuses the mcp service principal (no per-user palette)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { id: "_service:mcp", username: "mcp", displayName: "mcp", role: "service" } as AuthUser);
    const res = await request(app).get("/api/files/folder-colors");
    expect(res.status).toBe(403);
    expect(prisma.fileFolderColor.findMany).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, null)).get("/api/files/folder-colors");
    expect(res.status).toBe(403);
    expect(prisma.fileFolderColor.findMany).not.toHaveBeenCalled();
  });
});
