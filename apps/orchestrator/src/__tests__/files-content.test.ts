/**
 * `GET /api/files/:id/content` — inline content for the dashboard citation
 * viewers (`PdfCitation.tsx`, `MediaCitation.tsx`). Both build
 * `/api/files/${encodeURIComponent(hit.fileId)}/content`, and `hit.fileId` is
 * polymorphic: a numeric Nextcloud file id, a "/"-prefixed path, or a
 * brain-memory item id (see `SearchTab.tsx` / `ChatMessage.tsx`).
 *
 * Coverage: 200 full body, 206 partial (Range forwarded to WebDAV / served
 * locally), 416 unsatisfiable, 404 missing, plus the cross-user ownership and
 * path-traversal refusals on the brain branch.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../services/nextcloud.client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/nextcloud.client.js")>();
  return { ...actual, ncFetchFileResponse: vi.fn() };
});

const mockIsPathUnderUser = vi.fn();
vi.mock("../services/brain-memory.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/brain-memory.service.js")>();
  return {
    ...actual,
    isPathUnderUser: (...a: unknown[]) => mockIsPathUnderUser(...a),
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

vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));

vi.mock("../config.js", () => ({
  config: {
    MAX_UPLOAD_SIZE_MB: 10,
    NODE_ENV: "test",
    NEXTCLOUD_URL: "http://nextcloud.test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// Pass-through role guards — this suite exercises the content route's own
// identity/ownership logic, not RBAC.
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

const ncFetchFileResponse = nc.ncFetchFileResponse as unknown as ReturnType<
  typeof vi.fn
>;

const tmpRoot = mkdtempSync(join(tmpdir(), "files-content-"));
const LOCAL_BYTES = "0123456789";
const localFile = join(tmpRoot, "clip.mp4");
writeFileSync(localFile, LOCAL_BYTES);

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const brainFindUnique = vi.fn();
const chunkFindFirst = vi.fn();

function buildApp(
  user: { id: string; username: string; role: string } = {
    id: "u-alice",
    username: "alice",
    role: "family",
  },
) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof user }).user = user;
    next();
  });
  const prismaStub = {
    brainMemoryItem: { findUnique: brainFindUnique },
    fileContentChunk: { findFirst: chunkFindFirst },
    fileCitation: { findMany: vi.fn().mockResolvedValue([]) },
  };
  app.use("/api", createFilesRouter(prismaStub as never));
  return app;
}

beforeEach(() => {
  ncFetchFileResponse.mockReset();
  brainFindUnique.mockReset();
  chunkFindFirst.mockReset();
  mockIsPathUnderUser.mockReset().mockReturnValue(true);
  mockResolveNcToken.mockReset().mockResolvedValue("session-token");
});

describe("GET /api/files/:id/content — Nextcloud-backed ids", () => {
  it("serves a path id inline with 200 and a typed body", async () => {
    ncFetchFileResponse.mockResolvedValue(
      new Response("%PDF-1.7 body", { status: 200 }),
    );

    const res = await request(buildApp()).get(
      `/api/files/${encodeURIComponent("/docs/report.pdf")}/content`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(ncFetchFileResponse).toHaveBeenCalledWith(
      "session-token",
      "alice",
      "/docs/report.pdf",
      undefined,
    );
  });

  it("resolves a numeric id through the content index", async () => {
    chunkFindFirst.mockResolvedValue({ path: "/media/talk.mp4" });
    ncFetchFileResponse.mockResolvedValue(new Response("bytes", { status: 200 }));

    const res = await request(buildApp()).get("/api/files/4242/content");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(chunkFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ncFileId: 4242 } }),
    );
  });

  it("forwards Range to WebDAV and relays its 206 + Content-Range", async () => {
    ncFetchFileResponse.mockResolvedValue(
      new Response("34", {
        status: 206,
        headers: { "content-range": "bytes 3-4/10", "content-length": "2" },
      }),
    );

    const res = await request(buildApp())
      .get(`/api/files/${encodeURIComponent("/media/talk.mp4")}/content`)
      .set("Range", "bytes=3-4");

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 3-4/10");
    expect(ncFetchFileResponse).toHaveBeenCalledWith(
      "session-token",
      "alice",
      "/media/talk.mp4",
      "bytes=3-4",
    );
  });

  it("404s when the file is gone upstream", async () => {
    ncFetchFileResponse.mockResolvedValue(null);

    const res = await request(buildApp()).get(
      `/api/files/${encodeURIComponent("/docs/missing.pdf")}/content`,
    );

    expect(res.status).toBe(404);
  });

  it("404s when a numeric id resolves to no indexed path", async () => {
    chunkFindFirst.mockResolvedValue(null);

    const res = await request(buildApp()).get("/api/files/999/content");

    expect(res.status).toBe(404);
    expect(ncFetchFileResponse).not.toHaveBeenCalled();
  });
});

describe("GET /api/files/:id/content — brain-memory ids", () => {
  const item = {
    id: "itm-1",
    userId: "u-alice",
    filename: "clip.mp4",
    mimeType: "video/mp4",
    storagePath: localFile,
  };

  it("serves the local original with 200 and Accept-Ranges", async () => {
    brainFindUnique.mockResolvedValue(item);

    const res = await request(buildApp()).get("/api/files/itm-1/content");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe(String(LOCAL_BYTES.length));
    expect(ncFetchFileResponse).not.toHaveBeenCalled();
  });

  it("serves 206 for a satisfiable Range", async () => {
    brainFindUnique.mockResolvedValue(item);

    const res = await request(buildApp())
      .get("/api/files/itm-1/content")
      .set("Range", "bytes=2-4");

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 2-4/10");
    expect(res.headers["content-length"]).toBe("3");
  });

  it("416s an unsatisfiable Range with a Content-Range size hint", async () => {
    brainFindUnique.mockResolvedValue(item);

    const res = await request(buildApp())
      .get("/api/files/itm-1/content")
      .set("Range", "bytes=5000-6000");

    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */10");
  });

  it("404s another user's item (no existence leak)", async () => {
    brainFindUnique.mockResolvedValue({ ...item, userId: "u-bob" });

    const res = await request(buildApp()).get("/api/files/itm-1/content");

    expect(res.status).toBe(404);
  });

  it("404s when storagePath escapes the user's tree", async () => {
    brainFindUnique.mockResolvedValue({
      ...item,
      storagePath: join(tmpRoot, "..", "etc", "passwd"),
    });
    mockIsPathUnderUser.mockReturnValue(false);

    const res = await request(buildApp()).get("/api/files/itm-1/content");

    expect(res.status).toBe(404);
  });

  it("401s an unauthenticated caller", async () => {
    const app = express();
    const prismaStub = {
      brainMemoryItem: { findUnique: brainFindUnique },
      fileContentChunk: { findFirst: chunkFindFirst },
      fileCitation: { findMany: vi.fn().mockResolvedValue([]) },
    };
    app.use("/api", createFilesRouter(prismaStub as never));

    const res = await request(app).get("/api/files/itm-1/content");

    expect(res.status).toBe(401);
    expect(brainFindUnique).not.toHaveBeenCalled();
  });
});
