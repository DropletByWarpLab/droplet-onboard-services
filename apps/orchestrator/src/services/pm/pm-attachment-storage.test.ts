/**
 * WARP-1505 — where attachment bytes live, and how they get there.
 *
 * The engine is driven through the REAL multer + busboy + a real directory, the
 * way the upload route uses it: what is asserted is what is on disk afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import multer, { MulterError } from "multer";
import request from "supertest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import net from "node:net";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SNIFF_BYTES } from "./pm-attachment-content.js";
import {
  blobPath,
  createAttachmentStorage,
  removeAttachmentBlobs,
  removeBlob,
  type StoredAttachmentFile,
} from "./pm-attachment-storage.js";

let root: string;
let parent: string;

beforeEach(() => {
  // the root sits inside a parent we own, so "nothing escaped" is checkable
  parent = mkdtempSync(join(tmpdir(), "pm-attach-"));
  root = join(parent, "root");
  mkdirSync(root);
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

/** Every regular file under `dir`, relative — the "what is on disk" assertion. */
function filesUnder(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function uploadApp(key: string, maxBytes: number) {
  const app = express();
  app.post("/up", (req, res) => {
    const parse = multer({
      storage: createAttachmentStorage(root, key),
      preservePath: true,
      limits: { fileSize: maxBytes, files: 1 },
    }).single("file");
    parse(req, res, (err?: unknown) => {
      if (err) {
        const e = err as Error & { code?: string };
        res.status(err instanceof MulterError ? 413 : 500).json({ error: e.message, code: e.code });
        return;
      }
      const f = req.file as unknown as StoredAttachmentFile;
      res.json({ size: f.size, sha256: f.sha256, head: f.head.toString("hex") });
    });
  });
  return app;
}

describe("blobPath", () => {
  it("shards by the first two key characters", () => {
    const key = "0a1b2c3d-1111-4222-8333-444455556666";
    expect(blobPath(root, key)).toBe(join(root, "0a", key));
  });

  it.each([
    ["a traversal", "../../etc/passwd"],
    ["a traversal after a real uuid", "0a1b2c3d-1111-4222-8333-444455556666/../../x"],
    ["a path separator", "0a/1b2c3d-1111-4222-8333-444455556666"],
    ["a backslash", "0a1b2c3d-1111-4222-8333-444455556666\\x"],
    ["a trailing newline", "0a1b2c3d-1111-4222-8333-444455556666\n"],
    ["upper-case hex (a different spelling of the same uuid)", "0A1B2C3D-1111-4222-8333-444455556666"],
    ["the empty string", ""],
    ["dots", ".."],
    ["a user-supplied file name", "report.pdf"],
    ["a NUL", "0a1b2c3d-1111-4222-8333-44445555666\u0000"],
  ])("refuses %s — only a lower-case uuid is ever joined onto the root", (_n, key) => {
    expect(() => blobPath(root, key)).toThrow("invalid_storage_key");
  });
});

describe("createAttachmentStorage", () => {
  it("streams the part to <root>/<shard>/<key> and reports exactly what it wrote", async () => {
    const key = randomUUID();
    const body = Buffer.from("hello attachment\n".repeat(100));
    const res = await request(uploadApp(key, 1024 * 1024)).post("/up").attach("file", body, "hello.txt");

    expect(res.status).toBe(200);
    expect(res.body.size).toBe(body.length);
    expect(res.body.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(Buffer.from(res.body.head, "hex").equals(body)).toBe(true);
    expect(filesUnder(root)).toEqual([`${key.slice(0, 2)}/${key}`]);
    expect(readFileSync(blobPath(root, key)).equals(body)).toBe(true);
  });

  it("keeps only the first SNIFF_BYTES as the head, however large the file", async () => {
    const key = randomUUID();
    const body = Buffer.alloc(300_000, 0x61);
    const res = await request(uploadApp(key, 1024 * 1024)).post("/up").attach("file", body, "big.bin");
    expect(res.status).toBe(200);
    expect(res.body.size).toBe(300_000);
    expect(Buffer.from(res.body.head, "hex").length).toBe(SNIFF_BYTES);
  });

  it("never stores the user's file name — a hostile one changes nothing on disk", async () => {
    const key = randomUUID();
    const res = await request(uploadApp(key, 1024 * 1024))
      .post("/up")
      .attach("file", Buffer.from("x"), { filename: "../../../escape.txt", contentType: "text/plain" });
    expect(res.status).toBe(200);
    expect(filesUnder(root)).toEqual([`${key.slice(0, 2)}/${key}`]);
    // and nothing appeared next to the root either
    expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
  });

  it("enforces the size cap WHILE streaming and leaves nothing on disk", async () => {
    const key = randomUUID();
    const cap = 100_000;
    const res = await request(uploadApp(key, cap))
      .post("/up")
      .attach("file", Buffer.alloc(cap * 5, 0x62), "too-big.bin");
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("LIMIT_FILE_SIZE");
    expect(filesUnder(root)).toEqual([]);
  });

  it("accepts a file of exactly the cap", async () => {
    const key = randomUUID();
    const cap = 50_000;
    const res = await request(uploadApp(key, cap)).post("/up").attach("file", Buffer.alloc(cap, 1), "exact.bin");
    expect(res.status).toBe(200);
    expect(res.body.size).toBe(cap);
  });

  it("removes a partial file when the client goes away mid-upload", async () => {
    const key = randomUUID();
    const app = uploadApp(key, 1024 * 1024);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const boundary = "----cut";
      const head =
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cut.bin"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`;
      await new Promise<void>((resolve) => {
        const sock = net.connect(port, "127.0.0.1", () => {
          sock.write(
            `POST /up HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\n` +
              `Content-Length: 900000\r\n\r\n${head}`,
          );
          sock.write(Buffer.alloc(20_000, 7));
          // hang up with the part unfinished
          setTimeout(() => {
            sock.destroy();
            resolve();
          }, 100);
        });
      });
      // give the server a moment to notice and clean up
      for (let i = 0; i < 40 && filesUnder(root).length > 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(filesUnder(root)).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("settles — and removes what it wrote — when the part stream is destroyed WITHOUT an error", async () => {
    // busboy destroying a part on client abort need not emit 'error'; the engine
    // must not wait forever for an event that never comes.
    const key = randomUUID();
    const engine = createAttachmentStorage(root, key);
    const stream = new PassThrough();
    const outcome = new Promise<Error | null>((resolve) => {
      engine._handleFile({} as never, { stream } as never, (err) => resolve((err as Error | null) ?? null));
    });
    stream.write(Buffer.alloc(10_000, 9));
    // let the engine open the file and take the bytes, then tear the part down
    for (let i = 0; i < 100 && filesUnder(root).length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    stream.destroy();

    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe("upload part closed before it ended");
    expect(filesUnder(root)).toEqual([]);
  });

  it("does not take a normally-ended part for an aborted one", async () => {
    const key = randomUUID();
    const engine = createAttachmentStorage(root, key);
    const stream = new PassThrough();
    const outcome = new Promise<{ err: Error | null; info?: Partial<StoredAttachmentFile> }>((resolve) => {
      engine._handleFile({} as never, { stream } as never, (err, info) =>
        resolve({ err: (err as Error | null) ?? null, info: info as unknown as Partial<StoredAttachmentFile> }),
      );
    });
    stream.end(Buffer.from("complete"));
    const { err, info } = await outcome;
    expect(err).toBeNull();
    expect(info?.size).toBe(8);
    expect(readFileSync(blobPath(root, key), "utf8")).toBe("complete");
  });

  it("refuses a key that is not a uuid and writes nothing", async () => {
    const res = await request(uploadApp("../../escape", 1024)).post("/up").attach("file", Buffer.from("x"), "a.txt");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("invalid_storage_key");
    expect(filesUnder(root)).toEqual([]);
    expect(existsSync(join(root, "..", "escape"))).toBe(false);
  });

  it("does not delete a file it did not create when the key is already taken", async () => {
    const key = randomUUID();
    mkdirSync(join(root, key.slice(0, 2)), { recursive: true });
    writeFileSync(blobPath(root, key), "somebody else's bytes");
    const res = await request(uploadApp(key, 1024)).post("/up").attach("file", Buffer.from("new"), "a.txt");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("EEXIST");
    expect(readFileSync(blobPath(root, key), "utf8")).toBe("somebody else's bytes");
  });
});

describe("removeBlob / removeAttachmentBlobs", () => {
  it("removes a blob, and removing one that is already gone is fine", async () => {
    const key = randomUUID();
    mkdirSync(join(root, key.slice(0, 2)), { recursive: true });
    writeFileSync(blobPath(root, key), "x");
    await removeBlob(root, key);
    expect(existsSync(blobPath(root, key))).toBe(false);
    await expect(removeBlob(root, key)).resolves.toBeUndefined();
  });

  it("removes a set of blobs and never throws", async () => {
    const a = randomUUID();
    const b = randomUUID();
    for (const k of [a, b]) {
      mkdirSync(join(root, k.slice(0, 2)), { recursive: true });
      writeFileSync(blobPath(root, k), "x");
    }
    expect(await removeAttachmentBlobs([a, b], root)).toEqual({ removed: 2, failed: 0 });
    expect(filesUnder(root)).toEqual([]);
  });

  it("counts a blob that would not unlink as failed — and carries on with the rest", async () => {
    const stuck = randomUUID();
    const fine = randomUUID();
    mkdirSync(blobPath(root, stuck), { recursive: true }); // a directory where the file should be
    mkdirSync(join(root, fine.slice(0, 2)), { recursive: true });
    writeFileSync(blobPath(root, fine), "x");
    expect(await removeAttachmentBlobs([stuck, fine], root)).toEqual({ removed: 1, failed: 1 });
    expect(existsSync(blobPath(root, fine))).toBe(false);
  });

  it("never joins a key this store did not mint onto the root — even a hostile one in a database row", async () => {
    // a file OUTSIDE the root that a traversal key would name
    const outside = join(parent, "outside.txt");
    writeFileSync(outside, "keep me");
    const out = await removeAttachmentBlobs(["../outside.txt", "legacy-key-from-before", "", "../../etc/passwd"], root);
    expect(out).toEqual({ removed: 0, failed: 0 });
    expect(readFileSync(outside, "utf8")).toBe("keep me");
  });

  it("an empty set is a no-op", async () => {
    await expect(removeAttachmentBlobs([], root)).resolves.toEqual({ removed: 0, failed: 0 });
  });
});
