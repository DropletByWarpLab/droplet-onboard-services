import { describe, it, expect, vi } from "vitest";
import scanForCameras from "../../../src/handlers/cameras/scan-for-cameras.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithPost(post: ReturnType<typeof vi.fn>): ToolContext {
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
    signal: new AbortController().signal,
  };
}

describe("scan_for_cameras", () => {
  it("requiresWrite is true", () => {
    expect(scanForCameras.requiresWrite).toBe(true);
  });

  it("posts to /scan and reports scan_started", async () => {
    const post = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const r = await scanForCameras.handler({}, ctxWithPost(post));
    expect(post).toHaveBeenCalledWith("/scan", undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ status: "scan_started" });
  });
});
