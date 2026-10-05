import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

vi.mock("../config.js", () => ({ config: { AUTH_ENABLED: false } }));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));

let root: string;
let original: string;
let createFilesBrainRouter: typeof import("../routes/files-brain.js").createFilesBrainRouter;
const previousRoot = process.env.BRAIN_MEMORY_ROOT;
const bytes = Buffer.from("brain original bytes");
const owner = "11111111-1111-4111-8111-111111111111";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "brain-filename-"));
  process.env.BRAIN_MEMORY_ROOT = root;
  const directory = join(root, owner, "22222222-2222-4222-8222-222222222222");
  await mkdir(directory, { recursive: true });
  original = join(directory, "original.bin");
  await writeFile(original, bytes);
  ({ createFilesBrainRouter } = await import("../routes/files-brain.js"));
});
afterAll(async () => {
  if (previousRoot === undefined) delete process.env.BRAIN_MEMORY_ROOT;
  else process.env.BRAIN_MEMORY_ROOT = previousRoot;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("brain-filename-")) throw new Error("unsafe test cleanup path");
  await rm(root, { recursive: true, force: true });
});

function app(filename: string, userId = owner, mimeType = "text/plain") {
  const server = express();
  server.use((req, _res, next) => {
    req.user = { id: userId, username: "stefan", displayName: "Stefan", role: "family" };
    next();
  });
  server.use("/api", createFilesBrainRouter({ brainMemoryItem: {
    findUnique: async () => ({ id: "22222222-2222-4222-8222-222222222222", userId: owner, filename, storagePath: original, mimeType }),
  } } as never));
  return server;
}

describe("brain original Unicode downloads use real HTTP header validation and filesystem streaming", () => {
  it.each([
    { name: "中文.txt", inline: false, disposition: "attachment" },
    { name: "Café Ω.txt", inline: false, disposition: "attachment" },
    { name: "中文.txt", inline: true, disposition: "inline" },
    { name: "中文.pdf", inline: true, disposition: "inline" },
    { name: "中文.html", inline: true, disposition: "attachment" },
    { name: "中文 (it's)*.txt", inline: false, disposition: "attachment" },
  ])("streams $name as $disposition", async ({ name, inline, disposition }) => {
    const response = await request(app(name, owner, "application/pdf"))
      .get("/api/files/brain/22222222-2222-4222-8222-222222222222/download")
      .query(inline ? { disposition: "inline" } : {});
    expect(response.status).toBe(200);
    expect(response.text ?? response.body.toString("utf8")).toBe(bytes.toString("utf8"));
    const header = response.headers["content-disposition"] as string;
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(header.startsWith(`${disposition}; filename="`)).toBe(true);
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1])).toBe(name);
    if (name.includes("(it's)*")) expect(header).toContain("%28it%27s%29%2A");
    if (inline && name.endsWith(".txt")) expect(response.headers["content-security-policy"]).toBe("sandbox");
    if (inline && name.endsWith(".pdf")) expect(response.headers["content-security-policy"] ?? "").not.toMatch(/\bsandbox\b/);
    // A claimed PDF MIME never permits an HTML filename to render inline.
    if (name.endsWith(".html")) expect(header.startsWith("attachment;")).toBe(true);
  });
  it("keeps caller ownership enforced before serving any original bytes", async () => {
    const response = await request(app("中文.txt", "another-person"))
      .get("/api/files/brain/22222222-2222-4222-8222-222222222222/download");
    expect(response.status).toBe(404);
    expect(response.headers["content-disposition"]).toBeUndefined();
  });
});
