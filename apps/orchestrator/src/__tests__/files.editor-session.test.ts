/**
 * WARP-882 / WS-4 — editor-session + docs/status routes.
 *
 * Pins the route-layer contract:
 *   - GET /api/files/:path/editor-session decides edit-vs-view SERVER-SIDE
 *     (owner → edit; shared-with-me + NC update bit → edit; else view) and
 *     never trusts a client-sent mode.
 *   - Error mapping: missing NC token → 401, DocServerUnavailableError → 503.
 *   - GET /api/files/docs/status → { state, engine }.
 *
 * The doc-server client + Nextcloud client are mocked; nothing dials a real
 * Document Server. Auth is disabled (AUTH_ENABLED=false) so the synthesized dev
 * owner reaches the handler — the RBAC guard itself is covered by rbac.test.ts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    MAX_UPLOAD_SIZE_MB: 10,
    NEXTCLOUD_URL: "http://nextcloud.test",
    AUTH_ENABLED: false,
    // departments.ts (registered by createApp) derefs this at module scope to
    // build RESERVED_NAMES; the real config zod-defaults it, so the mock must
    // carry it too or module load throws on undefined.toLowerCase(). (WARP-1292)
    DROPLET_SHARED_FOLDER_NAME: "Household",
    FRIGATE_URL: "http://frigate:5000",
    DOCS_INTERNAL_URL: "http://docserver.test",
    DOCS_ENABLED: true,
    // WARP-1686: the status route surfaces the CONFIGURED engine verbatim.
    DOCS_ENGINE: "collabora",
    NEXTCLOUD_PUBLIC_PATH: "/nextcloud",
    DOCS_EDITOR_PUBLIC_PATH: "/docs/",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js",
  );
  return {
    NextcloudOcsError: actual.NextcloudOcsError,
    ncListFiles: vi.fn().mockResolvedValue([]),
    ncUploadFile: vi.fn(),
    ncDownloadFile: vi.fn(),
    ncDeleteFile: vi.fn(),
    ncCreateDirectory: vi.fn(),
    ncCreateShare: vi.fn(),
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
    ncListSharedWithMe: vi.fn().mockResolvedValue([]),
    ncGetUserQuota: vi.fn(),
  };
});

// Mock the doc-server client so the route exercises only its decision logic +
// error mapping, never a real engine. We re-export the real error class so the
// route's `instanceof DocServerUnavailableError` check works.
vi.mock("../services/docserver.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/docserver.client.js")>(
    "../services/docserver.client.js",
  );
  return {
    DocServerUnavailableError: actual.DocServerUnavailableError,
    ncMintEditorSession: vi.fn(),
    docServerHealthy: vi.fn(),
  };
});

// Resolve the NC session token to a non-null value by default (dev user → has a
// token). Individual tests override to null to assert the 401 path.
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("nc-token"),
}));

import express from "express";
import { createApp } from "../app.js";
import { createFilesRouter } from "../routes/files.js";
import * as nc from "../services/nextcloud.client.js";
import * as docs from "../services/docserver.client.js";
import * as ncSession from "../services/nextcloud-session.service.js";
import { DocServerUnavailableError } from "../services/docserver.client.js";
import { initDeviceService } from "../services/device.service.js";

type AnyMock = ReturnType<typeof vi.fn>;
const ncMock = nc as unknown as Record<string, AnyMock>;
const docsMock = docs as unknown as Record<string, AnyMock>;
const ncSessionMock = ncSession as unknown as Record<string, AnyMock>;

describe("Editor session + docs status routes (WARP-882)", () => {
  let app: ReturnType<typeof createApp>;
  let prisma: PrismaClient;

  // This suite models a box where Documents is turned ON (config above sets
  // DOCS_ENABLED + DOCS_INTERNAL_URL, making the `docs` module available). The
  // module gate on `/api/files/docs` reads ModuleSetting overrides; the global
  // test mock returns no overrides, which would leave `docs` default-disabled
  // and 404 the status route. Seed an explicit enablement row so the gate lets
  // `/api/files/docs/status` through. Re-applied in beforeEach because
  // clearAllMocks() below wipes the resolved value (the gate re-reads on cache
  // expiry).
  const enableDocs = () =>
    (prisma as unknown as {
      moduleSetting: { findMany: ReturnType<typeof vi.fn> };
    }).moduleSetting.findMany.mockResolvedValue([{ moduleId: "docs", enabled: true }]);

  beforeAll(() => {
    prisma = new PrismaClient();
    enableDocs();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    enableDocs();
    ncMock.ncListSharedWithMe.mockResolvedValue([]);
    ncSessionMock.resolveNcToken.mockResolvedValue("nc-token");
    docsMock.docServerHealthy.mockResolvedValue(true);
    docsMock.ncMintEditorSession.mockImplementation(
      async (_t: string, _u: string, _p: string, mode: string) => ({
        editorUrl: "http://nextcloud.test/index.php/apps/onlyoffice/42?mode=" + mode,
        accessToken: "signed.jwt.token",
        accessTokenTtl: 1800,
        ncFileId: 42,
        mode,
        documentKey: "doc-key-abc",
      }),
    );
  });

  describe("GET /api/files/:path/editor-session — edit-vs-view decision", () => {
    it("returns mode=edit for a file the caller owns (not in shared-with-me)", async () => {
      ncMock.ncListSharedWithMe.mockResolvedValue([]);
      const res = await request(app).get(
        "/api/files/Documents/report.docx/editor-session",
      );
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe("edit");
      // The route must call the client with the SERVER-decided mode, not a
      // client-sent one.
      expect(docsMock.ncMintEditorSession).toHaveBeenCalledWith(
        "nc-token",
        expect.any(String),
        "/Documents/report.docx",
        "edit",
      );
    });

    it("returns mode=edit when the file is shared to the caller WITH the update bit (2)", async () => {
      ncMock.ncListSharedWithMe.mockResolvedValue([
        { path: "/shared.docx", permissions: 3 /* read(1)+update(2) */ },
      ]);
      const res = await request(app).get("/api/files/shared.docx/editor-session");
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe("edit");
    });

    it("returns mode=view when the file is shared READ-ONLY (no update bit)", async () => {
      ncMock.ncListSharedWithMe.mockResolvedValue([
        { path: "/shared.docx", permissions: 1 /* read only */ },
      ]);
      const res = await request(app).get("/api/files/shared.docx/editor-session");
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe("view");
      expect(docsMock.ncMintEditorSession).toHaveBeenCalledWith(
        "nc-token",
        expect.any(String),
        "/shared.docx",
        "view",
      );
    });

    it("IGNORES a client-sent ?mode=edit when the share is read-only (no trust)", async () => {
      ncMock.ncListSharedWithMe.mockResolvedValue([
        { path: "/shared.docx", permissions: 1 },
      ]);
      const res = await request(app).get(
        "/api/files/shared.docx/editor-session?mode=edit",
      );
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe("view");
    });

    it("maps a missing NC token to 401", async () => {
      ncSessionMock.resolveNcToken.mockResolvedValue(null);
      const res = await request(app).get("/api/files/x.docx/editor-session");
      expect(res.status).toBe(401);
    });

    it("maps DocServerUnavailableError to 503", async () => {
      docsMock.ncMintEditorSession.mockRejectedValue(
        new DocServerUnavailableError("docs down"),
      );
      const res = await request(app).get("/api/files/x.docx/editor-session");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("DOCS_UNAVAILABLE");
    });

    it("maps a not-found file to 404", async () => {
      docsMock.ncMintEditorSession.mockRejectedValue(new Error("File not found: /x.docx"));
      const res = await request(app).get("/api/files/x.docx/editor-session");
      expect(res.status).toBe(404);
    });
  });

  describe("FileEditSession persistence (mocked prisma)", () => {
    // Build a standalone files router with a hand-rolled prisma stub that
    // exposes fileEditSession.upsert, plus a synthetic owner so we can assert
    // the upsert payload directly (the global @prisma/client mock has no
    // fileEditSession model).
    function buildAppWithPrisma(upsert: ReturnType<typeof vi.fn>) {
      const prismaStub = {
        fileEditSession: { upsert },
        fileCitation: { findMany: vi.fn().mockResolvedValue([]) },
        chatSession: { findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as PrismaClient;
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        (req as express.Request & { user: unknown }).user = {
          id: "owner-1",
          username: "alice",
          displayName: "Alice",
          role: "owner",
        };
        next();
      });
      a.use("/api", createFilesRouter(prismaStub));
      return a;
    }

    it("upserts an OPEN FileEditSession keyed on ncFileId when a session is minted", async () => {
      const upsert = vi.fn().mockResolvedValue({});
      const a = buildAppWithPrisma(upsert);
      const res = await request(a).get("/api/files/Documents/report.docx/editor-session");
      expect(res.status).toBe(200);
      expect(upsert).toHaveBeenCalledTimes(1);
      const arg = upsert.mock.calls[0][0];
      expect(arg.where).toEqual({ ncFileId: 42 });
      expect(arg.create).toMatchObject({
        ncFileId: 42,
        mode: "edit",
        status: "open",
        documentKey: "doc-key-abc",
      });
      expect(arg.update).toMatchObject({ status: "open", mode: "edit" });
    });

    it("still returns 200 (editor opens) when the FileEditSession upsert fails", async () => {
      const upsert = vi.fn().mockRejectedValue(new Error("db down"));
      const a = buildAppWithPrisma(upsert);
      const res = await request(a).get("/api/files/Documents/report.docx/editor-session");
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe("edit");
    });
  });

  describe("GET /api/files/docs/status", () => {
    it("reports ready when the engine is healthy", async () => {
      docsMock.docServerHealthy.mockResolvedValue(true);
      const res = await request(app).get("/api/files/docs/status");
      expect(res.status).toBe(200);
      expect(res.body.state).toBe("ready");
      // WARP-1686: the engine string is the CONFIGURED engine, verbatim.
      expect(res.body.engine).toBe("collabora");
    });

    it("reports unavailable when the engine is not healthy", async () => {
      docsMock.docServerHealthy.mockResolvedValue(false);
      const res = await request(app).get("/api/files/docs/status");
      expect(res.status).toBe(200);
      expect(res.body.state).toBe("unavailable");
    });
  });
});
