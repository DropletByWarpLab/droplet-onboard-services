/**
 * WARP-1460 — MCP-principal admission + JSON body on POST /api/files/upload.
 *
 * The shipped `write_file` and new `create_document` LLM tools POST a JSON
 * body `{dir, filename, contentBase64}` to /api/files/upload (via the
 * nextcloud HttpClient), not a multipart form. Before this fix the route
 * (a) 403'd the `_service:mcp` principal (plain requireRole) and (b) was
 * multipart-only (multer + `req.files`), so a JSON body 400'd "No files
 * provided" — both tools were dead on the HTTP path.
 *
 * These tests pin the fix: requireRoleOrMcpService admits the service
 * principal (family stays admitted, guest stays denied); the WARP-861
 * NC-identity idiom holds (X-Nextcloud-*; missing either → 401, no admin
 * fallback); the JSON branch decodes base64, enforces the 10 MB cap, and
 * rejects filenames with path separators / traversal; and the human
 * MULTIPART path is unchanged (comprehensive multipart coverage already
 * lives in files.test.ts — this file keeps ONE multipart smoke test to
 * prove the shared-loop refactor didn't regress the multipart transport).
 *
 * Scaffolding per files-share-versions-mcp-guards.test.ts: REAL auth +
 * space guards, a req.user shim, mocked NC client + file-registry so
 * per-call identity and the decoded bytes are assertable.
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

// The upload route best-effort upserts a file-registry row after each write.
vi.mock("../services/file-registry.service.js", () => ({
  resolveFileDepartment: vi.fn().mockResolvedValue(null),
  upsertFileRegistryEntry: vi.fn().mockResolvedValue(undefined),
}));

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
import * as registry from "../services/file-registry.service.js";

const ncUploadFile = nc.ncUploadFile as unknown as ReturnType<typeof vi.fn>;
const ncGetFileId = nc.ncGetFileId as unknown as ReturnType<typeof vi.fn>;
const upsertFileRegistryEntry =
  registry.upsertFileRegistryEntry as unknown as ReturnType<typeof vi.fn>;

function buildApp(asUser: { id: string; username: string; role: string }) {
  const app = express();
  // A JSON write_file/create_document body can be up to ~13.3 MB (10 MB
  // base64-encoded), so raise the parser ceiling above express's 100kb
  // default — otherwise the oversized-body test never reaches the handler.
  app.use(express.json({ limit: "32mb" }));
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
    userUsagePolicy: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  app.use("/api", createFilesRouter(prismaStub as never));
  return app;
}

const MCP = { id: "_service:mcp", username: "_service:mcp", role: "service" };
const OWNER = { id: "u-owner", username: "dev", role: "owner" };
const FAMILY = { id: "u-1", username: "romain", role: "family" };
const GUEST = { id: "u-2", username: "visitor", role: "guest" };

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

beforeEach(() => {
  ncUploadFile.mockReset().mockResolvedValue(undefined);
  ncGetFileId.mockReset().mockResolvedValue(42);
  upsertFileRegistryEntry.mockReset().mockResolvedValue(undefined);
  mockResolveNcToken.mockReset().mockResolvedValue("session-token");
});

describe("WARP-1460 — POST /files/upload admits the MCP service principal (JSON body)", () => {
  it("MCP + both NC headers + JSON → 200, upload AS the asserted user with decoded bytes", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/upload")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "alice")
      .send({ dir: "/Docs", filename: "note.txt", contentBase64: b64("hello world") });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      uploaded: [{ name: "note.txt", path: "/Docs/note.txt", size: 11 }],
    });
    // Forwarded user + credential, target dir from the body `dir` field,
    // and the exact decoded bytes.
    expect(ncUploadFile).toHaveBeenCalledWith(
      "nct-user-cred",
      "alice",
      "/Docs",
      "note.txt",
      Buffer.from("hello world", "utf8"),
    );
    // The session resolver is never consulted for the service path.
    expect(mockResolveNcToken).not.toHaveBeenCalled();
  });

  it("MCP JSON with default dir (omitted) writes at root", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/upload")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "alice")
      .send({ filename: "root.txt", contentBase64: b64("x") });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uploaded: [{ name: "root.txt", path: "/root.txt", size: 1 }] });
    expect(ncUploadFile).toHaveBeenCalledWith(
      "nct-user-cred",
      "alice",
      "/",
      "root.txt",
      expect.any(Buffer),
    );
  });

  it("MCP without the token header → 401 fail-closed, no upload", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/upload")
      .set("X-Nextcloud-User", "alice")
      .send({ dir: "/", filename: "note.txt", contentBase64: b64("hi") });

    expect(res.status).toBe(401);
    expect(ncUploadFile).not.toHaveBeenCalled();
  });

  it("MCP without the user header → 401 fail-closed (no admin fallback), no upload", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/upload")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .send({ dir: "/", filename: "note.txt", contentBase64: b64("hi") });

    expect(res.status).toBe(401);
    expect(ncUploadFile).not.toHaveBeenCalled();
  });

  it("JSON body over the 10 MB cap → 413, no upload", async () => {
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64");
    const res = await request(buildApp(MCP))
      .post("/api/files/upload")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "alice")
      .send({ dir: "/", filename: "big.bin", contentBase64: oversized });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
    expect(ncUploadFile).not.toHaveBeenCalled();
  });

  it.each(["a/b.txt", "..", "../evil.txt", "a\\b.txt", "."])(
    "filename %j (path separator / traversal) → 400, no upload",
    async (filename) => {
      const res = await request(buildApp(MCP))
        .post("/api/files/upload")
        .set("X-Nextcloud-Token", "nct-user-cred")
        .set("X-Nextcloud-User", "alice")
        .send({ dir: "/", filename, contentBase64: b64("x") });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/basename/i);
      expect(ncUploadFile).not.toHaveBeenCalled();
    },
  );

  it("invalid base64 → 400, no upload", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/upload")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "alice")
      .send({ dir: "/", filename: "x.bin", contentBase64: "@@@@" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/base64/i);
    expect(ncUploadFile).not.toHaveBeenCalled();
  });

  it("JSON body with neither files nor contentBase64 → 400 'No files provided'", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/upload")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "alice")
      .send({ dir: "/" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("No files provided");
    expect(ncUploadFile).not.toHaveBeenCalled();
  });

  it("human RBAC unchanged: guest still denied 403, no upload", async () => {
    const res = await request(buildApp(GUEST))
      .post("/api/files/upload")
      .send({ dir: "/", filename: "note.txt", contentBase64: b64("hi") });

    expect(res.status).toBe(403);
    expect(ncUploadFile).not.toHaveBeenCalled();
  });

  it("human family JSON upload works on the SESSION credential (headers ignored)", async () => {
    const res = await request(buildApp(FAMILY))
      .post("/api/files/upload")
      .set("X-Nextcloud-Token", "attacker-token")
      .set("X-Nextcloud-User", "admin")
      .send({ dir: "/", filename: "note.txt", contentBase64: b64("hi") });

    expect(res.status).toBe(200);
    expect(ncUploadFile).toHaveBeenCalledWith(
      "session-token",
      "romain",
      "/",
      "note.txt",
      expect.any(Buffer),
    );
  });
});

describe("WARP-1460 — the human MULTIPART path is unchanged", () => {
  // Full multipart coverage (multi-file, per-user size caps, MQTT publish)
  // lives in files.test.ts "POST /api/files/upload". This single smoke test
  // proves the shared-loop refactor did not regress the multipart transport.
  it("owner multipart upload → 200 with the existing { uploaded: [...] } shape", async () => {
    const res = await request(buildApp(OWNER))
      .post("/api/files/upload?path=/")
      .attach("files", Buffer.from("hello"), "hello.txt");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      uploaded: [{ name: "hello.txt", path: "/hello.txt", size: 5 }],
    });
    expect(ncUploadFile).toHaveBeenCalledWith(
      "session-token",
      "dev",
      "/",
      "hello.txt",
      expect.any(Buffer),
    );
  });
});
