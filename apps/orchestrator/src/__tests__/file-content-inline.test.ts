/**
 * WARP-1920 — `GET /api/files/:id/content` may only render INERT types inline.
 *
 * The route serves stored files with `Content-Disposition: inline` from the
 * dashboard's own cookie-authenticated origin, and is reachable by top-level
 * navigation, so an `.html` / `.svg` served inline is a stored-XSS primitive
 * against the session. Both of its branches — brain-memory (local disk) and
 * Nextcloud (WebDAV) — are covered here.
 *
 * These are ROUTE tests on purpose. `lib/file-content.test.ts` pins the
 * safelist function itself; what can only be checked here is that the route
 * actually consults it, on both branches, and that the Range/206/416 contract
 * the media citation viewers depend on survived the change.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    MAX_UPLOAD_SIZE_MB: 100,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  invalidatePrefix: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("ncTokenStub"),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));

// The brain branch refuses a storagePath outside the caller's own tree. That
// ownership rule has its own coverage in files-brain.test.ts; here it is
// satisfied so the disposition logic under test is what the assertions see.
vi.mock("../services/brain-memory.service.js", () => ({
  isPathUnderUser: vi.fn().mockReturnValue(true),
}));

const ncFetchFileResponseMock = vi.fn();
vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/nextcloud.client.js")
  >("../services/nextcloud.client.js");
  return {
    ...actual,
    ncFetchFileResponse: (...args: unknown[]) => ncFetchFileResponseMock(...args),
  };
});

import { createFilesRouter } from "../routes/files.js";
import type { AuthUser } from "../middleware/auth.js";

const USER: AuthUser = {
  id: "user-1",
  username: "stefan",
  displayName: "Stefan",
  role: "owner",
};

const BODY = "hello from the citation route";

let dir: string;

/**
 * A brain item whose bytes really exist on disk, so `stat`/`createReadStream`
 * run for real rather than against an fs mock.
 *
 * `filename` and the on-disk name are deliberately independent — that is how
 * the row is actually shaped (`filename` is the uploader's display name,
 * `storagePath` is where the box put the bytes), and it lets a case use a
 * display name the host filesystem would reject, such as one containing `"`
 * on Windows.
 */
let seq = 0;
async function brainItem(filename: string, mimeType: string | null) {
  const storagePath = join(dir, `bytes-${seq++}`);
  await writeFile(storagePath, BODY);
  return {
    id: "item-1",
    userId: USER.id,
    filename,
    mimeType,
    storagePath,
  };
}

function buildApp(findUnique: () => unknown) {
  const prisma = {
    brainMemoryItem: { findUnique: vi.fn(async () => findUnique()) },
    fileContentChunk: { findFirst: vi.fn(async () => ({ path: ncPath })) },
  };
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = USER;
    next();
  });
  app.use("/api", createFilesRouter(prisma as never));
  return app;
}

let ncPath = "/Documents/report.pdf";

/**
 * Stand in for the WebDAV response the Nextcloud branch pipes through.
 *
 * Hand-rolled rather than built from `new Response(...)`: this suite runs in
 * vitest's node environment, where the fetch `Response` constructor is not
 * exposed. Only the three members the route touches are modelled — `.status`,
 * `.headers.get()`, and a web `.body` for `Readable.fromWeb`.
 */
function ncResponse(status = 200, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    body: Readable.toWeb(Readable.from([Buffer.from(BODY)])),
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "warp1920-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  ncPath = "/Documents/report.pdf";
});

