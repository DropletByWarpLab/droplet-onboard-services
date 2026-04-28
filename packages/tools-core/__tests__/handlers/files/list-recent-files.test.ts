import { describe, it, expect, vi } from "vitest";
import listRecentFiles from "../../../src/handlers/files/list-recent-files.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(get: ReturnType<typeof vi.fn>, ncToken?: string): ToolContext {
  return {
    http: {
      nextcloud: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    userId: "alice",
    ncToken,
    signal: new AbortController().signal,
  };
}

describe("list_recent_files", () => {
  it("requires auth", async () => {
    const r = await listRecentFiles.handler({}, ctxWith(vi.fn(), ""));
    expect(r.ok).toBe(false);
  });

  it("calls /recent?limit=30 with token", async () => {
    const get = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    await listRecentFiles.handler({}, ctxWith(get, "tok"));
    expect(get).toHaveBeenCalledWith(
      "/recent?limit=30",
      expect.objectContaining({ headers: expect.objectContaining({ "X-Nextcloud-Token": "tok" }) }),
    );
  });
});
