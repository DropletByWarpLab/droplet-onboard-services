/**
 * WARP-3691 — `show_file`: confirm a file is visible to THIS user and return a
 * `media` descriptor. Never fetches bytes.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import showFile from "../../../src/handlers/files/show-file.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(get: Mock, ncToken: string | undefined = "tok"): ToolContext {
  return {
    http: {
      nextcloud: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      orchestrator: {} as ToolContext["http"]["orchestrator"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    userId: "alice",
    ncToken,
    signal: new AbortController().signal,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const LISTING = [
  { name: "photo.jpg", path: "/Pics/photo.jpg", isDirectory: false, size: 2048, mimeType: "image/jpeg" },
  { name: "plan.pdf", path: "/Pics/plan.pdf", isDirectory: false, size: 99, mimeType: null },
  { name: "sub", path: "/Pics/sub", isDirectory: true, size: 0, mimeType: null },
];

describe("show_file", () => {
  it("is read-only and needs no confirmation", () => {
    expect(showFile.requiresWrite).toBe(false);
    expect(showFile.requiresConfirmation).toBe(false);
  });

  it("requires a Nextcloud session", async () => {
    const r = await showFile.handler({ path: "/a.png" }, ctxWith(vi.fn(), ""));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
  });

  it("requires exactly one of path / itemId", async () => {
    const get = vi.fn();
    for (const args of [{}, { path: "/a", itemId: "x" }]) {
      const r = await showFile.handler(args, ctxWith(get));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(get).not.toHaveBeenCalled();
  });

  it.each(["../etc/passwd", "/a/%2e%2e/b", "/a/\0b", "/Pics/%2e%2e%2fsecret"])(
    "rejects traversal %j before any request",
    async (bad) => {
      const get = vi.fn();
      const r = await showFile.handler({ path: bad }, ctxWith(get));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_PATH");
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("lists the PARENT dir with the caller's own headers and returns image media", async () => {
    const get = vi.fn().mockResolvedValue(json(LISTING));
    const r = await showFile.handler({ path: "/Pics/photo.jpg" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith(
      `/?path=${encodeURIComponent("/Pics")}`,
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Nextcloud-Token": "tok", "X-Nextcloud-User": "alice" }),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as { name: string; mimeType: string; size: number; media: Record<string, unknown> };
      expect(d).toMatchObject({ name: "photo.jpg", mimeType: "image/jpeg", size: 2048 });
      expect(d.media).toEqual({
        kind: "file",
        path: "/Pics/photo.jpg",
        name: "photo.jpg",
        mimeType: "image/jpeg",
        size: 2048,
        previewUrl: "/api/files/download?path=%2FPics%2Fphoto.jpg&disposition=inline",
        downloadUrl: "/api/files/download?path=%2FPics%2Fphoto.jpg",
        thumbnailUrl: "/api/files/thumbnail?path=%2FPics%2Fphoto.jpg&x=512&y=512",
      });
    }
  });

  it("infers the MIME type from the name when the listing has none; no thumbnail for non-images", async () => {
    const get = vi.fn().mockResolvedValue(json(LISTING));
    const r = await showFile.handler({ path: "/Pics/plan.pdf" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const m = (r.data as { media: { mimeType: string; thumbnailUrl?: string } }).media;
      expect(m.mimeType).toBe("application/pdf");
      expect(m.thumbnailUrl).toBeUndefined();
    }
  });

  it("lists '/' for a top-level file", async () => {
    const get = vi.fn().mockResolvedValue(json([{ name: "a.png", isDirectory: false, size: 1, mimeType: "image/png" }]));
    await showFile.handler({ path: "a.png" }, ctxWith(get));
    expect(get.mock.calls[0][0]).toBe(`/?path=${encodeURIComponent("/")}`);
  });

  it("fails NOT_FOUND for a file absent from the caller's listing (also covers files they cannot see)", async () => {
    const get = vi.fn().mockResolvedValue(json(LISTING));
    const r = await showFile.handler({ path: "/Pics/secret.jpg" }, ctxWith(get));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  it("fails NOT_FOUND when the parent folder 404s", async () => {
    const get = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    const r = await showFile.handler({ path: "/Nope/a.png" }, ctxWith(get));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  it("refuses a folder", async () => {
    const get = vi.fn().mockResolvedValue(json(LISTING));
    const r = await showFile.handler({ path: "/Pics/sub" }, ctxWith(get));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PATH");
  });

  it("reports an outage instead of NOT_FOUND", async () => {
    const get = vi.fn().mockResolvedValue(json([], 200, { "x-droplet-degraded": "1" }));
    const r = await showFile.handler({ path: "/Pics/photo.jpg" }, ctxWith(get));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("FILES_UNAVAILABLE");
  });

  it("surfaces other upstream failures", async () => {
    const get = vi.fn().mockResolvedValue(new Response("x", { status: 500 }));
    const r = await showFile.handler({ path: "/Pics/photo.jpg" }, ctxWith(get));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("OPEN_FAILED");
  });

  describe("itemId (chat attachment)", () => {
    it("reads the owner-only manifest and returns brain URLs", async () => {
      const get = vi.fn().mockResolvedValue(json({ filename: "scan.png", mimeType: "image/png", bytes: 5000 }));
      const r = await showFile.handler({ itemId: "cabc123" }, ctxWith(get));
      expect(get.mock.calls[0][0]).toBe("/brain/cabc123");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect((r.data as { media: unknown }).media).toEqual({
          kind: "file",
          itemId: "cabc123",
          name: "scan.png",
          mimeType: "image/png",
          size: 5000,
          previewUrl: "/api/files/brain/cabc123/download?disposition=inline",
          downloadUrl: "/api/files/brain/cabc123/download",
        });
      }
    });

    it("404 (someone else's item) is NOT_FOUND", async () => {
      const get = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
      const r = await showFile.handler({ itemId: "cabc123" }, ctxWith(get));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
    });

    it("rejects an id that could escape the URL path", async () => {
      const get = vi.fn();
      const r = await showFile.handler({ itemId: "../files/download" }, ctxWith(get));
      expect(r.ok).toBe(false);
      expect(get).not.toHaveBeenCalled();
    });
  });
});
