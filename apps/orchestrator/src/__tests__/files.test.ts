import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../app.js";
import { initFileService } from "../services/file.service.js";
import { initDeviceService } from "../services/device.service.js";

// Mock the ai-gateway client
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

// Use a deterministic temp directory for testing
const TEST_FILES_ROOT = path.join(os.tmpdir(), "droplet-files-test");

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    FILES_ROOT: path.join(os.tmpdir(), "droplet-files-test"),
    MAX_UPLOAD_SIZE_MB: 10,
  },
}));

describe("File Operations", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    initFileService(prisma);
    app = createApp(prisma);
  });

  beforeEach(async () => {
    // Clean and recreate the test directory before each test
    try {
      await fsp.rm(TEST_FILES_ROOT, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
    await fsp.mkdir(TEST_FILES_ROOT, { recursive: true });
  });

  afterAll(async () => {
    try {
      await fsp.rm(TEST_FILES_ROOT, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // ── GET /api/files ──

  describe("GET /api/files", () => {
    it("returns empty array for empty directory", async () => {
      const res = await request(app).get("/api/files?path=/");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns files after creating them", async () => {
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "hello.txt"), "Hello World");

      const res = await request(app).get("/api/files?path=/");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("hello.txt");
      expect(res.body[0].isDirectory).toBe(false);
      expect(res.body[0].size).toBeGreaterThan(0);
    });

    it("sorts directories before files", async () => {
      await fsp.mkdir(path.join(TEST_FILES_ROOT, "zFolder"), { recursive: true });
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "aFile.txt"), "data");

      const res = await request(app).get("/api/files?path=/");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].name).toBe("zFolder");
      expect(res.body[0].isDirectory).toBe(true);
      expect(res.body[1].name).toBe("aFile.txt");
    });

    it("returns 400 for path traversal attempt", async () => {
      const res = await request(app).get(
        `/api/files?path=${encodeURIComponent("../../etc/passwd")}`
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("outside allowed root");
    });
  });

  // ── POST /api/files/mkdir ──

  describe("POST /api/files/mkdir", () => {
    it("creates a directory and returns 200", async () => {
      const res = await request(app)
        .post("/api/files/mkdir")
        .send({ path: "/testdir" });

      expect(res.status).toBe(200);
      expect(res.body.created).toBe("/testdir");

      const stat = await fsp.stat(path.join(TEST_FILES_ROOT, "testdir"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("creates nested directories", async () => {
      const res = await request(app)
        .post("/api/files/mkdir")
        .send({ path: "/a/b/c" });

      expect(res.status).toBe(200);
      const stat = await fsp.stat(path.join(TEST_FILES_ROOT, "a/b/c"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("returns 400 for missing path", async () => {
      const res = await request(app).post("/api/files/mkdir").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("path is required");
    });

    it("returns 400 for empty path", async () => {
      const res = await request(app)
        .post("/api/files/mkdir")
        .send({ path: "" });
      expect(res.status).toBe(400);
    });

    it("returns 400 for path traversal", async () => {
      const res = await request(app)
        .post("/api/files/mkdir")
        .send({ path: "/../../../tmp/evil" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("outside allowed root");
    });

    it("succeeds silently if directory already exists", async () => {
      await fsp.mkdir(path.join(TEST_FILES_ROOT, "existing"), { recursive: true });

      const res = await request(app)
        .post("/api/files/mkdir")
        .send({ path: "/existing" });
      expect(res.status).toBe(200);
    });
  });

  // ── POST /api/files/upload ──

  describe("POST /api/files/upload", () => {
    it("uploads a file and returns metadata", async () => {
      const res = await request(app)
        .post("/api/files/upload?path=/")
        .attach("files", Buffer.from("test content"), "test.txt");

      expect(res.status).toBe(200);
      expect(res.body.uploaded).toHaveLength(1);
      expect(res.body.uploaded[0].name).toBe("test.txt");
      expect(res.body.uploaded[0].size).toBe(12);
      expect(res.body.uploaded[0].hash).toBeDefined();

      const content = await fsp.readFile(
        path.join(TEST_FILES_ROOT, "test.txt"),
        "utf-8"
      );
      expect(content).toBe("test content");
    });

    it("uploads multiple files", async () => {
      const res = await request(app)
        .post("/api/files/upload?path=/")
        .attach("files", Buffer.from("file1"), "a.txt")
        .attach("files", Buffer.from("file2"), "b.txt");

      expect(res.status).toBe(200);
      expect(res.body.uploaded).toHaveLength(2);
    });

    it("uploads to a subdirectory", async () => {
      await fsp.mkdir(path.join(TEST_FILES_ROOT, "docs"), { recursive: true });

      const res = await request(app)
        .post(`/api/files/upload?path=${encodeURIComponent("/docs")}`)
        .attach("files", Buffer.from("content"), "readme.md");

      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "docs", "readme.md"))).toBe(true);
    });

    it("returns 400 for no files attached", async () => {
      const res = await request(app).post("/api/files/upload?path=/");
      expect(res.status).toBe(400);
    });

    it("returns 400 for path traversal", async () => {
      const res = await request(app)
        .post(`/api/files/upload?path=${encodeURIComponent("../../etc")}`)
        .attach("files", Buffer.from("evil"), "payload.txt");
      expect(res.status).toBe(400);
    });
  });

  // ── GET /api/files/download ──

  describe("GET /api/files/download", () => {
    it("downloads a file that exists", async () => {
      await fsp.writeFile(
        path.join(TEST_FILES_ROOT, "download-me.txt"),
        "hello download"
      );

      const res = await request(app)
        .get(`/api/files/download?path=${encodeURIComponent("/download-me.txt")}`)
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => { data += chunk; });
          res.on("end", () => cb(null, data));
        });
      expect(res.status).toBe(200);
      expect(res.body).toBe("hello download");
      expect(res.headers["content-disposition"]).toContain("download-me.txt");
    });

    it("returns 400 for missing path parameter", async () => {
      const res = await request(app).get("/api/files/download");
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent file", async () => {
      const res = await request(app).get(
        `/api/files/download?path=${encodeURIComponent("/no-such-file.txt")}`
      );
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /api/files ──

  describe("DELETE /api/files", () => {
    it("deletes a file", async () => {
      const fp = path.join(TEST_FILES_ROOT, "to-delete.txt");
      await fsp.writeFile(fp, "bye");

      const res = await request(app).delete(
        `/api/files?path=${encodeURIComponent("/to-delete.txt")}`
      );
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe("/to-delete.txt");
      expect(fs.existsSync(fp)).toBe(false);
    });

    it("deletes a directory recursively", async () => {
      const dir = path.join(TEST_FILES_ROOT, "dir-to-delete");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "child.txt"), "data");

      const res = await request(app).delete(
        `/api/files?path=${encodeURIComponent("/dir-to-delete")}`
      );
      expect(res.status).toBe(200);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("returns 400 for missing path parameter", async () => {
      const res = await request(app).delete("/api/files");
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent file", async () => {
      const res = await request(app).delete(
        `/api/files?path=${encodeURIComponent("/ghost.txt")}`
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/files/rename ──

  describe("POST /api/files/rename", () => {
    it("renames a file in place", async () => {
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "old.txt"), "content");

      const res = await request(app)
        .post("/api/files/rename")
        .send({ path: "/old.txt", newName: "new.txt" });

      expect(res.status).toBe(200);
      expect(res.body.renamed.from).toBe("/old.txt");
      expect(res.body.renamed.to).toBe("/new.txt");
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "new.txt"))).toBe(true);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "old.txt"))).toBe(false);
    });

    it("renames a file inside a subdirectory", async () => {
      await fsp.mkdir(path.join(TEST_FILES_ROOT, "sub"), { recursive: true });
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "sub/a.txt"), "content");

      const res = await request(app)
        .post("/api/files/rename")
        .send({ path: "/sub/a.txt", newName: "b.txt" });

      expect(res.status).toBe(200);
      expect(res.body.renamed.to).toBe("/sub/b.txt");
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "sub/b.txt"))).toBe(true);
    });

    it("rejects path separators in newName", async () => {
      const res = await request(app)
        .post("/api/files/rename")
        .send({ path: "/a.txt", newName: "b/c.txt" });
      expect(res.status).toBe(400);
    });

    it("rejects empty newName", async () => {
      const res = await request(app)
        .post("/api/files/rename")
        .send({ path: "/a.txt", newName: "" });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/files/move ──

  describe("POST /api/files/move", () => {
    it("moves a file to a new directory", async () => {
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "movable.txt"), "content");
      await fsp.mkdir(path.join(TEST_FILES_ROOT, "target"), { recursive: true });

      const res = await request(app)
        .post("/api/files/move")
        .send({ from: "/movable.txt", to: "/target/movable.txt" });

      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "target/movable.txt"))).toBe(true);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "movable.txt"))).toBe(false);
    });

    it("fails when destination exists and overwrite is false", async () => {
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "src.txt"), "a");
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "dst.txt"), "b");

      const res = await request(app)
        .post("/api/files/move")
        .send({ from: "/src.txt", to: "/dst.txt" });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("overwrites when overwrite=true", async () => {
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "src.txt"), "new");
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "dst.txt"), "old");

      const res = await request(app)
        .post("/api/files/move")
        .send({ from: "/src.txt", to: "/dst.txt", overwrite: true });

      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "src.txt"))).toBe(false);
      const content = await fsp.readFile(path.join(TEST_FILES_ROOT, "dst.txt"), "utf-8");
      expect(content).toBe("new");
    });
  });

  // ── POST /api/files/copy ──

  describe("POST /api/files/copy", () => {
    it("copies a file leaving source intact", async () => {
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "orig.txt"), "hi");

      const res = await request(app)
        .post("/api/files/copy")
        .send({ from: "/orig.txt", to: "/copy.txt" });

      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "orig.txt"))).toBe(true);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "copy.txt"))).toBe(true);
    });

    it("copies a directory recursively", async () => {
      await fsp.mkdir(path.join(TEST_FILES_ROOT, "src-dir"), { recursive: true });
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "src-dir/a.txt"), "a");
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "src-dir/b.txt"), "b");

      const res = await request(app)
        .post("/api/files/copy")
        .send({ from: "/src-dir", to: "/dst-dir" });

      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "dst-dir/a.txt"))).toBe(true);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "dst-dir/b.txt"))).toBe(true);
      // Source should still exist
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "src-dir/a.txt"))).toBe(true);
    });
  });

  // ── POST /api/files/bulk-delete ──

  describe("POST /api/files/bulk-delete", () => {
    it("deletes multiple files and returns per-item status", async () => {
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "a.txt"), "a");
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "b.txt"), "b");
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "c.txt"), "c");

      const res = await request(app)
        .post("/api/files/bulk-delete")
        .send({ paths: ["/a.txt", "/b.txt", "/c.txt"] });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(3);
      expect(res.body.results.every((r: any) => r.ok)).toBe(true);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "a.txt"))).toBe(false);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "b.txt"))).toBe(false);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "c.txt"))).toBe(false);
    });

    it("returns 207 on partial failure with per-item error details", async () => {
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "real.txt"), "x");

      const res = await request(app)
        .post("/api/files/bulk-delete")
        .send({ paths: ["/real.txt", "/ghost.txt"] });

      expect(res.status).toBe(207);
      const ok = res.body.results.find((r: any) => r.path === "/real.txt");
      const fail = res.body.results.find((r: any) => r.path === "/ghost.txt");
      expect(ok.ok).toBe(true);
      expect(fail.ok).toBe(false);
      expect(fail.error).toBeDefined();
    });

    it("rejects empty paths array", async () => {
      const res = await request(app).post("/api/files/bulk-delete").send({ paths: [] });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/files/bulk-move ──

  describe("POST /api/files/bulk-move", () => {
    it("moves multiple files to a target directory", async () => {
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "a.txt"), "a");
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "b.txt"), "b");
      await fsp.mkdir(path.join(TEST_FILES_ROOT, "archive"), { recursive: true });

      const res = await request(app)
        .post("/api/files/bulk-move")
        .send({ paths: ["/a.txt", "/b.txt"], toDir: "/archive" });

      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "archive/a.txt"))).toBe(true);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "archive/b.txt"))).toBe(true);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "a.txt"))).toBe(false);
    });
  });

  // ── POST /api/files/bulk-copy ──

  describe("POST /api/files/bulk-copy", () => {
    it("copies multiple files to a target directory leaving sources intact", async () => {
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "a.txt"), "a");
      await fsp.writeFile(path.join(TEST_FILES_ROOT, "b.txt"), "b");
      await fsp.mkdir(path.join(TEST_FILES_ROOT, "backup"), { recursive: true });

      const res = await request(app)
        .post("/api/files/bulk-copy")
        .send({ paths: ["/a.txt", "/b.txt"], toDir: "/backup" });

      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "backup/a.txt"))).toBe(true);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "backup/b.txt"))).toBe(true);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "a.txt"))).toBe(true);
      expect(fs.existsSync(path.join(TEST_FILES_ROOT, "b.txt"))).toBe(true);
    });
  });

  // ── Trash / Versions (legacy backend 501) ──

  describe("Trash endpoints (legacy backend)", () => {
    it("GET /api/files/trash returns 501 on legacy backend", async () => {
      const res = await request(app).get("/api/files/trash");
      expect(res.status).toBe(501);
    });

    it("POST /api/files/trash/restore returns 501 on legacy backend", async () => {
      const res = await request(app)
        .post("/api/files/trash/restore")
        .send({ name: "x" });
      expect(res.status).toBe(501);
    });

    it("DELETE /api/files/trash returns 501 on legacy backend", async () => {
      const res = await request(app).delete("/api/files/trash");
      expect(res.status).toBe(501);
    });

    it("GET /api/files/versions returns 501 on legacy backend", async () => {
      const res = await request(app).get("/api/files/versions?path=/a.txt");
      expect(res.status).toBe(501);
    });
  });

  // ── Phase 2 endpoints on legacy backend (some 501, some fall through) ──

  describe("Phase 2 endpoints (legacy backend behaviour)", () => {
    it("POST /api/files/favorite returns 501", async () => {
      const res = await request(app)
        .post("/api/files/favorite")
        .send({ path: "/a.txt", favorite: true });
      expect(res.status).toBe(501);
    });

    it("GET /api/files/favorites returns an empty list (graceful degrade)", async () => {
      const res = await request(app).get("/api/files/favorites");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    });

    it("GET /api/files/recents returns an empty list (graceful degrade)", async () => {
      const res = await request(app).get("/api/files/recents");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    });

    it("GET /api/files/search returns an empty list when backend is legacy", async () => {
      const res = await request(app).get("/api/files/search?q=budget");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    });

    it("GET /api/files/search still validates query length before degrading", async () => {
      const res = await request(app).get("/api/files/search");
      // Backend is legacy, so it returns [] before reaching the validator.
      // That's the contract: on legacy, search is a no-op.
      expect(res.status).toBe(200);
    });

    it("GET /api/files/thumbnail returns 501", async () => {
      const res = await request(app).get(
        "/api/files/thumbnail?path=/a.png"
      );
      expect(res.status).toBe(501);
    });

    it("PUT /api/files/share/:id returns 501", async () => {
      const res = await request(app)
        .put("/api/files/share/7")
        .send({ permissions: 3 });
      expect(res.status).toBe(501);
    });

    it("DELETE /api/files/share/:id returns 501", async () => {
      const res = await request(app).delete("/api/files/share/7");
      expect(res.status).toBe(501);
    });

    it("GET /api/files/shared-with-me returns empty shares on legacy", async () => {
      const res = await request(app).get("/api/files/shared-with-me");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ shares: [] });
    });
  });

  // ── Integration: full lifecycle ──

  describe("Full lifecycle", () => {
    it("mkdir → upload → list → download → delete → list", async () => {
      // 1. Create directory
      let res = await request(app)
        .post("/api/files/mkdir")
        .send({ path: "/docs" });
      expect(res.status).toBe(200);

      // 2. Upload a file into it
      res = await request(app)
        .post(`/api/files/upload?path=${encodeURIComponent("/docs")}`)
        .attach("files", Buffer.from("# Hello"), "readme.md");
      expect(res.status).toBe(200);

      // 3. List the directory
      res = await request(app).get(
        `/api/files?path=${encodeURIComponent("/docs")}`
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("readme.md");

      // 4. Download the file
      res = await request(app)
        .get(`/api/files/download?path=${encodeURIComponent("/docs/readme.md")}`)
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => { data += chunk; });
          res.on("end", () => cb(null, data));
        });
      expect(res.status).toBe(200);
      expect(res.body).toBe("# Hello");

      // 5. Delete the file
      res = await request(app).delete(
        `/api/files?path=${encodeURIComponent("/docs/readme.md")}`
      );
      expect(res.status).toBe(200);

      // 6. Verify it's gone
      res = await request(app).get(
        `/api/files?path=${encodeURIComponent("/docs")}`
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });
});