// ── Brain-memory branch ───────────────────────────────────────────
describe("WARP-1920 — brain branch refuses to render script-capable files", () => {
  it("serves a .pdf inline, with nosniff + a sandbox CSP", async () => {
    const item = await brainItem("report.pdf", "application/pdf");
    const res = await request(buildApp(() => item)).get(`/api/files/${item.id}/content`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("sandbox");
  });

  it("DOWNLOADS a .html instead of rendering it", async () => {
    const item = await brainItem("evil.html", "text/html");
    const res = await request(buildApp(() => item)).get(`/api/files/${item.id}/content`);

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-disposition"]).not.toBe("inline");
    // The type must not be renderable as markup either — a browser that
    // ignored the disposition still must not be handed text/html.
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("DOWNLOADS a .svg instead of rendering it", async () => {
    const item = await brainItem("evil.svg", "image/svg+xml");
    const res = await request(buildApp(() => item)).get(`/api/files/${item.id}/content`);

    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
  });

  // THE vector this ticket adds over WARP-1919. `POST /files/brain` stores
  // `file.mimetype` — the multipart Content-Type the UPLOADING CLIENT chose —
  // and the route used to serve `item.mimeType ?? contentTypeForFilename(...)`.
  // So an inert-looking filename could still be rendered as markup, and no
  // extension safelist would ever have caught it.
  it("IGNORES an attacker-supplied stored mimeType (inert filename)", async () => {
    const item = await brainItem("notes.txt", "text/html");
    const res = await request(buildApp(() => item)).get(`/api/files/${item.id}/content`);

    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["content-type"]).not.toMatch(/html/);
    expect(res.headers["content-disposition"]).toBe("inline");
  });

  it("IGNORES an attacker-supplied stored mimeType (svg via a .png name)", async () => {
    const item = await brainItem("avatar.png", "image/svg+xml");
    const res = await request(buildApp(() => item)).get(`/api/files/${item.id}/content`);

    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-type"]).not.toMatch(/svg/);
  });

  // A hostile filename must not be able to add disposition parameters.
  it("neutralises quotes in an attachment filename", async () => {
    const item = await brainItem('a".xyz', null);
    const res = await request(buildApp(() => item)).get(`/api/files/${item.id}/content`);

    const cd = res.headers["content-disposition"];
    expect(cd).toMatch(/^attachment;/);
    // Exactly one quoted-string: the bare `"` was replaced, not passed through.
    expect(cd.match(/"/g)).toHaveLength(2);
    expect(cd).toContain("filename*=UTF-8''");
  });

  // ── The Range contract the media viewers depend on ──
  it("still answers a Range request with 206 + Content-Range", async () => {
    const item = await brainItem("clip.mp4", "video/mp4");
    const res = await request(buildApp(() => item))
      .get(`/api/files/${item.id}/content`)
      .set("Range", "bytes=0-4");

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-4/${BODY.length}`);
    expect(res.headers["content-length"]).toBe("5");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    // ...and the safelist headers are still on the partial response.
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["content-security-policy"]).toBe("sandbox");
  });

  it("still answers an unsatisfiable Range with 416", async () => {
    const item = await brainItem("clip2.mp4", "video/mp4");
    const res = await request(buildApp(() => item))
      .get(`/api/files/${item.id}/content`)
      .set("Range", `bytes=${BODY.length + 50}-`);

    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${BODY.length}`);
  });
});

// ── Nextcloud branch ──────────────────────────────────────────────
describe("WARP-1920 — Nextcloud branch refuses to render script-capable files", () => {
  it("serves a .pdf inline, with nosniff + a sandbox CSP", async () => {
    ncPath = "/Documents/report.pdf";
    ncFetchFileResponseMock.mockResolvedValue(ncResponse());
    const res = await request(buildApp(() => null)).get("/api/files/999/content");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("sandbox");
  });

  it("DOWNLOADS a .html instead of rendering it", async () => {
    ncPath = "/Documents/evil.html";
    ncFetchFileResponseMock.mockResolvedValue(ncResponse());
    const res = await request(buildApp(() => null)).get("/api/files/999/content");

    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
  });

  it("DOWNLOADS a .svg instead of rendering it", async () => {
    ncPath = "/Documents/evil.svg";
    ncFetchFileResponseMock.mockResolvedValue(ncResponse());
    const res = await request(buildApp(() => null)).get("/api/files/999/content");

    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
  });

  // The path-shaped id reaches the same branch without the chunk lookup.
  it("applies the safelist to a /-prefixed path id too", async () => {
    ncFetchFileResponseMock.mockResolvedValue(ncResponse());
    const res = await request(buildApp(() => null)).get(
      `/api/files/${encodeURIComponent("/Documents/evil.html")}/content`,
    );

    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
  });

  // WebDAV rules on the forwarded Range; the route must pass its verdict
  // through untouched.
  it("preserves WebDAV's 206 + Content-Range", async () => {
    ncPath = "/Documents/clip.mp4";
    ncFetchFileResponseMock.mockResolvedValue(
      ncResponse(206, {
        "content-range": "bytes 0-4/29",
        "accept-ranges": "bytes",
      }),
    );
    const res = await request(buildApp(() => null))
      .get("/api/files/999/content")
      .set("Range", "bytes=0-4");

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-4/29");
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["content-security-policy"]).toBe("sandbox");
    // The caller's Range really was forwarded upstream.
    expect(ncFetchFileResponseMock.mock.calls[0][3]).toBe("bytes=0-4");
  });
});
