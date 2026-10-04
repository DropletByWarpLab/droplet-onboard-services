/**
 * WARP-1505 — the attachment routes, end to end through real multer + a real
 * directory: what the client sees, and what is on disk and in the (fake) tables
 * afterwards. Mounted on a bare Express app with a stub auth middleware so the
 * REAL `requireRole` guards run, the way native.test.ts does it.
 *
 * Module gating (a guest never reaches these routes) is asserted against the real
 * `mountModuleGates` in __tests__/guest-work-item-share.test.ts; database
 * invariants against a real Postgres in __tests__/pm-attachment.pg.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthUser } from "../../middleware/auth.js";
import { createPmAttachmentsRouter, type PmAttachmentsRouterOptions } from "./attachments.js";
import { blobPath } from "../../services/pm/pm-attachment-storage.js";
import { makeAttachmentFake } from "../../__tests__/helpers/pm-attachment-fake.js";

type Row = Record<string, unknown>;

const OWNER = { id: "u-owner", role: "owner" };
const ADMIN = { id: "u-admin", role: "admin" };
const ALICE = { id: "u-alice", role: "family" };
const BOB = { id: "u-bob", role: "family" };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 1)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(120, 2)]);
const PE = (() => {
  const b = Buffer.alloc(256);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c);
  b.write("PE\0\0", 0x80, "latin1");
  return b;
})();

const MAX = 20_000; // a small cap keeps the streaming-limit cases quick

let root: string;
let parent: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "pm-attach-route-"));
  root = join(parent, "pm-attachments");
  mkdirSync(root);
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

function makeApp(
  fake: ReturnType<typeof makeAttachmentFake>,
  user: { id: string; role: string } | null,
  maxBytes = MAX,
  routerOpts: Partial<PmAttachmentsRouterOptions> = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) {
      const u: AuthUser = { id: user.id, username: user.id, displayName: user.id, role: user.role as AuthUser["role"] };
      req.user = u;
    }
    next();
  });
  app.use("/api", createPmAttachmentsRouter(fake.prisma, { root, maxBytes, ...routerOpts }));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "internal", message: err.message });
  });
  return app;
}

/** Every file under `dir` (relative), sorted: the "what is on disk" assertion. */
function filesUnder(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/** A READY row with a real blob, for the download/delete cases. */
function seedReady(
  fake: ReturnType<typeof makeAttachmentFake>,
  bytes: Buffer,
  over: Row = {},
): Row {
  const storageKey = randomUUID();
  mkdirSync(join(root, storageKey.slice(0, 2)), { recursive: true });
  writeFileSync(blobPath(root, storageKey), bytes);
  const row: Row = {
    id: `att-${fake.db.attachments.length + 100}`,
    workItemId: "wi-1",
    commentId: null,
    fileName: "plan.pdf",
    mimeType: "application/pdf",
    sizeBytes: BigInt(bytes.length),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    storageKey,
    status: "READY",
    uploadedById: ALICE.id,
    createdAt: new Date("2026-10-04T10:00:00Z"),
    ...over,
  };
  fake.db.attachments.push(row);
  return row;
}

// ── POST /api/pm/work-items/:id/attachments ──────────────────────────────────

describe("POST /api/pm/work-items/:id/attachments", () => {
  it.each([OWNER, ADMIN, ALICE])("accepts a file from $role — stored under its opaque key, row READY, activity written", async (user) => {
    const fake = makeAttachmentFake();
    const res = await request(makeApp(fake, user))
      .post("/api/pm/work-items/wi-1/attachments")
      .attach("file", PNG, { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    const a = res.body.attachment;
    expect(a).toMatchObject({
      workItemId: "wi-1",
      commentId: null,
      fileName: "photo.png",
      mimeType: "image/png",
      sizeBytes: PNG.length,
      previewable: true,
      uploadedById: user.id,
    });
    expect(a.storageKey).toBeUndefined(); // the key never leaves the server

    const row = fake.db.attachments[0];
    expect(row).toMatchObject({ status: "READY", sizeBytes: BigInt(PNG.length), uploadedById: user.id });
    expect(row.sha256).toBe(createHash("sha256").update(PNG).digest("hex"));
    const key = row.storageKey as string;
    expect(filesUnder(root)).toEqual([`${key.slice(0, 2)}/${key}`]);
    expect(readFileSync(blobPath(root, key)).equals(PNG)).toBe(true);
    expect(fake.db.activity).toEqual([
      expect.objectContaining({ workItemId: "wi-1", actorId: user.id, verb: "attachment_added", newValue: "photo.png" }),
    ]);
  });

  it("attaches to a comment of the item with ?comment_id=", async () => {
    const fake = makeAttachmentFake();
    const res = await request(makeApp(fake, ALICE))
      .post("/api/pm/work-items/wi-1/attachments?comment_id=c-1")
      .attach("file", PNG, "p.png");
    expect(res.status).toBe(201);
    expect(res.body.attachment.commentId).toBe("c-1");
  });

  it("404s a comment of ANOTHER item, without creating a row or a file", async () => {
    const fake = makeAttachmentFake();
    const res = await request(makeApp(fake, ALICE))
      .post("/api/pm/work-items/wi-1/attachments?comment_id=c-2")
      .attach("file", PNG, "p.png");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("comment_not_found");
    expect(fake.stats.creates).toBe(0);
    expect(filesUnder(root)).toEqual([]);
  });

  it("404s an unknown work item, without creating a row or a file", async () => {
    const fake = makeAttachmentFake();
    const res = await request(makeApp(fake, ALICE)).post("/api/pm/work-items/nope/attachments").attach("file", PNG, "p.png");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("work_item_not_found");
    expect(fake.stats.creates).toBe(0);
    expect(filesUnder(root)).toEqual([]);
  });

  it("400s an empty comment_id", async () => {
    const res = await request(makeApp(makeAttachmentFake(), ALICE))
      .post("/api/pm/work-items/wi-1/attachments?comment_id=")
      .attach("file", PNG, "p.png");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  describe("who may upload", () => {
    it.each([
      ["a guest", { id: "u-guest", role: "guest" }],
      ["a service principal", { id: "_service:voice", role: "service" }],
      ["the MCP service principal (no tool uploads files)", { id: "_service:mcp", role: "service" }],
      ["nobody (no session)", null],
    ])("refuses %s with 403, and writes nothing", async (_n, user) => {
      const fake = makeAttachmentFake();
      const res = await request(makeApp(fake, user)).post("/api/pm/work-items/wi-1/attachments").attach("file", PNG, "p.png");
      expect(res.status).toBe(403);
      expect(fake.stats.creates).toBe(0);
      expect(filesUnder(root)).toEqual([]);
    });
  });

  describe("what is not a well-formed upload", () => {
    it("400s a body that is not multipart", async () => {
      const fake = makeAttachmentFake();
      const res = await request(makeApp(fake, ALICE)).post("/api/pm/work-items/wi-1/attachments").send({ file: "x" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("attachment_bad_request");
      expect(fake.stats.creates).toBe(0);
    });

    it("400s a form with no file part, and leaves no row behind", async () => {
      const fake = makeAttachmentFake();
      const res = await request(makeApp(fake, ALICE)).post("/api/pm/work-items/wi-1/attachments").field("note", "hi");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("attachment_file_required");
      expect(fake.db.attachments).toEqual([]);
    });

    it("400s two files — one per request — and keeps neither", async () => {
      const fake = makeAttachmentFake();
      const res = await request(makeApp(fake, ALICE))
        .post("/api/pm/work-items/wi-1/attachments")
        .attach("file", PNG, "a.png")
        .attach("file", PNG, "b.png");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("attachment_bad_request");
      expect(fake.db.attachments).toEqual([]);
      expect(filesUnder(root)).toEqual([]);
    });

    it("400s a file under the wrong field name", async () => {
      const fake = makeAttachmentFake();
      const res = await request(makeApp(fake, ALICE)).post("/api/pm/work-items/wi-1/attachments").attach("upload", PNG, "a.png");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("attachment_bad_request");
      expect(fake.db.attachments).toEqual([]);
      expect(filesUnder(root)).toEqual([]);
    });

    it("400s an empty file with its own message", async () => {
      const fake = makeAttachmentFake();
      const res = await request(makeApp(fake, ALICE))
        .post("/api/pm/work-items/wi-1/attachments")
        .attach("file", Buffer.alloc(0), { filename: "empty.txt", contentType: "text/plain" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("attachment_empty");
      expect(fake.db.attachments).toEqual([]);
      expect(filesUnder(root)).toEqual([]);
    });
  });

  describe("the size cap", () => {
    it("is enforced WHILE streaming: a file over the cap is refused 413 with the cap, and nothing is kept", async () => {
      const fake = makeAttachmentFake();
      // Over the cap but inside the multipart-overhead margin, so the
      // Content-Length fast refusal does NOT fire and the streaming limit does.
      const res = await request(makeApp(fake, ALICE))
        .post("/api/pm/work-items/wi-1/attachments")
        .attach("file", Buffer.alloc(MAX + 10_000, 3), "big.bin");
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: "attachment_too_large", maxBytes: MAX });
      expect(fake.stats.creates).toBe(1); // it did start...
      expect(fake.db.attachments).toEqual([]); // ...and was cleaned up
      expect(fake.db.activity).toEqual([]);
      expect(filesUnder(root)).toEqual([]);
    });

    it("refuses a body DECLARED far over the cap before it creates a row or reads a byte", async () => {
      const fake = makeAttachmentFake();
      const res = await request(makeApp(fake, ALICE))
        .post("/api/pm/work-items/wi-1/attachments")
        .attach("file", Buffer.alloc(MAX * 10, 3), "huge.bin");
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: "attachment_too_large", maxBytes: MAX });
      expect(fake.stats.creates).toBe(0);
      expect(filesUnder(root)).toEqual([]);
    });

    it("holds a CHUNKED upload (no Content-Length to refuse early) to the cap too, and keeps nothing", async () => {
      const fake = makeAttachmentFake();
      const server = makeApp(fake, ALICE).listen(0);
      try {
        const { port } = server.address() as { port: number };
        const boundary = "----chunked";
        const status = await new Promise<number>((resolve, reject) => {
          const req = http.request(
            {
              port,
              host: "127.0.0.1",
              method: "POST",
              path: "/api/pm/work-items/wi-1/attachments",
              // chunked: the server is never told how big this is
              headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Transfer-Encoding": "chunked" },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode ?? 0));
            },
          );
          req.on("error", reject);
          req.write(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n` +
              `Content-Type: application/octet-stream\r\n\r\n`,
          );
          // 3x the cap, in pieces, then close the part properly
          for (let i = 0; i < 6; i += 1) req.write(Buffer.alloc(MAX / 2, 5));
          req.end(`\r\n--${boundary}--\r\n`);
        });
        expect(status).toBe(413);
        expect(fake.db.attachments).toEqual([]);
        expect(filesUnder(root)).toEqual([]);
      } finally {
        server.close();
      }
    });

    it("accepts a file of exactly the cap", async () => {
      const fake = makeAttachmentFake();
      const res = await request(makeApp(fake, ALICE))
        .post("/api/pm/work-items/wi-1/attachments")
        .attach("file", Buffer.alloc(MAX, 4), "exact.bin");
      expect(res.status).toBe(201);
      expect(res.body.attachment.sizeBytes).toBe(MAX);
    });

    it("reads the cap from PM_ATTACHMENT_MAX_BYTES by default (25 MiB), not a number baked into the route", async () => {
      const app = express();
      app.use((req: Request, _res: Response, next: NextFunction) => {
        req.user = { id: "u", username: "u", displayName: "u", role: "family" } as AuthUser;
        next();
      });
      app.use("/api", createPmAttachmentsRouter(makeAttachmentFake().prisma, { root }));
      const res = await request(app).get("/api/pm/work-items/wi-1/attachments");
      expect(res.body.limits.maxBytes).toBe(25 * 1024 * 1024);
    });
  });

  describe("what a file may be", () => {
    it.each([
      ["an .exe", "setup.exe", Buffer.from("hello"), "application/octet-stream", "attachment_type_blocked"],
      ["a PE named .png", "photo.png", PE, "image/png", "attachment_type_blocked"],
      ["a PE named .txt", "notes.txt", PE, "text/plain", "attachment_type_blocked"],
      ["a .png that is really a PDF", "evil.png", PDF, "image/png", "attachment_type_mismatch"],
      ["a .png with no signature (HTML in disguise)", "evil.png", Buffer.from("<html><script>alert(1)</script>"), "image/png", "attachment_type_mismatch"],
      ["a claimed type that disagrees with the bytes", "photo.png", PNG, "text/html", "attachment_type_mismatch"],
    ])("refuses %s with 415 and keeps nothing", async (_n, name, bytes, contentType, code) => {
      const fake = makeAttachmentFake();
      const res = await request(makeApp(fake, ALICE))
        .post("/api/pm/work-items/wi-1/attachments")
        .attach("file", bytes, { filename: name, contentType });
      expect(res.status).toBe(415);
      expect(res.body.error).toBe(code);
      expect(fake.db.attachments).toEqual([]);
      expect(fake.db.activity).toEqual([]);
      expect(filesUnder(root)).toEqual([]);
    });

    it("records the type the SERVER verified: a lying octet-stream claim over PNG bytes is recorded as image/png", async () => {
      const res = await request(makeApp(makeAttachmentFake(), ALICE))
        .post("/api/pm/work-items/wi-1/attachments")
        .attach("file", PNG, { filename: "shot", contentType: "application/octet-stream" });
      expect(res.status).toBe(201);
      expect(res.body.attachment.mimeType).toBe("image/png");
    });

    it("accepts HTML and SVG but records them as opaque downloads, never previewable", async () => {
      for (const [name, contentType] of [["page.html", "text/html"], ["d.svg", "image/svg+xml"]] as const) {
        const res = await request(makeApp(makeAttachmentFake(), ALICE))
          .post("/api/pm/work-items/wi-1/attachments")
          .attach("file", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), { filename: name, contentType });
        expect(res.status, name).toBe(201);
        expect(res.body.attachment.mimeType, name).toBe("application/octet-stream");
        expect(res.body.attachment.previewable, name).toBe(false);
      }
    });
  });

  describe("path traversal", () => {
    it.each([
      ["../../evil.txt", "evil.txt"],
      ["..\\..\\evil.txt", "evil.txt"],
      ["/etc/cron.d/evil.txt", "evil.txt"],
      ["C:\\Windows\\evil.txt", "evil.txt"],
      ["a/../../evil.txt", "evil.txt"],
    ])("a file named %j is shown as %j and written nowhere near that path", async (sent, shown) => {
      const fake = makeAttachmentFake();
      const res = await request(makeApp(fake, ALICE))
        .post("/api/pm/work-items/wi-1/attachments")
        .attach("file", Buffer.from("payload"), { filename: sent, contentType: "text/plain" });

      expect(res.status).toBe(201);
      expect(res.body.attachment.fileName).toBe(shown);
      const key = fake.db.attachments[0].storageKey as string;
      // exactly one file, at the opaque key, inside the root...
      expect(filesUnder(root)).toEqual([`${key.slice(0, 2)}/${key}`]);
      // ...and nothing was created beside or above it
      expect(readdirSync(parent)).toEqual(["pm-attachments"]);
      expect(existsSync(join(parent, "evil.txt"))).toBe(false);
    });

    it("strips bidi spoofing from the name it stores and returns", async () => {
      const res = await request(makeApp(makeAttachmentFake(), ALICE))
        .post("/api/pm/work-items/wi-1/attachments")
        .attach("file", Buffer.from("x"), { filename: "invoice\u202Egnp.txt", contentType: "text/plain" });
      expect(res.status).toBe(201);
      expect(res.body.attachment.fileName).toBe("invoicegnp.txt");
    });
  });
});

describe("limits that protect the box (review: a stolen session must not be able to fill the disk)", () => {
  const upload = (app: ReturnType<typeof makeApp>) =>
    request(app).post("/api/pm/work-items/wi-1/attachments").attach("file", Buffer.from("x"), "a.txt");

  describe("the per-IP upload ceiling", () => {
    it("answers 429 past the ceiling — and the refused request costs no row and no file", async () => {
      const fake = makeAttachmentFake();
      const app = makeApp(fake, ALICE, MAX, { uploadsPerMinute: 3 });
      for (let i = 0; i < 3; i += 1) expect((await upload(app)).status).toBe(201);

      const refused = await upload(app);
      expect(refused.status).toBe(429);
      expect(refused.body).toEqual({ error: "Too many requests, slow down" });
      expect(refused.headers.ratelimit).toBeTruthy(); // the IETF draft-8 header, so a client can back off
      expect(fake.stats.creates).toBe(3);
      expect(filesUnder(root)).toHaveLength(3);
    });

    it("counts per router, so one router's budget never leaks into another's", async () => {
      const fake = makeAttachmentFake();
      const first = makeApp(fake, ALICE, MAX, { uploadsPerMinute: 1 });
      expect((await upload(first)).status).toBe(201);
      expect((await upload(first)).status).toBe(429);
      expect((await upload(makeApp(fake, ALICE, MAX, { uploadsPerMinute: 1 }))).status).toBe(201);
    });

    it("defaults to 30 a minute", async () => {
      const fake = makeAttachmentFake();
      const app = makeApp(fake, ALICE);
      const res = await upload(app);
      expect(res.status).toBe(201);
      // draft-8: the policy names the quota, the other header what is left of it
      expect(res.headers["ratelimit-policy"]).toMatch(/q=30/);
      expect(res.headers.ratelimit).toMatch(/r=29/);
    });
  });

  describe("the free-space floor", () => {
    // free = bavail * bsize, total = blocks * bsize, floor = max(2 x cap, 5% of total)
    const space = (bavail: number, bsize: number, blocks: number) => async () => ({ bavail, bsize, blocks });

    it("answers 507 attachment_storage_full BEFORE accepting a byte: no row, no file", async () => {
      const fake = makeAttachmentFake();
      const app = makeApp(fake, ALICE, MAX, { statfs: space(10, 4096, 1_000_000) }); // 40 KB free of 4 GB
      const res = await upload(app);
      expect(res.status).toBe(507);
      expect(res.body).toEqual({ error: "attachment_storage_full" });
      expect(fake.stats.creates).toBe(0);
      expect(filesUnder(root)).toEqual([]);
    });

    it("the floor is 5% of the filesystem when that is larger than two files", async () => {
      // total 4,096,000 B -> 5% = 204,800 B; two files = 40,000 B
      const at = makeApp(makeAttachmentFake(), ALICE, MAX, { statfs: space(50, 4096, 1000) }); // exactly 204,800 free
      expect((await upload(at)).status).toBe(201);
      const under = makeApp(makeAttachmentFake(), ALICE, MAX, { statfs: space(49, 4096, 1000) }); // 200,704 free
      expect((await upload(under)).status).toBe(507);
    });

    it("the floor is two maximal files when that is larger than 5% of the filesystem", async () => {
      // total 100,000 B -> 5% = 5,000 B; two files = 2 x 20,000 = 40,000 B
      const at = makeApp(makeAttachmentFake(), ALICE, MAX, { statfs: space(40_000, 1, 100_000) });
      expect((await upload(at)).status).toBe(201);
      const under = makeApp(makeAttachmentFake(), ALICE, MAX, { statfs: space(39_999, 1, 100_000) });
      expect((await upload(under)).status).toBe(507);
    });

    it("asks about the storage root itself", async () => {
      const asked: string[] = [];
      const app = makeApp(makeAttachmentFake(), ALICE, MAX, {
        statfs: async (path) => {
          asked.push(path);
          return { bavail: 1_000_000, bsize: 4096, blocks: 1_000_000 };
        },
      });
      await upload(app);
      expect(asked).toEqual([root]);
    });

    it("a volume whose space cannot be read does not switch uploads off", async () => {
      const app = makeApp(makeAttachmentFake(), ALICE, MAX, {
        statfs: async () => {
          throw new Error("ENOSYS");
        },
      });
      expect((await upload(app)).status).toBe(201);
    });

    it("is not asked for a request that is refused earlier (wrong role, not multipart)", async () => {
      let asked = 0;
      const statfs = async () => {
        asked += 1;
        return { bavail: 1_000_000, bsize: 4096, blocks: 1_000_000 };
      };
      const guest = makeApp(makeAttachmentFake(), { id: "u-guest", role: "guest" }, MAX, { statfs });
      expect((await upload(guest)).status).toBe(403);
      const json = makeApp(makeAttachmentFake(), ALICE, MAX, { statfs });
      expect((await request(json).post("/api/pm/work-items/wi-1/attachments").send({})).status).toBe(400);
      expect(asked).toBe(0);
    });
  });
});

describe("a client that hangs up", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** The router with its error handler observable: a client that left is not a server error. */
  function observed(fake: ReturnType<typeof makeAttachmentFake>) {
    const errors: string[] = [];
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { id: "u-alice", username: "alice", displayName: "alice", role: "family" } as AuthUser;
      next();
    });
    app.use("/api", createPmAttachmentsRouter(fake.prisma, { root, maxBytes: 1_000_000 }));
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      errors.push(err.message);
      if (!res.headersSent) res.status(500).end();
    });
    return { app, errors };
  }

  /** Start a multipart upload on a raw socket and hang up `afterMs` later, body unfinished. */
  function hangUpAfter(server: http.Server, afterMs: number): Promise<void> {
    const { port } = server.address() as { port: number };
    const boundary = "----leaves";
    return new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write(
          `POST /api/pm/work-items/wi-1/attachments HTTP/1.1\r\nHost: x\r\n` +
            `Content-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: 500000\r\n\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="e.bin"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`,
        );
        sock.write(Buffer.alloc(5_000, 1));
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, afterMs);
      });
    });
  }

  async function until(check: () => boolean, ms = 3000): Promise<boolean> {
    for (let waited = 0; waited < ms; waited += 25) {
      if (check()) return true;
      await sleep(25);
    }
    return check();
  }

  it("while beginUpload is still waiting on the database: the handler settles and the row is marked FAILED, not left UPLOADING for an hour", async () => {
    const fake = makeAttachmentFake();
    const prisma = fake.prisma as unknown as {
      pmWorkItem: { findUnique: (a: unknown) => Promise<unknown> };
      pmAttachment: { updateMany: (a: { data: { status?: string } }) => Promise<unknown> };
    };
    // a loaded database: the client leaves before the lookup comes back
    const lookup = prisma.pmWorkItem.findUnique.bind(prisma.pmWorkItem);
    prisma.pmWorkItem.findUnique = async (a) => {
      await sleep(400);
      return lookup(a);
    };
    const flips: string[] = [];
    const flip = prisma.pmAttachment.updateMany.bind(prisma.pmAttachment);
    prisma.pmAttachment.updateMany = async (a) => {
      if (a.data.status) flips.push(a.data.status);
      return flip(a);
    };
    const { app, errors } = observed(fake);
    const server = app.listen(0);
    try {
      await hangUpAfter(server, 80);
      expect(await until(() => fake.db.attachments.length === 0 && flips.includes("FAILED"))).toBe(true);
      expect(fake.db.attachments.filter((r) => r.status === "UPLOADING")).toEqual([]);
      expect(filesUnder(root)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("mid-body: row and partial file are gone, and it is not logged as an unhandled server error", async () => {
    const fake = makeAttachmentFake();
    const { app, errors } = observed(fake);
    const server = app.listen(0);
    try {
      await hangUpAfter(server, 100);
      expect(await until(() => fake.db.attachments.length === 0 && filesUnder(root).length === 0)).toBe(true);
      await sleep(100); // let a late error handler call show up, if there were one
      expect(errors).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe("file names that are not ASCII, or are absurd", () => {
  it("keeps a UTF-8 name intact — stored, returned and offered for download", async () => {
    const fake = makeAttachmentFake();
    const name = "héllo wörld ☕ 報告.txt";
    const res = await request(makeApp(fake, ALICE))
      .post("/api/pm/work-items/wi-1/attachments")
      .attach("file", Buffer.from("x"), { filename: name, contentType: "text/plain" });
    expect(res.status).toBe(201);
    expect(res.body.attachment.fileName).toBe(name);

    const dl = await request(makeApp(fake, BOB)).get(`/api/pm/attachments/${res.body.attachment.id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
    // the plain fallback is ASCII-only, so the header is always a legal one
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=/);
  });

  it("truncates a 5,000-character name to 255 characters, keeping the extension, and stores the file", async () => {
    const fake = makeAttachmentFake();
    const res = await request(makeApp(fake, ALICE))
      .post("/api/pm/work-items/wi-1/attachments")
      .attach("file", Buffer.from("x"), { filename: `${"a".repeat(5000)}.txt`, contentType: "text/plain" });
    expect(res.status).toBe(201);
    expect(Array.from(res.body.attachment.fileName as string)).toHaveLength(255);
    expect(res.body.attachment.fileName.endsWith(".txt")).toBe(true);
  });

  it("a name with nothing in it (only dots) becomes 'file' rather than failing the upload", async () => {
    const fake = makeAttachmentFake();
    const res = await request(makeApp(fake, ALICE))
      .post("/api/pm/work-items/wi-1/attachments")
      .attach("file", Buffer.from("x"), { filename: "..", contentType: "text/plain" });
    expect(res.status).toBe(201);
    expect(res.body.attachment.fileName).toBe("file");
  });

  it("blocks a script whose name Windows would clean up to .bat", async () => {
    const fake = makeAttachmentFake();
    const res = await request(makeApp(fake, ALICE))
      .post("/api/pm/work-items/wi-1/attachments")
      .attach("file", Buffer.from("@echo off"), { filename: "run.bat. ", contentType: "text/plain" });
    expect(res.status).toBe(415);
    expect(res.body.error).toBe("attachment_type_blocked");
    expect(fake.db.attachments).toEqual([]);
    expect(filesUnder(root)).toEqual([]);
  });
});

// ── GET /api/pm/work-items/:id/attachments ───────────────────────────────────

describe("GET /api/pm/work-items/:id/attachments", () => {
  it("lists the READY attachments with the cap, and never the storage key", async () => {
    const fake = makeAttachmentFake();
    seedReady(fake, PDF, { id: "a", fileName: "a.pdf" });
    seedReady(fake, PDF, { id: "gone", status: "DELETED" });
    seedReady(fake, PDF, { id: "half", status: "UPLOADING" });

    const res = await request(makeApp(fake, BOB)).get("/api/pm/work-items/wi-1/attachments");

    expect(res.status).toBe(200);
    expect(res.body.limits).toEqual({ maxBytes: MAX });
    expect(res.body.attachments.map((a: Row) => a.id)).toEqual(["a"]);
    expect(JSON.stringify(res.body)).not.toContain("storageKey");
  });

  it("is open to every authenticated role that can read Projects", async () => {
    const fake = makeAttachmentFake();
    for (const user of [OWNER, ADMIN, ALICE, BOB]) {
      expect((await request(makeApp(fake, user)).get("/api/pm/work-items/wi-1/attachments")).status).toBe(200);
    }
  });

  it("404s an unknown work item", async () => {
    const res = await request(makeApp(makeAttachmentFake(), ALICE)).get("/api/pm/work-items/nope/attachments");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("work_item_not_found");
  });
});

// ── GET /api/pm/attachments/:id ──────────────────────────────────────────────

describe("GET /api/pm/attachments/:id", () => {
  it("serves the file as a download: octet-stream, attachment, nosniff, sandboxed", async () => {
    const fake = makeAttachmentFake();
    const row = seedReady(fake, PDF, { id: "a", fileName: "Q3 plan.pdf", mimeType: "application/pdf" });

    const res = await request(makeApp(fake, BOB)).get("/api/pm/attachments/a").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(PDF)).toBe(true);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="Q3 plan.pdf"; filename*=UTF-8''Q3%20plan.pdf`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["content-length"]).toBe(String(PDF.length));
    // a download is for saving, not for a browser cache to keep
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers.etag).toBeUndefined();
    expect(row.sha256).toBeTruthy();
  });

  it("serves a verified raster image inline ONLY when asked with ?inline=1", async () => {
    const fake = makeAttachmentFake();
    seedReady(fake, PNG, { id: "img", fileName: "shot.png", mimeType: "image/png" });
    const app = makeApp(fake, BOB);

    const inline = await request(app).get("/api/pm/attachments/img?inline=1");
    expect(inline.status).toBe(200);
    expect(inline.headers["content-type"]).toBe("image/png");
    expect(inline.headers["content-disposition"]).toMatch(/^inline; filename="shot.png"/);
    expect(inline.headers["x-content-type-options"]).toBe("nosniff");
    expect(inline.headers["content-security-policy"]).toBe("sandbox");
    // a thumbnail is revalidated, never trusted from a cache
    expect(inline.headers["cache-control"]).toBe("private, no-cache");
    expect(inline.headers.etag).toBeTruthy();

    // the default for the very same file is still a download
    const download = await request(app).get("/api/pm/attachments/img");
    expect(download.headers["content-type"]).toBe("application/octet-stream");
    expect(download.headers["content-disposition"]).toMatch(/^attachment; /);
  });

  it.each([
    ["a PDF", PDF, "application/pdf", "a.pdf"],
    ["an SVG", Buffer.from("<svg onload=alert(1)/>"), "application/octet-stream", "a.svg"],
    ["HTML", Buffer.from("<script>alert(1)</script>"), "application/octet-stream", "a.html"],
    ["text", Buffer.from("hello"), "text/plain", "a.txt"],
  ])("never serves %s inline, even when asked", async (_n, bytes, mimeType, fileName) => {
    const fake = makeAttachmentFake();
    seedReady(fake, bytes, { id: "x", fileName, mimeType });
    const res = await request(makeApp(fake, BOB)).get("/api/pm/attachments/x?inline=1");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; /);
  });

  it("does not trust a stored label: a row mislabelled image/svg+xml is still not inline", async () => {
    const fake = makeAttachmentFake();
    seedReady(fake, Buffer.from("<svg onload=alert(1)/>"), { id: "x", fileName: "a.svg", mimeType: "image/svg+xml" });
    const res = await request(makeApp(fake, BOB)).get("/api/pm/attachments/x?inline=1");
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; /);
  });

  it("keeps a hostile file name inside ONE Content-Disposition parameter", async () => {
    const fake = makeAttachmentFake();
    seedReady(fake, PDF, { id: "x", fileName: 'x"; filename=evil.exe; foo="' });
    const res = await request(makeApp(fake, BOB)).get("/api/pm/attachments/x");
    const header = res.headers["content-disposition"] as string;
    // Blank out the one quoted-string: what is left must be exactly the two
    // parameters we wrote — nothing the file name smuggled in is a parameter.
    expect(header.replace(/"[^"]*"/, '""')).toBe(
      "attachment; filename=\"\"; filename*=UTF-8''x%22%3B%20filename%3Devil.exe%3B%20foo%3D%22",
    );
  });

  it("revalidates an inline thumbnail: 304 with no body for the current digest — and still checks the row first", async () => {
    const fake = makeAttachmentFake();
    const row = seedReady(fake, PNG, { id: "a", fileName: "shot.png", mimeType: "image/png" });
    const app = makeApp(fake, BOB);
    const url = "/api/pm/attachments/a?inline=1";

    const fresh = await request(app).get(url).set("If-None-Match", `"${row.sha256}"`);
    expect(fresh.status).toBe(304);
    expect(fresh.text ?? "").toBe("");

    const stale = await request(app).get(url).set("If-None-Match", '"something-else"');
    expect(stale.status).toBe(200);

    // removed since: the validator buys nothing — the row check comes first
    row.status = "DELETED";
    const gone = await request(app).get(url).set("If-None-Match", `"${row.sha256}"`);
    expect(gone.status).toBe(404);
  });

  it("never answers 304 for a download — it is not cached to begin with", async () => {
    const fake = makeAttachmentFake();
    const row = seedReady(fake, PDF, { id: "a" });
    const res = await request(makeApp(fake, BOB)).get("/api/pm/attachments/a").set("If-None-Match", `"${row.sha256}"`);
    expect(res.status).toBe(200);
  });

  it("answers HEAD with the headers and no body", async () => {
    const fake = makeAttachmentFake();
    seedReady(fake, PDF, { id: "a" });
    const res = await request(makeApp(fake, BOB)).head("/api/pm/attachments/a");
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe(String(PDF.length));
    expect(res.text ?? "").toBe("");
  });

  it.each(["UPLOADING", "FAILED", "DELETED"])("404s an attachment that is %s", async (status) => {
    const fake = makeAttachmentFake();
    seedReady(fake, PDF, { id: "a", status });
    const res = await request(makeApp(fake, BOB)).get("/api/pm/attachments/a");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("attachment_not_found");
  });

  it("404s an unknown id", async () => {
    expect((await request(makeApp(makeAttachmentFake(), BOB)).get("/api/pm/attachments/nope")).status).toBe(404);
  });

  it("404s a READY row whose file is missing — a damaged store is 'gone', not a 500 or a half file", async () => {
    const fake = makeAttachmentFake();
    const row = seedReady(fake, PDF, { id: "a" });
    rmSync(blobPath(root, row.storageKey as string));
    const res = await request(makeApp(fake, BOB)).get("/api/pm/attachments/a");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("attachment_not_found");
  });

  it("404s a READY row whose file is not the size recorded", async () => {
    const fake = makeAttachmentFake();
    const row = seedReady(fake, PDF, { id: "a" });
    writeFileSync(blobPath(root, row.storageKey as string), PDF.subarray(0, 10));
    const res = await request(makeApp(fake, BOB)).get("/api/pm/attachments/a");
    expect(res.status).toBe(404);
  });

  it("refuses to follow a corrupted storage key out of the root", async () => {
    const fake = makeAttachmentFake();
    writeFileSync(join(parent, "secret"), "TOP SECRET");
    seedReady(fake, PDF, { id: "a", storageKey: "../secret" });
    const res = await request(makeApp(fake, BOB)).get("/api/pm/attachments/a");
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("TOP SECRET");
  });
});

// ── DELETE /api/pm/attachments/:id ───────────────────────────────────────────

describe("DELETE /api/pm/attachments/:id", () => {
  it("lets the uploader remove their file: row and blob gone, one attachment_removed row", async () => {
    const fake = makeAttachmentFake();
    const row = seedReady(fake, PDF, { id: "a", fileName: "plan.pdf", uploadedById: ALICE.id });

    const res = await request(makeApp(fake, ALICE)).delete("/api/pm/attachments/a");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: "a" });
    expect(fake.db.attachments).toEqual([]);
    expect(existsSync(blobPath(root, row.storageKey as string))).toBe(false);
    expect(fake.db.activity).toEqual([
      expect.objectContaining({ workItemId: "wi-1", actorId: ALICE.id, verb: "attachment_removed", oldValue: "plan.pdf" }),
    ]);
  });

  it.each([OWNER, ADMIN])("lets $role remove a file someone else uploaded", async (user) => {
    const fake = makeAttachmentFake();
    seedReady(fake, PDF, { id: "a", uploadedById: ALICE.id });
    expect((await request(makeApp(fake, user)).delete("/api/pm/attachments/a")).status).toBe(200);
  });

  it("refuses a member who is not the uploader — 403, the file is untouched", async () => {
    const fake = makeAttachmentFake();
    const row = seedReady(fake, PDF, { id: "a", uploadedById: ALICE.id });
    const res = await request(makeApp(fake, BOB)).delete("/api/pm/attachments/a");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("attachment_forbidden");
    expect(fake.db.attachments[0].status).toBe("READY");
    expect(existsSync(blobPath(root, row.storageKey as string))).toBe(true);
    expect(fake.db.activity).toEqual([]);
  });

  it.each([
    ["a guest", { id: "u-guest", role: "guest" }],
    ["a service principal", { id: "_service:voice", role: "service" }],
    ["nobody", null],
  ])("refuses %s with 403 from the role guard", async (_n, user) => {
    const fake = makeAttachmentFake();
    seedReady(fake, PDF, { id: "a", uploadedById: ALICE.id });
    const res = await request(makeApp(fake, user)).delete("/api/pm/attachments/a");
    expect(res.status).toBe(403);
    expect(fake.db.attachments[0].status).toBe("READY");
  });

  it.each(["UPLOADING", "FAILED", "DELETED"])("404s an attachment that is %s", async (status) => {
    const fake = makeAttachmentFake();
    seedReady(fake, PDF, { id: "a", status });
    expect((await request(makeApp(fake, OWNER)).delete("/api/pm/attachments/a")).status).toBe(404);
  });

  it("404s an unknown id", async () => {
    expect((await request(makeApp(makeAttachmentFake(), OWNER)).delete("/api/pm/attachments/nope")).status).toBe(404);
  });
});
