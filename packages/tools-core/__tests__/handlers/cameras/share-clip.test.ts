import { describe, it, expect, vi } from "vitest";
import shareClip from "../../../src/handlers/cameras/share-clip.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(post: ReturnType<typeof vi.fn>, userId?: string): ToolContext {
  return {
    http: {
      cameras: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    userId,
    signal: new AbortController().signal,
  };
}

describe("share_clip", () => {
  it("requires auth", async () => {
    const r = await shareClip.handler({ nc_path: "/x.mp4" }, ctxWith(vi.fn(), undefined));
    expect(r.ok).toBe(false);
  });

  it("clamps ttl to [1, 1440] and posts to /clips/share", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "/api/cameras/clips/share/x.mp4?t=tok" }), { status: 200 }),
    );
    await shareClip.handler({ nc_path: "/x.mp4", ttl_minutes: 9999 }, ctxWith(post, "alice"));
    expect(post).toHaveBeenCalledWith(
      "/clips/share",
      { nc_path: "/x.mp4", ttl_minutes: 1440 },
      expect.anything(),
    );
  });
});
