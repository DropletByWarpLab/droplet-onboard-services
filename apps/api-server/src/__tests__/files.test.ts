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
